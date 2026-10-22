/**
 * TTS Twilight Automation.
 * Announces civil dawn and sunset by voice -- once per day, at the exact local minute,
 * each event through its own TTS profile so dawn and dusk get their own spoken framing.
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
import EventBus from '../../src/service/eventBus.js'
import I18nLoader from '../../src/service/i18nLoader.js'
import TtsService from '../../src/service/ttsService.js'
import TtsProfiles from '../../src/lib/ttsProfiles.js'
import temporal from '../../src/lib/date.js'
import { PROJECT_ROOT } from '../../src/lib/projectRoot.js'


/** Path to this automation's YAML config file. */
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-twilight.yaml')

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** One minute in milliseconds -- the natural granularity of this automation's clock. */
const MINUTE_MS = 60_000

/** Announce window used when `announce_grace` is missing or malformed (5 minutes). */
const DEFAULT_ANNOUNCE_GRACE_MS = 5 * MINUTE_MS

/** Rule `event:` keys accepted, mapped to the context field carrying their instant. */
const EVENT_CONTEXT_KEYS = {
    sundawn: 'sundawn',
    sunrise: 'sundawn',
    sundusk: 'sundusk',
    sunset: 'sundusk'
}

export default class TtsTwilightAutomation extends RuleBasedAutomationBase {

    /** @type {Record<string, unknown>|null} Cached twilight i18n bundle; reloaded on every run. */
    #bundle = null

    /** Local day key of the last "no sun times" warning -- keeps missing geo quiet. */
    #geoWarnDay = null

    /** Pending anchor handle of the minute-aligned timer (null once the interval runs). */
    #anchorTimer = null

    //  -- Construction & lifecycle ------------------------------------------

    /** Fixed identity constructor -- name and config path are constants of this automation. */
    constructor() {
        super({ name: 'TtsTwilightAutomation', configPath: CONFIG_PATH })
    }

    /** Lifecycle hook -- loads the twilight i18n bundle once on top of the base init.
     * @returns {Promise<void>} */
    async init() {
        await super.init()
        this.#bundle = this.#loadBundle()
    }

