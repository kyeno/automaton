/**
 * TTS Greeter Automation.
 * Greets people when their computers come back online.
 * how long the host was absent -- measured from the transition history.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument as yamlParseDocument } from 'yaml'

import RuleBasedAutomationBase from '../../src/automation/base/ruleBasedAutomationBase.js'
import AiAssistant from '../../src/ai/aiAssistant.js'
import ChatMessageOrigin from '../../src/enum/aiChatMessageOrigin.js'
import DatabaseService from '../../src/service/databaseService.js'
import EventBus from '../../src/service/eventBus.js'
import I18nLoader from '../../src/service/i18nLoader.js'
import TtsService from '../../src/service/ttsService.js'
import TtsProfiles from '../../src/lib/ttsProfiles.js'
import temporal from '../../src/lib/date.js'
import { PROJECT_ROOT } from '../../src/lib/projectRoot.js'


/** Path to this automation's YAML config file. */
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-greeter.yaml')

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Domain under which NetworkPresence records host transitions. */
const NETWORK_DOMAIN = 'network'

/** Bucket spoken when the absence duration cannot be determined. */
const UNKNOWN_ABSENCE_BUCKET = 'welcome'

/** Absence boundary in ms: below it the note is relative ("last seen online X ago"); */
const ABSENCE_NOTE_LONG_MIN_MS = 24 * 3_600_000

export default class TtsGreeterAutomation extends RuleBasedAutomationBase {

    /** @type {Record<string, unknown>|null} Cached greeter i18n bundle; reloaded on every run. */
    #bundle = null

    //  -- Construction & lifecycle ------------------------------------------

    /** Construct the greeter from its YAML config file located next to this script. */
    constructor() {
        super({ name: 'TtsGreeterAutomation', configPath: CONFIG_PATH })
    }

    /** Lifecycle hook -- loads the greeter i18n bundle once on top of the base init; */
    async init() {
        await super.init()
        this.#bundle = this.#loadBundle()
    }

    //  -- Public API ----------------------------------------------------------

    /** Custom execute flow: evaluate each candidate host and greet it when its absence
     * @param {{trigger?: string, force?: boolean}|null} [triggerData] - Trigger info; */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        this.log(`Triggered by: ${triggerSource}`, 'info')

        //  Off-guard: if neither the AI pipeline nor the TTS server is available there.
        if (!AiAssistant.isAvailable() && !TtsService.isEnabled()) {
            this.log('Both AI and TTS unavailable -- skipping greeter run', 'debug')
            return
        }

        //  Suppress execution during a configured silent period (before any work begins)
        if (this.isInSilentPeriod()) {
            if (triggerData?.force === true) {
                this.log(`Forced run -- silent period bypassed (${triggerSource})`, 'info')
            } else {
                this.log(`Suppressed during silent period (${triggerSource})`, 'debug')
                return
            }
        }

        //  Reload bundle fresh each run (interpolation is runtime, not cached).
        this.#bundle = this.#loadBundle()
        if (!this.#bundle) {
            this.log('No greeter i18n bundle loaded, skipping', 'warn')
            return
        }

