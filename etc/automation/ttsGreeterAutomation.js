/**
 * TTS Greeter Automation.
 * Greets people when their computers come back online, with the message chosen by
 * how long the host was absent -- measured from the transition history via
 * DatabaseService.priorStateDurationMs() (the interval between the host's two most
 * recent transitions, i.e., how long it sat OFFLINE before this return event). A
 * quick reboot therefore never triggers a full welcome; absence windows are pure
 * config data (greeting_windows) so new "funny" conditions cost zero code.
 *
 * Output routing is a precise boolean switch (config.use_ai), unlike WeatherMan which
 * always routes through AI when available:
 *   use_ai false -> speak the bucket's tts.<host> sentence directly (default);
 *   use_ai true  + AI available -> send the bucket's ai.<host> instruction to the model,
 *                   which speaks its own greeting (AiAssistant fires 'tts:speak' for it);
 *   use_ai true  + AI down/empty/error -> warn in logs and speak the plain TTS sentence
 *                   instead. There is deliberately NO spoken fallback notice here -- a
 *                   missed greeting must not be announced twice.
 *
 * Sentences live in the per-locale greeter bundle (etc/i18n/<locale>/greeter.yaml):
 * each bucket holds per-host lines split by output path (tts/ai), with names filled
 * from names.<host> via {% name_vocative %} / {% name_genitive %} placeholders so each
 * template picks the grammatical case it needs. A host that has no line in a given
 * bucket on either channel simply does not require a greeting there (e.g., a shared HTPC)
 * and those returns skip silently instead of warning. When transition history provides
 * an absence duration, a localized note is appended after the greeting: below 24h it says
 * how long ago the host was last seen online ("...8 hours ago"), from 24h up it gives the
 * full calendar date plus clock time of the offline transition itself. Both render via
 * lib/date's date/time machinery and degrade silently when data or templates are missing.
 * TTS notes ship as _named/_anonymous pairs: the possessive form ("Twój komputer ...") is
 * spoken only when the host's welcome TTS line addresses them by name.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
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
import temporal from '../../src/lib/date.js'
import { PROJECT_ROOT } from '../../src/lib/projectRoot.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to this automation's YAML config file. */
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-greeter.yaml')

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Domain under which NetworkPresence records host transitions. */
const NETWORK_DOMAIN = 'network'

/**
 * Bucket spoken when the absence duration cannot be determined (no prior transition
 * recorded for the host -- fresh install, pruned history). Fails open with a full
 * welcome: one extra greeting beats a silent homecoming.
 */
const UNKNOWN_ABSENCE_BUCKET = 'welcome'

/**
 * Absence boundary in ms: below it the note is relative ("last seen online X ago");
 * at/above it, absolute -- full calendar date + clock time of the offline moment.
 */
const ABSENCE_NOTE_LONG_MIN_MS = 24 * 3_600_000

export default class TtsGreeterAutomation extends RuleBasedAutomationBase {

    /** @type {Record<string, unknown>|null} Cached greeter i18n bundle; reloaded on every run. */
    #bundle = null

    // -- Construction & lifecycle ------------------------------------------

    /**
     * Construct the greeter from its YAML config file located next to this script.
     */
    constructor() {
        super({ name: 'TtsGreeterAutomation', configPath: CONFIG_PATH })
    }

    /**
     * Lifecycle hook -- loads the greeter i18n bundle once on top of the base init;
     * execute() re-reads it fresh per run so sentence edits take effect immediately.
     */
    async init() {
        await super.init()
        this.#bundle = this.#loadBundle()
    }

    // -- Public API ----------------------------------------------------------

    /**
     * Custom execute flow: evaluate each candidate host and greet it when its absence
     * matches a configured window. Overrides the parent's device-targeting flow entirely
     * since this automation has no device targets -- only speech output.
     *
     * Event runs (network:<host>) are scoped to their own host; timer/manual/forced
     * runs cover every configured host. A host is greeted ONLY when currently online --
     * going-offline events are observed but never spoken about.
     *
     * @param {{trigger?: string, force?: boolean}|null} [triggerData] - Trigger info;
     *   force:true bypasses silent-period suppression (e.g., "/automation force")
     */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        this.log(`Triggered by: ${triggerSource}`, 'info')

        // Off-guard: if neither the AI pipeline nor the TTS server is available there is
        // no output channel for the greeting -- skip the run entirely rather than
        // assembling sentences that can only be dropped.
        if (!AiAssistant.isAvailable() && !TtsService.isEnabled()) {
            this.log('Both AI and TTS unavailable -- skipping greeter run', 'debug')
            return
        }