    /** Drop the anchored timer handle on top of the base cleanup.
     * @returns {void} */
    cleanup() {
        if (this.#anchorTimer != null) {
            clearTimeout(this.#anchorTimer)
            this.#anchorTimer = null
        }
        super.cleanup()
    }

    //  -- Public API ----------------------------------------------------------

    /** Main execution flow. Picks the sun event due on this tick (or the event a manual run
     * should preview), speaks it through the rule's own framing, and consumes the daily slot.
     * @param {{trigger?: string, force?: boolean}|null} [triggerData] - Trigger info
     * @returns {Promise<void>} */
    async execute(triggerData = null) {
        return this.runWithAiGuard(this.config?.use_ai === true && AiAssistant.isAvailable(), () => this.#executeRun(triggerData))
    }

    /** Execute one announcement run, holding the shared guard when AI is enabled.
     * @private
     * @param {{trigger?: string, force?: boolean, forceFirst?: boolean}|null} triggerData - Trigger metadata
     * @returns {Promise<void>} Resolves after output and completion bookkeeping */
    async #executeRun(triggerData) {
        const triggerSource = String(triggerData?.trigger ?? 'unknown')
        const forced = triggerData?.force === true
        this.log(`Triggered by: ${triggerSource}`, 'info')

        //  Off-guard: if neither the AI pipeline nor the TTS server is available.
        if (!AiAssistant.isAvailable() && !TtsService.isEnabled()) {
            this.log('Both AI and TTS unavailable -- skipping twilight run', 'debug')
            return
        }

        //  Suppress execution during configured silent period (before any work begins).
        if (this.isInSilentPeriod()) {
            if (forced) {
                this.log(`Forced run -- silent period bypassed (${triggerSource})`, 'info')
            } else {
                this.log('Suppressed during silent period', 'debug')
                return
            }
        }

        //  Reload bundle fresh each run (interpolation is runtime, not cached).
        this.#bundle = this.#loadBundle()
        if (!this.#bundle) {
            this.log('No twilight i18n bundle loaded, skipping', 'warn')
            return
        }

        const rules = this.rules()
        if (rules.length === 0) {
            this.log('No usable sun-event rules configured -- nothing to announce', 'warn')
            return
        }

        const context = await this.buildContext()
        if (context.sundawn === null && context.sundusk === null) {
            this.#warnMissingGeo()
            return
        }

        const kind = this.#runKind(triggerSource)
        const due = kind === 'immediate'
            ? await this.upcomingEvent(rules, context)
            : await this.dueEvent(rules, context, forced)
        if (!due) {
            this.log('No sun event to announce on this run -- staying quiet', 'debug')
            return
        }

        const spoken = await this.speakEvent(due.rule, due.tokens)
        if (!spoken) return   // missing template already warned; do not consume the day's slot

        //  Consume the daily slot only after speech went out, and never on a forced run or a
        //  manual preview -- poking the automation by hand must not eat the day's announcement.
        if (!forced && kind === 'timer' && due.rule.once) {
            await this.markActedToday(due.rule, context.timeOfDay)
        }
    }

    /** No device targets for this automation -- returns empty Map so parent's flow
     * @returns {Map<string, never>} Empty map */
    loadDevices() {
        return new Map()
    }

    /** Not used by ttsTwilight (no device commands). Required abstract method kept.
     * @param {*} _device - Unused in this override (kept for signature parity)
     * @param {string} _targetKey - Unused in this override
     * @param {Array<Object>} _matchingRules - Unused in this override
     * @returns {null} Always null */
    resolveCommand(_device, _targetKey, _matchingRules) {
        return null
    }

    //  -- Timer management ----------------------------------------------------

    /** Minute-aligned timer: fire on the next wall-clock boundary, then every interval.
     * A plain setInterval starts at process-start phase, so an exact-minute event can sit a
     * whole tick away from any tick; anchoring the cadence to the boundary keeps every event
     * within one tick of a tick, which is what the announce grace window relies on.
     * @param {number} intervalMs - Interval in milliseconds
     * @returns {void} */
    startTimer(intervalMs) {
        const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : MINUTE_MS
        const graceMs = this.announceGraceMs()
        if (graceMs < interval) {
            this.log(`announce_grace (${temporal.millisecondsToHumanReadable(graceMs)}) is shorter than the timer interval (${temporal.millisecondsToHumanReadable(interval)}) -- an exact-minute event can be missed`, 'warn')
        }

        const _tick = () => {
            try {
                this.execute({ trigger: 'timer' })
            } catch (error) {
                this.log(`Error executing timer for ${this.name}: ${error.message}`, 'error')
            }
        }

        //  Defensive re-entry guard: never leak a previous handle -- two live timers for one.
        if (this._timer != null) {
            clearInterval(this._timer)
            this._timer = null
        }
        if (this.#anchorTimer != null) clearTimeout(this.#anchorTimer)

        const delayMs = interval - (Date.now() % interval)
        this.#anchorTimer = setTimeout(() => {
            this.#anchorTimer = null
            _tick()
            this._timer = setInterval(_tick, interval)
        }, delayMs)

        this.log(`Timer anchored to ${temporal.millisecondsToHumanReadable(interval)} boundaries (first tick in ${Math.round(delayMs / 1000)}s)`, 'info')
    }


    //  -- Testable seams ------------------------------------------------------

