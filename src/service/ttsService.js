/**
 * TTS Service -- EventBus-driven text-to-speech client.
 *
 * Listens for "tts:speak" events on the EventBus and forwards them to a
 * remote tts-server API via HTTP POST. Fully decoupled: callers simply
 * emit events without importing or checking this service. If TTS_API_URL
 * is not defined in .env, the service silently does nothing during init.
 *
 * Locale-aware: loads per-locale TTS templates from etc/i18n/{locale}/tts.yaml
 * (model required, all other fields optional). Merges template defaults with
 * runtime event payload before sending the request.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Default fallback locale for TTS templates. */
const DEFAULT_LOCALE = 'pl_PL'

/** HTTP request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 5000

/** Event channel this service subscribes to. */
const SPEAK_CHANNEL = 'tts:speak'

// ---------------------------------------------------------------------------
// STtsService (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * Stateless, EventBus-driven TTS client.
 *
 * On init, checks for TTS_API_URL in environment. If present, loads the
 * locale-specific tts.yaml template and subscribes to "tts:speak" events.
 * Each event carries { text, output_endpoint?, intro?, outro?, intro_spacing? }
 * which is merged with the template (runtime values win) before posting to
 * the remote API.
 * ES module caching guarantees single instantiation.
 */
class STtsService {

    /** @type {string|null} */ #apiUrl = null
    /** @type {boolean} */     #enabled = false
    /** @type {Record<string, unknown>|null} */ #template = null
    /** @type {Function|null} */ #unsubscribe = null

    // -- Lifecycle --------------------------------------------------------

    /**
     * Initialize the TTS service. Call once during application startup.
     * If TTS_API_URL is not set, the service remains disabled -- no-op.
     * @async
     */
    async init() {
        const apiUrl = process.env.TTS_API_URL

        if (!apiUrl || !String(apiUrl).trim()) {
            LoggerService.debug('TTS: TTS_API_URL not set -- TTS disabled', 'TtsService')
            this.#enabled = false
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
    }

    // -- Public API -------------------------------------------------------

    /**
     * Check whether TTS is active and ready to speak.
     * @returns {boolean}
     */
    isEnabled() {
        return this.#enabled
    }

    /**
     * Synchronously speak text without going through EventBus.
     * Useful for one-off calls that need the result before continuing.
     * Internally checks #enabled -- silently returns false if disabled.
     *
     * @param {string} text - The text to synthesize.
     * @param {Object} [opts] - Optional overrides.
     * @param {string} [opts.outputEndpoint] - Override global output_endpoint.
     * @param {string} [opts.intro] - Wave filename played before the synthesized speech.
     * @param {string} [opts.outro] - Wave filename played after the synthesized speech.
     * @param {number} [opts.introSpacing] - Seconds between intro end and speech start; negative overlaps them.
     * @returns {Promise<boolean>} True if request was sent successfully.
     */
    async speak(text, opts = {}) {
        if (!this.#enabled || !this.#template) return false

        const payload = this.#buildPayload(text, opts)
        return this.#post(payload)
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Load the locale-specific tts.yaml template from etc/i18n/{locale}/tts.yaml.
     * Falls back to DEFAULT_LOCALE if the file does not exist or is invalid.
     * @async
     * @private
     */
    async #loadTemplate() {
        const locale = I18nLoader.getLanguage()
        // Resolve short code -> BCP 47 locale using I18nLoader's internal mapping
        // Since we don't expose it publicly yet, reconstruct the path:
        const localeDir = this.#resolveLocale(locale)
        const filePath  = path.join(I18N_ROOT, localeDir, 'tts.yaml')

        try {
            if (!fs.existsSync(filePath)) {
                LoggerService.warn(
                    `TTS template not found for '${locale}' (${filePath}) -- falling back to '${DEFAULT_LOCALE}'`,
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

    /**
     * Load the fallback tts.yaml from DEFAULT_LOCALE.
     * @private
     */
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

    /**
     * Resolve a short language code to its BCP 47 locale directory name.
     * Mirrors I18nLoader's LOCALE_MAP for forward compatibility.
     * @param {string} lang - Short language code (e.g., "pl")
     * @returns {string} Locale directory name (e.g., "pl_PL")
     * @private
     */
    #resolveLocale(lang) {
        const LOCALE_MAP = { pl: 'pl_PL', en: 'en_US' }
        return LOCALE_MAP[lang] || DEFAULT_LOCALE
    }

    /**
     * Subscribe to the EventBus speak channel.
     * @private
     */
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

    /**
     * Build the JSON payload for a TTS API request by merging template defaults
     * with runtime overrides. Only includes optional fields when they are defined;
     * for every optional field the runtime override wins over the tts.yaml default.
     *
     * Required fields in final payload: model, text, output_endpoint
     * Optional fields: triple_leading_consonant, piper_effects, sox_effects,
     * intro, outro, intro_spacing
     *
     * @param {string} text - The text to synthesize.
     * @param {Object} opts - Runtime options from caller.
     * @returns {Object} The complete JSON payload.
     * @private
     */
    #buildPayload(text, opts = {}) {
        const t = this.#template

        // Resolve output_endpoint with priority: per-call override > tts.yaml > .env (TTS_TCP_ENDPOINT)
        let outputEndpoint = opts.outputEndpoint || t.output_endpoint
        if (!outputEndpoint) {
            outputEndpoint = process.env.TTS_TCP_ENDPOINT
        }

        // Start with required fields
        const payload = {
            model:           t.model,
            text:            String(text),
            output_endpoint: outputEndpoint,
        }

        // Merge optional fields -- only include if explicitly set in template
        if (t.triple_leading_consonant != null) {
            payload.triple_leading_consonant = t.triple_leading_consonant
        }
        if (t.piper_effects != null) {
            payload.piper_effects = t.piper_effects
        }
        if (t.sox_effects != null) {
            payload.sox_effects = t.sox_effects
        }

        // Jingle framing + spacing: runtime event params override tts.yaml defaults,
        // which themselves stay unset unless a locale opts in globally.
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

    /**
     * Send a POST request to the TTS API endpoint.
     *
     * @param {Object} payload - The JSON body to send.
     * @returns {Promise<boolean>} True if the request completed without error.
     * @private
     */
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
                    // Consume response data to free up memory
                    res.resume()
                    res.on('end', () => {
                        const ok = res.statusCode >= 200 && res.statusCode < 300
                        if (!ok) {
                            LoggerService.warn(
                                `TTS API returned HTTP ${res.statusCode}`,
                                'TtsService'
                            )
                        }
                        resolve(ok)
                    })
                })

                req.on('error', (err) => {
                    LoggerService.error(`TTS request error: ${err.message}`, 'TtsService')
                    resolve(false)
                })

                req.on('timeout', () => {
                    req.destroy()
                    LoggerService.error('TTS request timed out', 'TtsService')
                    resolve(false)
                })

                req.write(body)
                req.end()
            } catch (error) {
                LoggerService.error(`TTS POST failed: ${error.message}`, 'TtsService')
                resolve(false)
            }
        })
    }

    /**
     * Gracefully unsubscribe from EventBus during shutdown.
     */
    cleanup() {
        if (this.#unsubscribe) {
            this.#unsubscribe()
            this.#unsubscribe = null
        }
        this.#enabled = false
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const TtsServiceInstance = Object.freeze(new STtsService())
export default TtsServiceInstance