        // Suppress execution during a configured silent period (before any work begins),
        // unless explicitly forced from outside (e.g., "/automation force").
        if (this.isInSilentPeriod()) {
            if (triggerData?.force === true) {
                this.log(`Forced run -- silent period bypassed (${triggerSource})`, 'info')
            } else {
                this.log(`Suppressed during silent period (${triggerSource})`, 'debug')
                return
            }
        }

        // Reload bundle fresh each run (interpolation is runtime, not cached).
        this.#bundle = this.#loadBundle()
        if (!this.#bundle) {
            this.log('No greeter i18n bundle loaded, skipping', 'warn')
            return
        }

        for (const host of this.#candidateHosts(triggerSource)) {
            try {
                await this.#greetIfDue(host)
            } catch (error) {
                this.log(`Greeting evaluation failed for "${host}": ${error.message}`, 'error')
            }
        }
    }

    /**
     * No device targets for this automation -- returns empty Map so the parent's flow
     * short-circuits gracefully. We override execute() entirely but keep this for parity.
     * @returns {Map<string, never>} Empty map
     */
    loadDevices() {
        return new Map()
    }

    /**
     * Not used by ttsGreeter (no device commands). Required abstract method kept for
     * signature parity with the base class contract.
     * @param {*} _device - Unused in this override (kept for signature parity)
     * @param {string} _targetKey - Unused in this override
     * @returns {null} Always null
     */
    resolveCommand(_device, _targetKey) {
        return null
    }

    /**
     * Decide whether a host should be greeted right now and with which bucket.
     * Greetings require the host to be online NOW; the absence duration is how long it
     * sat offline before this transition (priorStateDurationMs), matched top-down
     * against greeting_windows -- first match wins, no match means silence. An unknown
     * duration (no prior history) fails open with the full welcome bucket.
     *
     * Exposed without the # prefix so tests can pin window selection against real DB
     * history; execute() is the sole production caller.
     * @param {string} host - Configured network host name
     * @returns {Promise<{action: 'speak', bucket: string, absenceMs: number|null}|{action: 'skip', reason: string}>}
     *   Decision record: speak + chosen bucket (+ measured absence when known), or skip + why
     */
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

    /**
     * Send one greeting through the AI -> TTS pipeline with graceful degradation. A
     * non-empty model reply is surfaced in the chat window as a periodic response (the
     * audio itself was already fired by AiAssistant for that reply). An empty reply or
     * any provider failure logs a warning and reports false so the caller speaks the
     * plain sentence directly -- there is deliberately NO spoken fallback notice here;
     * unlike WeatherMan's periodic report, a missed greeting must not be announced twice.
     *
     * Exposed without the # prefix so tests can pin behaviour against a stubbed
     * AiAssistant without MQTT, devices, or a live LLM; #deliver() is the sole
     * production caller.
     * @param {string} aiInstruction - Full instruction sent to the model
     * @returns {Promise<boolean>} true when the AI voiced the greeting, false on fallback
     */
    async routeThroughAi(aiInstruction) {
        let spoken = ''
        try {
            const response = await AiAssistant.processMessage(aiInstruction, { origin: ChatMessageOrigin.SYSTEM })
            spoken = typeof response === 'string' ? response.trim() : ''
        } catch (error) {
            this.log(`AI processing failed: ${error.message}`, 'warn')
            return false
        }

        if (!spoken) {
            this.log('AI reply was empty -- falling back to direct TTS', 'warn')
            return false
        }

        // Emit the AI's response back to UI for rendering with <AI> prefix.
        // Guard against --no-ui runs where no subscribers exist.
        if (EventBus.hasSubscribers('ai:periodicResponse')) {
            EventBus.emit('ai:periodicResponse', { text: spoken })
        }
        this.log(`Greeting sent via AI -> TTS pipeline (${spoken.length} chars)`, 'debug')
        return true
    }

    // -- Greeting flow -------------------------------------------------------

    /**
     * Evaluate one host end-to-end and deliver when due; logs the decision either way.
     * @private
     * @param {string} host - Configured network host name
     */
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

    /**
     * Deliver one decided greeting through the configured output path. use_ai=true routes
     * through the model's own voice when it can answer; every other case speaks the plain
     * tts.<host> sentence directly. A bucket missing from the bundle entirely warns (a
     * window "sentence" typo); a host with no line in that bucket on EITHER channel is
     * treated as not requiring a greeting there and skips silently at debug level instead.
     * Missing single-channel templates still warn rather than speak raw {% ... %} tokens.
     * When history provides an absence duration, the localized absence note is appended
     * after whichever text goes out (AI instruction or spoken TTS).
     * @private
     * @param {string} host - Host key under names/
     * @param {{bucket: string}} decision - Decision from greetDecisionFor()
     */
    async #deliver(host, decision) {
        const section = this.#bundle?.[decision.bucket]
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
            this.log(`Greeting bucket "${decision.bucket}" not found in active bundle -- check greeting_windows`, 'warn')
            return
        }
        if (!this.#hasLine(section, 'tts', host) && !this.#hasLine(section, 'ai', host)) {
            // Deliberate per-host opt-out (e.g., a shared HTPC only needs some buckets):
            // nothing to say for this machine here, so no warning either.
            this.log(`No greeting configured for "${host}" in bucket "${decision.bucket}" -- treating as not required`, 'debug')
            return
        }

        const plainText = this.#sentence(decision.bucket, 'tts', host)
        if (!plainText) {
            this.log(`No TTS sentence for "${decision.bucket}.tts.${host}" in active bundle -- skipping`, 'warn')
            return
        }

        if (this.config.use_ai === true && AiAssistant.isAvailable()) {
            let instruction = this.#sentence(decision.bucket, 'ai', host)
            if (!instruction) {
                this.log(`No AI instruction for "${decision.bucket}.ai.${host}" -- speaking the plain TTS sentence instead`, 'warn')
            } else {
                // Ask the model to include the absence note too when history provides one.
                const aiNote = await this.#absenceNote(host, 'ai', decision)
                if (aiNote) instruction = `${instruction} ${aiNote}`
                // Emit system input to UI with exactly what goes to the model.
                // Guard against --no-ui runs where no subscribers exist.
                if (EventBus.hasSubscribers('ai:systemMessage')) {
                    EventBus.emit('ai:systemMessage', { text: instruction })
                }
                if (await this.routeThroughAi(instruction)) return
                // routeThroughAi already logged why; fall through and speak directly so
                // a flaky/slow LLM never drops the greeting entirely.
            }
        } else if (this.config.use_ai === true) {
            this.log('use_ai enabled but AI unavailable -- speaking the plain TTS sentence instead', 'warn')
        }

        // Append the localized absence note when history provides a duration;
        // it never replaces or blocks the main greeting.
        const ttsNote = await this.#absenceNote(host, 'tts', decision)
        const spoken = ttsNote ? `${plainText} ${ttsNote}` : plainText
        EventBus.emit('tts:speak', { text: spoken })
        this.log(`Greeting for "${host}" (${decision.bucket}) sent via direct TTS`, 'debug')
    }

    // -- Config & bundle helpers ---------------------------------------------

    /**
     * Hosts to evaluate on a given trigger. Event runs are scoped to their own host;
     * timer/manual/forced runs cover every configured host. Events naming an unconfigured
     * host are ignored (not ours to greet).
     * @private
     * @param {string} triggerSource - Trigger identifier from execute()
     * @returns {string[]} Candidate hosts (may be empty)
     */
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

    /**
     * Normalized list of hosts from config.triggers_network (array or single string);
     * empty when unset so the greeter stays inert until pointed at real machines.
     * @private
     * @returns {string[]} Host names
     */
    #configuredHosts() {
        const raw = this.config?.triggers_network
        if (Array.isArray(raw)) return raw.map((h) => String(h)).filter(Boolean)
        if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
        return []
    }

    /**
     * Parsed greeting windows in YAML order (top-down, first match wins). Malformed
     * entries warn and are skipped rather than failing closed; malformed bounds open up
     * that side instead of silently swallowing every absence.
     * @private
     * @returns {Array<{name: string, minMs: number|null, maxMs: number|null, bucket: string}>} Usable windows
     */
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

    /**
     * Resolve one window bound via temporal.parseDurationMs(); absent values are
     * open-ended (null); present-but-invalid ones warn and also open the side rather
     * than failing closed.
     * @private
     * @param {*} raw - Raw config value ("5s", "7m", "4h", plain ms, or omitted)
     * @param {string} label - Config path used in warning messages
     * @returns {number|null} Bound in milliseconds, or null for an unbounded side
     */
    #parseBound(raw, label) {
        if (raw == null || raw === '') return null
        const ms = temporal.parseDurationMs(raw)
        if (ms != null && Number.isFinite(ms) && ms >= 0) return Math.round(ms)
        this.log(`${label}: ${JSON.stringify(raw)} is not a valid duration ("5s", "7m", "4h") or milliseconds -- treating as unbounded`, 'warn')
        return null
    }

    /**
     * Load the greeter i18n bundle for the active locale; null when missing/unreadable
     * so execute() can warn once instead of throwing mid-run.
     * @private
     * @returns {Record<string, unknown>|null} Parsed bundle object
     */
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

    /**
     * Fill {% token %} placeholders in a raw template from a flat token map. Returns the
     * interpolated text, or '' (with a warning naming the bundle path) when any token is
     * missing or empty -- callers skip instead of speaking raw {% ... %} tokens.
     * @private
     * @param {string} template - Raw YAML template line
     * @param {Record<string, unknown>} tokens - Token name to replacement string
     * @param {string} label - Bundle path used in warning messages
     * @returns {string} Interpolated text, or '' when unresolvable
     */
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

    /**
     * Resolve one sentence template (bucket + output channel + host) with name-case
     * interpolation. Returns '' when any part is missing or a placeholder cannot be
     * filled, so callers warn and skip instead of speaking raw {% ... %} tokens.
     * @private
     * @param {string} bucket - Bundle section, e.g., 'welcome' | 'forgot' | 'reboot'
     * @param {'tts'|'ai'} channel - Output-path section inside the bucket
     * @param {string} host - Host key under names/
     * @returns {string} Interpolated text, or '' when unresolvable
     */
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

    /**
     * Whether a non-empty template line exists for one output channel of a bucket+host
     * pair; lets #deliver() tell an intentional per-host omission (no lines at all ->
     * "greeting not required", skip silently) from a partial configuration (one channel
     * missing -> warn and fall back as before).
     * @private
     * @param {{tts?: Record<string, unknown>, ai?: Record<string, unknown>}} section - Parsed bundle bucket section
     * @param {'tts'|'ai'} channel - Output-path key inside the section
     * @param {string} host - Host name
     * @returns {boolean} true when a usable string line is present
     */
    #hasLine(section, channel, host) {
        const value = section?.[channel]?.[host]
        return typeof value === 'string' && value.trim() !== ''
    }

    /**
     * Whether the host's canonical welcome TTS line addresses them by name (contains a
     * {% name_vocative %} / {% name_genitive %} placeholder); chooses between the possessive
     * (_named) and neutral (_anonymous) absence-note variants -- "Twój komputer ..." only
     * makes sense after a greeting that named the person. A missing line counts as
     * anonymous so shared machines never get a possessive note.
     * @private
     * @param {string} host - Host key under names/
     * @returns {boolean} true when the welcome TTS line uses a name placeholder
     */
    #greetingUsesName(host) {
        const line = this.#bundle?.welcome?.tts?.[host]
        return typeof line === 'string' && /\{%\s*name_(?:vocative|genitive)\s*%\}/.test(line)
    }

    /**
     * Build the localized absence note appended after the bucket greeting, or '' to omit
     * it. Two tiers by how long the host was off: below ABSENCE_NOTE_LONG_MIN_MS --
     * "last seen online <duration> ago" via lib/date's speech-oriented phrase; at/above
     * it -- full calendar date + zero-padded 24-hour clock time of the offline transition
     * (the same date_sentence machinery WeatherMan uses). The tts channel prefers the
     * _named / _anonymous pair -- possessive only when the welcome line names the person
     * -- and degrades to legacy short_* lines in older bundles rather than dropping the
     * note. Returns '' whenever anything is missing so the main greeting always stands
     * alone. Never throws.
     * @private
     * @param {string} host - Configured network host name
     * @param {'tts'|'ai'} channel - Output-path section inside absence_note/
     * @param {{bucket: string, absenceMs: number|null}} decision - Decision record from greetDecisionFor()
     * @returns {Promise<string>} Interpolated note without leading separator, or '' to omit
     */
    async #absenceNote(host, channel, decision) {
        if (!Number.isFinite(decision?.absenceMs) || !(decision.absenceMs > 0)) return ''
        const section = this.#bundle?.absence_note?.[channel]
        if (!section || typeof section !== 'object') return ''

        // Relative ("... X temu") below the boundary; absolute date + time at/above it.
        const variant = decision.absenceMs >= ABSENCE_NOTE_LONG_MIN_MS ? 'long' : 'recent'

        const pick = (key) => (typeof section[key] === 'string' && String(section[key]).trim()) ? section[key] : null
        const resolveTemplate = (v) => (channel === 'tts')
            // The possessive form ("Twój komputer ...") only fits a greeting that named the
            // person; machines without one get the neutral anonymous variant instead.
            ? pick(`${v}_${this.#greetingUsesName(host) ? 'named' : 'anonymous'}`) ?? pick(v)
            : pick(v)

        // Bundles predating the recent tier keep their "off for ..." short_* lines.
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
            // The offline transition's own timestamp; fall back to now-minus-absence when
            // history is shorter than expected so rendering still has a moment.
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
