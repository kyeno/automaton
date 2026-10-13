/**
 * TTS Service -- EventBus-driven text-to-speech client.
 * Listens for "tts:speak" events on the EventBus and forwards them.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import https from 'node:https'
import http  from 'node:http'
import { URL } from 'node:url'
import fs    from 'node:fs'
import path  from 'node:path'
import { parseDocument as yamlParseDocument } from 'yaml'

import LoggerService from './loggerService.js'
import I18nLoader    from './i18nLoader.js'
import EventBus      from './eventBus.js'
import { PROJECT_ROOT } from '../lib/projectRoot.js'


/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Default fallback locale for TTS templates. */
const DEFAULT_LOCALE = 'pl_PL'

/** HTTP request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 5000

/** Cap on the response body kept for logging -- a rejection reason is a short JSON line. */
const RESPONSE_BODY_LIMIT = 400

/** Event channel this service subscribes to. */
const SPEAK_CHANNEL = 'tts:speak'

//  STtsService (module-level singleton)

/** Stateless, EventBus-driven TTS client. */
class STtsService {

    /** @type {string|null} */ #apiUrl = null
    /** @type {boolean} */     #enabled = false
    /** @type {Record<string, unknown>|null} */ #template = null
    /** @type {Function|null} */ #unsubscribe = null
    /** @type {boolean} */     #initialized = false

    //  -- Lifecycle --------------------------------------------------------

    /** Initialize the TTS service. Call once during application startup.
     * @async */
    async init() {
        const apiUrl = process.env.TTS_API_URL

        if (!apiUrl || !String(apiUrl).trim()) {
            LoggerService.debug('TTS: TTS_API_URL not set -- TTS disabled', 'TtsService')
            this.#enabled = false
            this.#initialized = true
            return
        }

        this.#apiUrl = String(apiUrl).trim()
        await this.#loadTemplate()

        if (this.#template) {
            this.#subscribe()
            this.#enabled = true
            LoggerService.info(
                `TTS enabled -- endpoint=${this.#apiUrl}, model=${this.#template.model}`,
                'TtsService'
            )
        } else {
            LoggerService.warn(
                'TTS: API URL set but no valid tts.yaml template found -- TTS disabled',
                'TtsService'
            )
        }

        this.#initialized = true
    }

    //  -- Public API -------------------------------------------------------

    /** Check whether TTS is active and ready to speak.
     * @returns {boolean} */
    isEnabled() {
        return this.#enabled
    }

    /** Check whether TTS has been configured via environment variables, regardless of init state.
     * @returns {boolean} True if TTS_API_URL is set and non-empty. */
    isConfigured() {
        return Boolean(process.env.TTS_API_URL && String(process.env.TTS_API_URL).trim())
    }

    /** Whether init() has completed at all (enabled or not) -- gate callers use before
     * @returns {boolean} */
    isReady() {
        return this.#initialized
    }

    /** Raw named framing profile from the active locale's tts.yaml `profiles:` registry.
     * @param {string} name - Profile name as written in `tts_profile:`
     * @returns {Record<string, unknown>|null} Raw profile entry, or null when undefined */
    getProfile(name) {
        const registry = this.#template?.profiles
        if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return null
        const wanted = String(name ?? '').trim().toLowerCase()
        if (!wanted) return null
        const key = Object.keys(registry).find((entry) => entry.toLowerCase() === wanted)
        return key ? registry[key] : null
    }