        for (const host of this.#candidateHosts(triggerSource)) {
            try {
                await this.runWithAiGuard(
                    this.config?.use_ai === true && AiAssistant.isAvailable(),
                    () => this.#greetIfDue(host),
                    host
                )
            } catch (error) {
                this.log(`Greeting evaluation failed for "${host}": ${error.message}`, 'error')
            }
        }
    }

    /** No device targets for this automation -- returns empty Map so the parent's flow
     * @returns {Map<string, never>} Empty map */
    loadDevices() {
        return new Map()
    }

    /** Not used by ttsGreeter (no device commands). Required abstract method kept.
     * @param {*} _device - Unused in this override (kept for signature parity)
     * @param {string} _targetKey - Unused in this override
     * @returns {null} Always null */
    resolveCommand(_device, _targetKey) {
        return null
    }

    /** Decide whether a host should be greeted right now and with which bucket.
     * @param {string} host - Configured network host name
     * @returns {Promise<{action: 'speak', bucket: string, absenceMs: number|null}|{action: 'skip', reason: string}>} */
    async greetDecisionFor(host) {
        const current = await DatabaseService.getCurrent(NETWORK_DOMAIN, host)
        if (current !== 'online') {
            return { action: 'skip', reason: current == null ? 'no presence recorded yet' : `host is ${current}, not online` }
        }

        const absenceMs = await DatabaseService.priorStateDurationMs(NETWORK_DOMAIN, host)
        if (absenceMs == null) {
            this.log(`No prior transition recorded for "${host}" -- assuming a long absence`, 'debug')
            return { action: 'speak', bucket: UNKNOWN_ABSENCE_BUCKET, absenceMs: null }
        }

        for (const win of this.#windows()) {
            if ((win.minMs == null || absenceMs >= win.minMs) && (win.maxMs == null || absenceMs <= win.maxMs)) {
                return { action: 'speak', bucket: win.bucket, absenceMs }
            }
        }
        return { action: 'skip', reason: `absence of ${Math.round(absenceMs / 1000)}s matches no greeting window` }
    }

    /** Send one greeting through the AI -> TTS pipeline with graceful degradation.
     * @param {string} aiInstruction - Full instruction sent to the model
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} [ttsOptions={}] - Framing forwarded to the model's own speech
     * @returns {Promise<boolean>} true when the AI voiced the greeting, false on fallback */
    async routeThroughAi(aiInstruction, ttsOptions = {}) {
        let spoken = ''
        try {
            const response = await AiAssistant.processMessage(aiInstruction, { origin: ChatMessageOrigin.SYSTEM, tts: ttsOptions })
            spoken = typeof response === 'string' ? response.trim() : ''
        } catch (error) {
            this.log(`AI processing failed: ${error.message}`, 'warn')
            return false
        }

        if (!spoken) {
            this.log('AI reply was empty -- falling back to direct TTS', 'warn')
            return false
        }

        //  Emit the AI's response back to UI for rendering with <AI> prefix.
        if (EventBus.hasSubscribers('ai:periodicResponse')) {
            EventBus.emit('ai:periodicResponse', { text: spoken })
        }
        this.log(`Greeting sent via AI -> TTS pipeline (${spoken.length} chars)`, 'debug')
        return true
    }

    //  -- Greeting flow -------------------------------------------------------

    /** Evaluate one host end-to-end and deliver when due; logs the decision either way.
     * @private
     * @param {string} host - Configured network host name */
    async #greetIfDue(host) {
        const decision = await this.greetDecisionFor(host)
        if (decision.action === 'skip') {
            this.log(`No greeting for "${host}" (${decision.reason})`, 'debug')
            return
        }
        const absenceLabel = decision.absenceMs == null ? 'unknown' : `${Math.round(decision.absenceMs / 1000)}s`
        this.log(`Greeting "${host}" with bucket "${decision.bucket}" (absence ${absenceLabel})`, 'info')
        await this.#deliver(host, decision)
    }

    /** Deliver one decided greeting through the configured output path.
     * @private
     * @param {string} host - Host key under names/
     * @param {{bucket: string}} decision - Decision from greetDecisionFor() */
    async #deliver(host, decision) {
        const section = this.#bundle?.[decision.bucket]
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
            this.log(`Greeting bucket "${decision.bucket}" not found in active bundle -- check greeting_windows`, 'warn')
            return
        }
        if (!this.#hasLine(section, 'tts', host) && !this.#hasLine(section, 'ai', host)) {
            //  Deliberate per-host opt-out (e.g., a shared HTPC only needs some buckets):
            this.log(`No greeting configured for "${host}" in bucket "${decision.bucket}" -- treating as not required`, 'debug')
            return
        }

        const plainText = this.#sentence(decision.bucket, 'tts', host)
        if (!plainText) {
            this.log(`No TTS sentence for "${decision.bucket}.tts.${host}" in active bundle -- skipping`, 'warn')
            return
        }

        //  Framing (intro/outro/spacing) resolved once per greeting from this automation's.
        const ttsOptions = TtsProfiles.resolve(this.config, (message) => this.log(message, 'warn'))

        if (this.config.use_ai === true && AiAssistant.isAvailable()) {
            let instruction = this.#sentence(decision.bucket, 'ai', host)
            if (!instruction) {
                this.log(`No AI instruction for "${decision.bucket}.ai.${host}" -- speaking the plain TTS sentence instead`, 'warn')
            } else {
                //  Ask the model to include the absence note too when history provides one.
                const aiNote = await this.#absenceNote(host, 'ai', decision)
                if (aiNote) instruction = `${instruction} ${aiNote}`
                //  Emit system input to UI with exactly what goes to the model.
                if (EventBus.hasSubscribers('ai:systemMessage')) {
                    EventBus.emit('ai:systemMessage', { text: instruction })
                }
                if (await this.routeThroughAi(instruction, ttsOptions)) return
                //  routeThroughAi already logged why.
            }
        } else if (this.config.use_ai === true) {
            this.log('use_ai enabled but AI unavailable -- speaking the plain TTS sentence instead', 'warn')
        }

        //  Append the localized absence note when history provides a duration;
        const ttsNote = await this.#absenceNote(host, 'tts', decision)
        const spoken = ttsNote ? `${plainText} ${ttsNote}` : plainText
        TtsProfiles.speak(spoken, ttsOptions)
        this.log(`Greeting for "${host}" (${decision.bucket}) sent via direct TTS`, 'debug')
    }

    //  -- Config & bundle helpers ---------------------------------------------

    /** Hosts to evaluate on a given trigger. Event runs are scoped to their own host;
     * @private
     * @param {string} triggerSource - Trigger identifier from execute()
     * @returns {string[]} Candidate hosts (may be empty) */
    #candidateHosts(triggerSource) {
        const configured = this.#configuredHosts()
        if (/^network:.+$/.test(String(triggerSource ?? ''))) {
            const host = String(triggerSource).slice('network:'.length)
            if (configured.includes(host)) return [host]
            this.log(`Event for unconfigured host "${host}" -- ignoring`, 'debug')
            return []
        }
        return configured
    }

    /** Normalized list of hosts from config.triggers_network (array or single string);
     * @private
     * @returns {string[]} Host names */
    #configuredHosts() {
        const raw = this.config?.triggers_network
        if (Array.isArray(raw)) return raw.map((h) => String(h)).filter(Boolean)
        if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
        return []
    }

    /** Parsed greeting windows in YAML order (top-down, first match wins)
     * @private
     * @returns {Array<{name: string, minMs: number|null, maxMs: number|null, bucket: string}>} Usable windows */
    #windows() {
        const out = []
        const raw = this.config?.greeting_windows
        if (!Array.isArray(raw)) return out
        raw.forEach((win, index) => {
            if (!win || typeof win !== 'object') {
                this.log(`greeting_windows[${index}] is not an object -- skipping`, 'warn')
                return
            }
            const bounds = (win.absent_for && typeof win.absent_for === 'object') ? win.absent_for : {}
            const minMs = this.#parseBound(bounds.gte ?? bounds.min, `greeting_windows[${index}].absent_for.gte`)
            const maxMs = this.#parseBound(bounds.lte ?? bounds.max, `greeting_windows[${index}].absent_for.lte`)
            const bucket = typeof win.sentence === 'string' && win.sentence.trim() ? win.sentence.trim() : null
            if (!bucket) {
                this.log(`greeting_windows[${index}] has no "sentence" bucket -- skipping`, 'warn')
                return
            }
            out.push({ name: String(win.name ?? `window-${index + 1}`), minMs, maxMs, bucket })
        })
        return out
    }

    /** Resolve one window bound via temporal.parseDurationMs(); absent values are.
     * @private
     * @param {*} raw - Raw config value ("5s", "7m", "4h", plain ms, or omitted)
     * @param {string} label - Config path used in warning messages
     * @returns {number|null} Bound in milliseconds, or null for an unbounded side */
    #parseBound(raw, label) {
        if (raw == null || raw === '') return null
        const ms = temporal.parseDurationMs(raw)
        if (ms != null && Number.isFinite(ms) && ms >= 0) return Math.round(ms)
        this.log(`${label}: ${JSON.stringify(raw)} is not a valid duration ("5s", "7m", "4h") or milliseconds -- treating as unbounded`, 'warn')
        return null
    }

    /** Load the greeter i18n bundle for the active locale; null when missing/unreadable.
     * @private
     * @returns {Record<string, unknown>|null} Parsed bundle object */
    #loadBundle() {
        try {
            const localeDir = I18nLoader.getLocale()
            const filePath = path.join(I18N_ROOT, localeDir, 'greeter.yaml')
            if (!fs.existsSync(filePath)) return null
            const doc = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            return doc.contents?.toJSON() ?? null
        } catch (error) {
            this.log(`Failed to load greeter bundle: ${error.message}`, 'warn')
            return null
        }
    }

    /** Fill {% token %} placeholders in a raw template from a flat token map.
     * @private
     * @param {string} template - Raw YAML template line
     * @param {Record<string, unknown>} tokens - Token name to replacement string
     * @param {string} label - Bundle path used in warning messages
     * @returns {string} Interpolated text, or '' when unresolvable */
    #fillTemplate(template, tokens, label) {
        let unresolved = false
        const text = String(template).replace(/\{%\s*([a-z_]+)\s*%}/g, (_match, key) => {
            const value = tokens?.[key]
            if (typeof value === 'string' && value.trim() !== '') return value
            unresolved = true
            return _match
        })
        if (unresolved) {
            this.log(`Sentence "${label}" has an unresolvable placeholder -- check the active i18n bundle`, 'warn')
            return ''
        }
        return text
    }

    /** Resolve one sentence template (bucket + output channel + host) with name-case.
     * @private
     * @param {string} bucket - Bundle section, e.g., 'welcome' | 'forgot' | 'reboot'
     * @param {'tts'|'ai'} channel - Output-path section inside the bucket
     * @param {string} host - Host key under names/
     * @returns {string} Interpolated text, or '' when unresolvable */
    #sentence(bucket, channel, host) {
        const template = this.#bundle?.[bucket]?.[channel]?.[host]
        if (typeof template !== 'string' || !template.trim()) return ''
        const namesHost = (this.#bundle.names && typeof this.#bundle.names === 'object') ? this.#bundle.names[host] : undefined
        const names = (namesHost && typeof namesHost === 'object') ? namesHost : {}
        return this.#fillTemplate(template, {
            name_vocative: typeof names.vocative === 'string' ? names.vocative : '',
            name_genitive: typeof names.genitive === 'string' ? names.genitive : '',
        }, `${bucket}.${channel}.${host}`)
    }

    /** Whether a non-empty template line exists for one output channel of a bucket+host.
     * @private
     * @param {{tts?: Record<string, unknown>, ai?: Record<string, unknown>}} section - Parsed bundle bucket section
     * @param {'tts'|'ai'} channel - Output-path key inside the section
     * @param {string} host - Host name
     * @returns {boolean} true when a usable string line is present */
    #hasLine(section, channel, host) {
        const value = section?.[channel]?.[host]
        return typeof value === 'string' && value.trim() !== ''
    }

    /** Whether the host's canonical welcome TTS line addresses them by name.
     * @private
     * @param {string} host - Host key under names/
     * @returns {boolean} true when the welcome TTS line uses a name placeholder */
    #greetingUsesName(host) {
        const line = this.#bundle?.welcome?.tts?.[host]
        return typeof line === 'string' && /\{%\s*name_(?:vocative|genitive)\s*%\}/.test(line)
    }

    /** Build the localized absence note appended after the bucket greeting, or '' to omit.
     * @private
     * @param {string} host - Configured network host name
     * @param {'tts'|'ai'} channel - Output-path section inside absence_note/
     * @param {{bucket: string, absenceMs: number|null}} decision - Decision record from greetDecisionFor()
     * @returns {Promise<string>} Interpolated note without leading separator, or '' to omit */
    async #absenceNote(host, channel, decision) {
        if (!Number.isFinite(decision?.absenceMs) || !(decision.absenceMs > 0)) return ''
        const section = this.#bundle?.absence_note?.[channel]
        if (!section || typeof section !== 'object') return ''

        //  Relative ("... X temu") below the boundary; absolute date + time at/above it.
        const variant = decision.absenceMs >= ABSENCE_NOTE_LONG_MIN_MS ? 'long' : 'recent'

        const pick = (key) => (typeof section[key] === 'string' && String(section[key]).trim()) ? section[key] : null
        const resolveTemplate = (v) => (channel === 'tts')
            //  The possessive form ("Twój komputer ...") only fits a greeting.
            ? pick(`${v}_${this.#greetingUsesName(host) ? 'named' : 'anonymous'}`) ?? pick(v)
            : pick(v)

        //  Bundles predating the recent tier keep their "off for ..." short_* lines.
        const candidates = variant === 'recent' ? ['recent', 'short'] : [variant]
        let template = null
        let usedVariant = variant
        for (const v of candidates) {
            template = resolveTemplate(v)
            if (template) { usedVariant = v; break }
        }
        if (!template) return ''   // bundle predates the note feature -- plain greeting only

        let tokens
        if (usedVariant === 'long') {
            //  The offline transition's own timestamp.
            const offlineTs = await DatabaseService.priorTransitionTs(NETWORK_DOMAIN, host) ?? Math.max(0, Date.now() - decision.absenceMs)
            const moment = new Date(offlineTs)
            const dateTemplate = temporal.loadDateBundle()?.date_sentence
            const fragment = (typeof dateTemplate === 'string' && dateTemplate.trim())
                ? this.#fillTemplate(dateTemplate, temporal.getDateParts(moment), `absence_note.${channel}.${usedVariant} date`)
                : ''
            if (!fragment) {
                this.log('No localized calendar date available -- skipping the last-online note', 'warn')
                return ''
            }
            tokens = { last_online_date: fragment, last_online_time: temporal.formatClockTime(moment) }
        } else {
            const phrase = temporal.msToHumanPhrase(decision.absenceMs, temporal.getDurationUnits())
            if (!phrase) {
                this.log(`Cannot render a duration phrase for ${Math.round(decision.absenceMs / 1000)}s -- skipping the absence note`, 'debug')
                return ''
            }
            tokens = { time_phrase: phrase }
        }

        return this.#fillTemplate(template, tokens, `absence_note.${channel}.${usedVariant}`)
    }
}