    /** First rule whose sun event is announceable right now: its gate is open, its instant
     * lies inside the announce grace window, and (for `once` rules) today's slot is still
     * unconsumed. Rules are tried in YAML order, so the first match wins.
     * @param {Array<Object>} rules - Normalized rules in YAML order
     * @param {Object} context - Built automation context
     * @param {boolean} [forced=false] - When true, the daily marker check is skipped
     * @returns {Promise<{rule: Object, instantMs: number, tokens: Record<string, string>}|null>} Due event, or null */
    async dueEvent(rules, context, forced = false) {
        const graceMs = this.announceGraceMs()
        const nowMs = Date.now()
        for (const rule of rules) {
            const instantMs = this.eventInstantMs(rule.event, context)
            if (instantMs === null) continue
            const elapsedMs = nowMs - instantMs
            if (elapsedMs < 0 || elapsedMs > graceMs) continue
            if (!await this.#gateOpen(rule, context)) continue
            if (rule.once && !forced && await this.hasActedToday(rule, context.timeOfDay)) {
                this.log(`Rule "${rule.name}" already announced today -- staying quiet`, 'debug')
                continue
            }
            return { rule, instantMs, tokens: this.#tokensFor(instantMs) }
        }
        return null
    }

    /** Event a manual run previews: the next sun event still ahead of now, falling back to
     * the most recent one that already passed today. The daily marker is never consulted and
     * never consumed, so poking the automation by hand cannot eat the day's slot.
     * @param {Array<Object>} rules - Normalized rules in YAML order
     * @param {Object} context - Built automation context
     * @returns {Promise<{rule: Object, instantMs: number, tokens: Record<string, string>}|null>} Preview event, or null */
    async upcomingEvent(rules, context) {
        const nowMs = Date.now()
        let latest = null
        for (const rule of rules) {
            const instantMs = this.eventInstantMs(rule.event, context)
            if (instantMs === null) continue
            //  An event still ahead has its gate closed by definition -- preview it as-is.
            if (instantMs > nowMs) return { rule, instantMs, tokens: this.#tokensFor(instantMs) }
            if (await this.#gateOpen(rule, context)) latest = { rule, instantMs, tokens: this.#tokensFor(instantMs) }
        }
        return latest
    }

    /** Epoch milliseconds of one sun event from the built context; null when the key is
     * unknown or the context carries no instant for it (unconfigured geo).
     * @param {string} eventKey - Rule event name ('sundawn' / 'sundusk' and aliases)
     * @param {Object} context - Built automation context
     * @returns {number|null} Event instant in epoch ms, or null */
    eventInstantMs(eventKey, context) {
        const ctxKey = EVENT_CONTEXT_KEYS[String(eventKey ?? '').trim().toLowerCase()]
        if (!ctxKey) return null
        const value = context?.[ctxKey]
        return Number.isFinite(value) ? value : null
    }

    /** Announce window (ms) after an event instant during which the event is still speakable.
     * @returns {number} Grace window in milliseconds */
    announceGraceMs() {
        const raw = this.config?.announce_grace
        if (raw == null) return DEFAULT_ANNOUNCE_GRACE_MS
        const ms = temporal.parseDurationMs(raw)
        if (ms == null || ms < 0) {
            this.log(`announce_grace ${JSON.stringify(raw)} is not a valid duration -- using ${temporal.millisecondsToHumanReadable(DEFAULT_ANNOUNCE_GRACE_MS)}`, 'warn')
            return DEFAULT_ANNOUNCE_GRACE_MS
        }
        return ms
    }

    /** Resolve one configured bundle section, fill its runtime placeholders and speak the
     * result. Framing comes from the rule itself, so dawn and dusk carry their own jingles.
     * @param {Object} rule - Normalized rule carrying `section`, `tts_profile`, `tts_options`
     * @param {Record<string, string>} tokens - Placeholder values ({% time %})
     * @returns {Promise<boolean>} Whether speech went out */
    async speakEvent(rule, tokens) {
        const section = this.#resolveSection(rule.section)
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
            this.log(`Twilight section "${rule.section}" not found in active bundle -- check rules[].sentence`, 'warn')
            return false
        }

        const plainText = this.#fillTemplate(section.tts, tokens, `${rule.section}.tts`)
        if (!plainText) {
            this.log(`No TTS sentence for "${rule.section}.tts" in active bundle -- skipping`, 'warn')
            return false
        }

        //  Framing (intro/outro/spacing) resolved from this rule's own keys.
        const ttsOptions = TtsProfiles.resolve(rule, (message) => this.log(message, 'warn'))

        if (this.config.use_ai === true && AiAssistant.isAvailable()) {
            const instruction = this.#fillTemplate(section.ai, tokens, `${rule.section}.ai`)
            if (!instruction) {
                this.log(`No AI instruction for "${rule.section}.ai" -- speaking the plain TTS sentence instead`, 'warn')
            } else {
                //  Emit system input to UI with exactly what goes to the model.
                if (EventBus.hasSubscribers('ai:systemMessage')) {
                    EventBus.emit('ai:systemMessage', { text: instruction })
                }
                if (await this.routeThroughAi(instruction, ttsOptions)) return true
                //  routeThroughAi already logged why.
            }
        } else if (this.config.use_ai === true) {
            this.log('use_ai enabled but AI unavailable -- speaking the plain TTS sentence instead', 'warn')
        }

        TtsProfiles.speak(plainText, ttsOptions)
        this.log(`Twilight announcement (${rule.section}) sent via direct TTS`, 'debug')
        return true
    }

    /** Send one built twilight announcement through the AI -> TTS pipeline with graceful
     * degradation: empty reply or thrown error falls back to the plain TTS sentence.
     * @param {string} aiInstruction - Full instruction sent to the model
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} [ttsOptions={}] - Framing forwarded to the model's own speech
     * @returns {Promise<boolean>} true when the AI voiced the announcement, false on fallback */
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
        this.log(`Twilight announcement sent via AI -> TTS pipeline (${spoken.length} chars)`, 'debug')
        return true
    }

    /** Clear in-memory run state. The once-per-day markers themselves live in Redis under the
     * base's `auto:<name>:once:<slug>` keys and expire with their own TTL.
     * @returns {void} */
    resetState() {
        this.#bundle = null
        this.#geoWarnDay = null
    }




    //  -- Config & bundle helpers ---------------------------------------------

    /** Classify a trigger into an execution kind: timer ticks evaluate the events due inside
     * their grace window, every other trigger (manual, interaction, AI) previews the event
     * coming next without touching the daily marker.
     * @private
     * @param {string} triggerSource - Trigger identifier from execute()
     * @returns {'timer'|'immediate'} Execution kind */
    #runKind(triggerSource) {
        return String(triggerSource ?? '') === 'timer' ? 'timer' : 'immediate'
    }

    /** Evaluate one rule's gate against the built context, failing closed on evaluation
     * errors so a malformed rule can never spam the room.
     * @private
     * @param {Object} rule - Normalized rule carrying its conditions
     * @param {Object} context - Built automation context
     * @returns {Promise<boolean>} true when the gate holds */
    async #gateOpen(rule, context) {
        try {
            return await this.conditionsMatch(rule.conditions, context)
        } catch (error) {
            this.log(`Error evaluating rule "${rule.name}": ${error.message}`, 'error')
            return false
        }
    }