    /** Re-read locale-dependent TTS settings after a successful /config reload.
     * @async
     * @returns {Promise<{enabled:boolean, model:string|null, changed:boolean}>} Post-refresh state for caller reporting */
    async refreshConfig() {
        const apiUrl = process.env.TTS_API_URL
        if (!apiUrl || !String(apiUrl).trim()) {
            const hadState = Boolean(this.#enabled && this.#template)
            this.#enabled = false
            return { enabled: false, model: null, changed: hadState }
        }

        //  Force full re-resolution -- the locale directory may have changed since init().
        const before = JSON.stringify(this.#template ?? null)
        this.#template = null
        await this.#loadTemplate()

        if (this.#template && !this.#unsubscribe) {
            this.#subscribe()
            this.#enabled = true
        } else if (this.#template) {
            this.#enabled = true   // subscription persists -- only the payload defaults swapped
        } else {
            if (typeof this.#unsubscribe === 'function') {
                this.#unsubscribe()
                this.#unsubscribe = null
            }
            this.#enabled = false
        }

        LoggerService.info(
            `TTS config refreshed -- enabled=${this.#enabled}, model=${this.#template?.model ?? '(none)'}`,
            'TtsService'
        )
        return {
            enabled: this.#enabled,
            model:   this.#template?.model ?? null,
            changed: JSON.stringify(this.#template ?? null) !== before,
        }
    }

    /** Synchronously speak text without going through EventBus.
     * @param {string} text - The text to synthesize.
     * @param {Object} [opts] - Optional overrides.
     * @param {string} [opts.outputEndpoint] - Override global output_endpoint.
     * @param {string} [opts.intro] - Wave filename played before the synthesized speech.
     * @param {string} [opts.outro] - Wave filename played after the synthesized speech.
     * @param {number} [opts.introSpacing] - Seconds between intro end and speech start; negative overlaps them.
     * @returns {Promise<boolean>} True if request was sent successfully. */
    async speak(text, opts = {}) {
        if (!this.#enabled || !this.#template) return false

        const payload = this.#buildPayload(text, opts)
        let result = await this.#post(payload)
        if (result.ok) return true

        //  A jingle the server does not have makes it reject the WHOLE request, which would
        //  silence the announcement itself. Drop the framing and say the words plainly -- the
        //  sentence matters more than the tune, and the warning below names the missing file.
        if (payload.intro || payload.outro) {
            LoggerService.warn(
                `TTS: request rejected (${result.detail || `HTTP ${result.status}`}) -- retrying without framing`,
                'TtsService'
            )
            delete payload.intro
            delete payload.outro
            delete payload.intro_spacing
            result = await this.#post(payload)
        }

        return result.ok
    }

    //  -- Private Helpers --------------------------------------------------

    /** Load the locale-specific tts.yaml template from etc/i18n/{locale}/tts.yaml.
     * @async
     * @private */
    async #loadTemplate() {
        const localeDir = I18nLoader.getLocale()
        const filePath  = path.join(I18N_ROOT, localeDir, 'tts.yaml')

        try {
            if (!fs.existsSync(filePath)) {
                LoggerService.warn(
                    `TTS template not found for '${localeDir}' (${filePath}) -- falling back to '${DEFAULT_LOCALE}'`,
                    'TtsService'
                )
                return this.#loadFallbackTemplate()
            }

            const doc   = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            const data  = doc.contents?.toJSON()

            if (!data || typeof data !== 'object' || !data.model) {
                LoggerService.error(
                    `TTS template missing required "model" field in ${filePath}`,
                    'TtsService'
                )
                return this.#loadFallbackTemplate()
            }

            this.#template = data
            LoggerService.debug(`TTS template loaded: model='${data.model}'`, 'TtsService')
        } catch (error) {
            LoggerService.error(
                `Failed to load TTS template: ${error.message}`,
                'TtsService'
            )
            this.#loadFallbackTemplate()
        }
    }

    /** Load the fallback tts.yaml from DEFAULT_LOCALE.
     * @private */
    #loadFallbackTemplate() {
        try {
            const filePath = path.join(I18N_ROOT, DEFAULT_LOCALE, 'tts.yaml')
            const doc      = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            const data     = doc.contents?.toJSON()

            if (data && typeof data === 'object' && data.model) {
                this.#template = data
                LoggerService.warn(
                    `TTS using fallback template from '${DEFAULT_LOCALE}': model='${data.model}'`,
                    'TtsService'
                )
            }
        } catch (error) {
            LoggerService.error(`TTS fallback template also failed: ${error.message}`, 'TtsService')
        }
    }


    /** Subscribe to the EventBus speak channel.
     * @private */
    #subscribe() {
        this.#unsubscribe = EventBus.subscribe(SPEAK_CHANNEL, async (payload) => {
            if (!this.#enabled || !this.#template) return

            if (!payload || typeof payload !== 'object' || !payload.text) {
                LoggerService.warn('TTS: invalid event payload -- expected { text, ... }', 'TtsService')
                return
            }

            try {
                const success = await this.speak(payload.text, {
                    outputEndpoint: payload.output_endpoint,
                    intro:        payload.intro,
                    outro:        payload.outro,
                    introSpacing: payload.intro_spacing
                })
                if (!success) {
                    LoggerService.debug('TTS: request failed or was skipped', 'TtsService')
                }
            } catch (error) {
                LoggerService.error(`TTS speak error: ${error.message}`, 'TtsService')
            }
        })
    }

    /** Build the JSON payload for a TTS API request by merging template defaults.
     * @param {string} text - The text to synthesize.
     * @param {Object} opts - Runtime options from caller.
     * @returns {Object} The complete JSON payload.
     * @private */
    #buildPayload(text, opts = {}) {
        const t = this.#template

