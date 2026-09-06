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
 * template picks the grammatical case it needs.
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
     * tts.<host> sentence directly. Missing templates warn and skip instead of speaking
     * raw {% ... %} tokens.
     * @private
     * @param {string} host - Host key under names/
     * @param {{bucket: string}} decision - Decision from greetDecisionFor()
     */
    async #deliver(host, decision) {
        const plainText = this.#sentence(decision.bucket, 'tts', host)
        if (!plainText) {
            this.log(`No TTS sentence for "${decision.bucket}.tts.${host}" in active bundle -- skipping`, 'warn')
            return
        }

        if (this.config.use_ai === true && AiAssistant.isAvailable()) {
            const instruction = this.#sentence(decision.bucket, 'ai', host)
            if (!instruction) {
                this.log(`No AI instruction for "${decision.bucket}.ai.${host}" -- speaking the plain TTS sentence instead`, 'warn')
            } else {
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

        EventBus.emit('tts:speak', { text: plainText })
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
        const names = this.#bundle.names?.[host]
        let unresolved = false
        const text = String(template).replace(/\{%\s*name_(vocative|genitive)\s*%\}/g, (_match, caseName) => {
            const value = (names && typeof names === 'object') ? names[caseName] : undefined
            if (typeof value === 'string' && value.trim() !== '') return value
            unresolved = true
            return _match
        })
        if (unresolved) {
            this.log(`Sentence "${bucket}.${channel}.${host}" has an unresolvable name placeholder -- check names.${host}`, 'warn')
            return ''
        }
        return text
    }

}