    /** Warn once per local day that civil dawn/dusk cannot be resolved -- the usual cause is
     * a missing or out-of-range `locale.geo_latitude` / `locale.geo_longitude`.
     * @private
     * @returns {void} */
    #warnMissingGeo() {
        const dayKey = temporal.getLocalDayString()
        if (this.#geoWarnDay === dayKey) return
        this.#geoWarnDay = dayKey
        this.log('Civil dawn/dusk unresolvable -- set locale.geo_latitude and locale.geo_longitude in etc/automaton.yaml', 'warn')
    }

    /** Runtime placeholder values for sentence interpolation, built from the EVENT instant and
     * never from the running clock -- a catch-up tick four minutes after dawn must speak dawn's
     * hour and dawn's day-part. {% time %} stays the unambiguous zero-padded 24-hour form;
     * {% time_words %} is the same moment spelled in words by the locale's language generator
     * (lib/date owns it; digits when the locale has none), so the plain TTS path speaks
     * "szósta osiemnaście" and the model is handed finished words instead of being asked to
     * inflect digits; {% hours %} / {% minutes %} / {% time_of_day %} carry the moment as
     * 12-hour parts plus the localized day-period word.
     * @private
     * @param {number} instantMs - Event instant in epoch ms
     * @returns {Record<string, string>} Token map */
    #tokensFor(instantMs) {
        const when = new Date(instantMs)
        const hour24 = when.getHours()
        const clock = temporal.formatClockTime(when)
        const period = temporal.getCurrentTimePeriod(when)
        //  The raw period name is the last-resort word, so a bundle can never lose its sentence.
        const timeOfDay = (period && (temporal.getPeriodWords()[period] || period)) || ''
        return {
            time: clock,
            time_words: temporal.getClockWords(when) || clock,
            hours: String(I18nLoader.is12HourFormat() ? ((hour24 + 11) % 12) + 1 : hour24),
            minutes: String(when.getMinutes()),
            time_of_day: timeOfDay
        }
    }

    /** Load the twilight i18n bundle for the active locale.
     * @private
     * @returns {Record<string, unknown>|null} Parsed bundle object */
    #loadBundle() {
        try {
            const localeDir = I18nLoader.getLocale()
            const filePath = path.join(I18N_ROOT, localeDir, 'twilight.yaml')
            if (!fs.existsSync(filePath)) return null
            const doc = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            return doc.contents?.toJSON() ?? null
        } catch (error) {
            this.log(`Failed to load twilight bundle: ${error.message}`, 'warn')
            return null
        }
    }

    /** Resolve a dotted i18n key against the loaded bundle. The first segment is treated.
     * @private
     * @param {string} key - Dot-separated key from a rule's "sentence"
     * @returns {*} Resolved value or undefined when not found */
    #resolveSection(key) {
        if (!this.#bundle || !key) return undefined
        const parts = String(key).split('.')
        if (parts.length < 2) return this.#bundle[key]
        let current = this.#bundle
        for (let i = 1; i < parts.length; i++) {
            if (current == null || typeof current !== 'object') return undefined
            current = current[parts[i]]
        }
        return current
    }


    /** Fill {% token %} placeholders in a raw template from a flat token map.
     * @private
     * @param {*} template - Raw YAML template line (must be a string to succeed)
     * @param {Record<string, unknown>} tokens - Token name to replacement string
     * @param {string} label - Bundle path used in warning messages
     * @returns {string} Interpolated text, or '' when unresolvable */
    #fillTemplate(template, tokens, label) {
        if (typeof template !== 'string' || !template.trim()) return ''
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

    /** Normalized rules in YAML order: the sun event each rule announces, the gate it must
     * pass, the bundle section it speaks, and the TTS framing keys the announcement is framed
     * with. A rule with no `conditions:` gets the plain "event has happened" gate; `once`
     * defaults to true because an announcement is a daily event unless a deployment opts out
     * with `once: false`.
     * @private
     * @returns {Array<Object>} Usable rules (name, event, conditions, section, once, framing) */
    rules() {
        const out = []
        const raw = this.config?.rules
        if (!Array.isArray(raw)) return out
        raw.forEach((rule, index) => {
            if (!rule || typeof rule !== 'object') {
                this.log(`rules[${index}] is not an object -- skipping`, 'warn')
                return
            }
            const section = typeof rule.sentence === 'string' && rule.sentence.trim() ? rule.sentence.trim() : null
            if (!section) {
                this.log(`rules[${index}] has no "sentence" bundle key -- skipping`, 'warn')
                return
            }
            const eventKey = String(rule.event ?? '').trim().toLowerCase()
            const ctxKey = EVENT_CONTEXT_KEYS[eventKey]
            if (!ctxKey) {
                this.log(`rules[${index}] has no usable "event" (expected sundawn or sundusk) -- skipping`, 'warn')
                return
            }
            out.push({
                name: String(rule.name ?? `rule-${index + 1}`),
                event: ctxKey,
                conditions: (rule.conditions && typeof rule.conditions === 'object') ? rule.conditions : { after_latest_of: [ctxKey] },
                section,
                once: rule.once !== false,
                ...(typeof rule.tts_profile === 'string' && rule.tts_profile.trim() ? { tts_profile: rule.tts_profile.trim() } : {}),
                ...(rule.tts_options && typeof rule.tts_options === 'object' ? { tts_options: rule.tts_options } : {})
            })
        })
        return out
    }
}