        //  Resolve output_endpoint with priority: per-call override > tts.yaml > .env (TTS_TCP_ENDPOINT)
        let outputEndpoint = opts.outputEndpoint || t.output_endpoint
        if (!outputEndpoint) {
            outputEndpoint = process.env.TTS_TCP_ENDPOINT
        }

        //  Start with required fields.
        const payload = {
            model:           t.model,
            text:            String(text),
            output_endpoint: outputEndpoint,
        }

        //  Merge optional fields -- only include if explicitly set in template.
        if (t.triple_leading_consonant != null) {
            payload.triple_leading_consonant = t.triple_leading_consonant
        }
        if (t.piper_effects != null) {
            payload.piper_effects = t.piper_effects
        }
        if (t.sox_effects != null) {
            payload.sox_effects = t.sox_effects
        }

        //  Jingle framing + spacing: runtime event params override tts.yaml defaults.
        const intro  = opts.intro ?? t.intro
        if (typeof intro === 'string' && intro.trim()) {
            payload.intro = intro.trim()
        }
        const outro  = opts.outro ?? t.outro
        if (typeof outro === 'string' && outro.trim()) {
            payload.outro = outro.trim()
        }
        const spacing = opts.introSpacing ?? t.intro_spacing
        if (typeof spacing === 'number' && Number.isFinite(spacing)) {
            payload.intro_spacing = spacing
        }

        return payload
    }

    /** Send a POST request to the TTS API endpoint.
     * @param {Object} payload - The JSON body to send.
     * @returns {Promise<{ok:boolean, status:number, detail:string}>} ok is true when the server
     *          accepted the request; detail carries the server's own rejection reason.
     * @private */
    #post(payload) {
        return new Promise((resolve) => {
            try {
                const parsedUrl   = new URL(this.#apiUrl)
                const isHttps     = parsedUrl.protocol === 'https:'
                const transport   = isHttps ? https : http
                const body        = JSON.stringify(payload)

                const options = {
                    hostname: parsedUrl.hostname,
                    port:     parsedUrl.port || (isHttps ? 443 : 80),
                    path:     parsedUrl.pathname + parsedUrl.search,
                    method:   'POST',
                    timeout:  REQUEST_TIMEOUT_MS,
                    headers: {
                        'Content-Type':  'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                }

                const req = transport.request(options, (res) => {
                    //  Keep a bounded slice of the body -- on rejection it names the reason.
                    let raw = ''
                    res.setEncoding('utf8')
                    res.on('data', (chunk) => {
                        if (raw.length < RESPONSE_BODY_LIMIT) {
                            raw += chunk.slice(0, RESPONSE_BODY_LIMIT - raw.length)
                        }
                    })
                    res.on('end', () => {
                        const ok     = res.statusCode >= 200 && res.statusCode < 300
                        const detail = this.#extractDetail(raw)
                        if (!ok) {
                            LoggerService.warn(
                                `TTS API returned HTTP ${res.statusCode}${detail ? ` -- ${detail}` : ''}`,
                                'TtsService'
                            )
                        }
                        resolve({ ok, status: res.statusCode, detail })
                    })
                })

                req.on('error', (err) => {
                    LoggerService.error(`TTS request error: ${err.message}`, 'TtsService')
                    resolve({ ok: false, status: 0, detail: err.message })
                })

                req.on('timeout', () => {
                    req.destroy()
                    LoggerService.error('TTS request timed out', 'TtsService')
                    resolve({ ok: false, status: 0, detail: 'request timed out' })
                })

                req.write(body)
                req.end()
            } catch (error) {
                LoggerService.error(`TTS POST failed: ${error.message}`, 'TtsService')
                resolve({ ok: false, status: 0, detail: error.message })
            }
        })
    }

    /** Pull the server's own explanation out of a response body.
     * @param {string} raw - Raw response body, possibly empty and possibly JSON.
     * @returns {string} Short human-readable reason; '' when the body says nothing.
     * @private */
    #extractDetail(raw) {
        const text = String(raw ?? '').trim()
        if (!text) return ''

        try {
            const data   = JSON.parse(text)
            const reason = data?.detail ?? data?.error ?? data?.message
            if (typeof reason === 'string' && reason.trim()) return reason.trim()
        } catch (_) {
            //  Not JSON -- the plain body is the best explanation available.
        }

        return text
    }

    /** Gracefully unsubscribe from EventBus during shutdown. */
    cleanup() {
        if (this.#unsubscribe) {
            this.#unsubscribe()
            this.#unsubscribe = null
        }
        this.#enabled = false
    }
}

//  Module-level singleton -- ES module caching guarantees single instantiation.
const TtsServiceInstance = Object.freeze(new STtsService())
export default TtsServiceInstance
