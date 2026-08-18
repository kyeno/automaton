/**
 * TTS WeatherMan Automation.
 * Rule-based weather announcer that builds a speech message from a base sentence
 * and condition-matched additions, then routes through AI -> TTS pipeline (or
 * direct TTS if AI unavailable). Supports {{ DeviceName.property }} string
 * interpolation for live sensor data in i18n strings.
 *
 * When routing through AI, day-position markers derived purely from clock + config
 * (no stored state) frame the core content: an opening line marks the first / last /
 * only announcement of each daily session (the stretch between two silence windows),
 * while "next update in {% next_interval %}" closes middle-of-session runs.
 *
 * An opening time-of-day line is rendered before the base sentence on both output
 * paths; with stupid_ai_engine enabled its clock parts are pre-rendered as plain
 * digits so tiny models never have to convert a clock string into words.
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
import DeviceContainer from '../../src/device/container/deviceContainer.js'
import ConfigService from '../../src/service/configService.js'
import EventBus from '../../src/service/eventBus.js'
import I18nLoader from '../../src/service/i18nLoader.js'
import AiAssistant from '../../src/ai/aiAssistant.js'
import ChatMessageOrigin from '../../src/enum/aiChatMessageOrigin.js'
import { PROJECT_ROOT } from '../../src/lib/projectRoot.js'
import { round } from '../../src/lib/math.js'
import temporal from '../../src/lib/date.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to this automation's YAML config file. */
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-weatherman.yaml')

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Fallback text when a device or property is not found during interpolation. */
const INTERPOLATION_MISSING = 'N/A'

/** Regex to match {{ DeviceName.property }} placeholders in i18n strings. */
const INTERPOLATION_REGEX = /\{\{\s*([\w\s]+?)\.([\w]+)\s*\}\}/g

/** Regex to match {% keyword %} special-function placeholders in i18n strings. */
const TIME_INTERPOLATION_REGEX = /\{%\s*(\w+)\s*%\}/g

/** Scan horizon when predicting the next non-silent tick -- two days exceeds any sane config. */
const NEXT_ANNOUNCEMENT_HORIZON_MS = 48 * 3600 * 1000

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export default class TtsWeatherManAutomation extends RuleBasedAutomationBase {

    /** @type {Record<string, unknown>|null} Cached weatherman i18n bundle */
    #bundle = null

    constructor() {
        super({ name: 'TtsWeatherManAutomation', configPath: CONFIG_PATH })
    }

    async init() {
        await super.init()
        this.#bundle = this.#loadWeathermanBundle()
    }

    // -- Public API (override template method) ------------------------------

    /**
     * Custom execute that builds a speech message and sends it to TTS.
     * Overrides the parent's device-targeting flow entirely since this
     * automation has no device targets -- only TTS output.
     *
     * @param {{trigger?: string}|null} [triggerData]
     */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        this.log(`Triggered by: ${triggerSource}`, 'info')

        // Suppress execution during configured silent period (before any work begins)
        if (this.isInSilentPeriod()) {
            this.log(
                `Suppressed during silent period (${triggerSource})`,
                'debug'
            )
            return
        }

        // Reload bundle fresh each run (interpolation is runtime, not cached)
        this.#bundle = this.#loadWeathermanBundle()
        if (!this.#bundle) {
            this.log('No weatherman i18n bundle loaded, skipping', 'warn')
            return
        }

        // Build context for condition evaluation (reuses parent logic)
        let context
        try {
            context = await this.buildContext()
        } catch (error) {
            this.log(`Context build failed: ${error.message}`, 'warn')
            return
        }

        // One shared clock instant per run -- the opening time line and the day-position
        // markers must never mix two different "now"s across a minute boundary.
        const now = new Date()

        // Opening time-of-day line rendered BEFORE the base sentence on both output paths
        // (AI rewrite and direct TTS). Empty when the active bundle has no decoupled
        // time_sentence templates; such bundles keep their inline {% time %} in the base.
        const timeLine = this.buildTimeSentence(now)

        // Start with base sentence + interpolate sensor data
        const baseKey = this.config.sentence_base
        let baseText = this.#resolveI18n(baseKey, '')
        if (!baseText) {
            this.log(`Base sentence key "${baseKey}" not found in bundle`, 'warn')
            return
        }
        if (timeLine && /{%\s*time\s*%}/.test(baseText)) {
            this.log('Base sentence still contains {% time %}; the opening line already states the time -- consider removing it from your base template', 'debug')
        }
        const baseMessage = this.#interpolate(baseText, context)
        let message = timeLine ? `${timeLine} ${baseMessage}` : baseMessage

        // Evaluate all rules, collect matches, then pick highest priority winner.
        // When multiple rules match, only the one with the highest `priority` fires.
        // Default priority is 0; higher number wins. Ties are broken by YAML order
        // (first rule in file wins).
        const rules = this.config.rules ?? []
        const winners = []

        for (const rule of rules) {
            try {
                const match = await this.conditionsMatch(rule.conditions, context)
                if (match) {
                    winners.push({
                        rule,
                        priority: typeof rule.priority === 'number' ? rule.priority : 0
                    })
                }
            } catch (error) {
                this.log(`Error evaluating rule "${rule.name}": ${error.message}`, 'error')
            }
        }

        if (winners.length > 0) {
            // Sort descending by priority; stable sort preserves YAML order for ties
            winners.sort((a, b) => b.priority - a.priority)
            const best = winners[0]

            // Log suppressed lower-priority rules for debugging
            if (winners.length > 1) {
                const losers = winners.slice(1).map(
                    w => `"${w.rule.name}" (p=${w.priority})`
                ).join(', ')
                this.log(
                    `Multiple rules matched (${winners.length}), "${best.rule.name}" wins with priority ${best.priority}. Suppressed: ${losers}`,
                    'debug'
                )
            }

            // Append only the winner's sentence
            if (best.rule.sentence) {
                const ruleText = this.#resolveI18n(best.rule.sentence, '')
                if (ruleText) {
                    const interpolated = this.#interpolate(ruleText, context)
                    message += ' ' + interpolated
                    this.log(`Rule matched: "${best.rule.name}" -> appended sentence`, 'debug')
                }
            }
        }

        // Determine where this announcement sits within its daily session so the AI
        // prompt can frame the core content with first/last/only/next context.
        const meta = this.computeDayPosition(now)
        if (meta.isFirst || meta.isLast || meta.nextIntervalMs != null) {
            this.log(
                `Day position: first=${meta.isFirst}, last=${meta.isLast}` +
                (meta.nextIntervalMs != null ? `, next in ${temporal.millisecondsToHumanReadable(meta.nextIntervalMs)}` : ''),
                'debug'
            )
        }

        // Route output through AI->TTS or direct TTS
        await this.#speak(message, meta)
    }

    /**
     * No device targets for this automation -- returns empty Map so parent
     * execute() short-circuits gracefully. We override execute() entirely
     * but keep this for compatibility.
     * @returns {Map<string, never>}
     */
    loadDevices() {
        return new Map()
    }

    /**
     * Not used by ttsWeatherman (no device commands). Required abstract method.
     * @returns {null}
     */
    resolveCommand(_device, _targetKey, _matchingRules) {
        return null
    }

    /**
     * Compute where an announcement sits within its daily "session" -- the continuous
     * stretch between two silence windows (with silence_between "0230-1030", one session
     * runs from ~10:30 until ~02:30 next morning). Pure function of clock and config: no
     * state is kept, so results are deterministic per wall-clock time.
     *
     * Because timer ticks are spaced at least one interval apart even across process
     * restarts (setInterval re-anchors on boot), a run less than one interval after the
     * session began can never have had a predecessor in that same session -- making
     * first/last detection exact for timer-driven runs. The only residual error is a
     * missed "first" marker when the process was down across the wake-up boundary.
     *
     * Exposed without the # prefix (like AutomationBase._initialized/_timer) so unit
     * tests can verify the matrix without MQTT or AI providers.
     *
     * @param {Date} [now=new Date()] - Moment to evaluate
     * @returns {{isFirst: boolean, isLast: boolean, nextIntervalMs: number|null}}
     *   isFirst/isLast require both a positive timer interval and a valid silence window;
     *   nextIntervalMs is milliseconds until the next non-silent tick, or null when the
     *   timer is disabled or no such tick exists within the scan horizon.
     */
    computeDayPosition(now = new Date()) {
        const result = { isFirst: false, isLast: false, nextIntervalMs: null }

        const intervalMs = this.getTimerIntervalMs()
        if (!(intervalMs > 0)) return result            // event-driven only -- nothing periodic to predict
        if (this.isInSilentPeriodAt(now)) return result // defensive: markers are meaningless mid-silence

        // Next announcement = first upcoming tick outside the silent window. For pure
        // timer runs this resolves in one step (ticks sit exactly `intervalMs` apart);
        // the loop also stays correct for hypothetical out-of-band trigger invocations.
        let t = now.getTime() + intervalMs
        const horizon = now.getTime() + NEXT_ANNOUNCEMENT_HORIZON_MS
        while (t <= horizon) {
            if (!this.isInSilentPeriodAt(new Date(t))) {
                result.nextIntervalMs = t - now.getTime()
                break
            }
            t += intervalMs
        }

        const win = this.parseSilenceWindow()
        if (!win) return result   // no silence window -> no sessions -> no first/last notion

        result.isFirst = now.getTime() - this.#sessionBeganAt(win, now) < intervalMs
        result.isLast  = this.#sessionEndsAt(win, now) - now.getTime() < intervalMs
        return result
    }

    /**
     * Assemble the full prompt sent to the AI for a weather update. Layout: creative
     * prefix -> optional day-position opener (first / last / only) -> core message ->
     * optional "next update in ..." closer. Returns the plain message unchanged when
     * nothing was added, so callers can detect marker-less runs cheaply.
     *
     * Exposed without the # prefix so unit tests can verify assembly order and i18n
     * degradation without a live AI provider; #speak() is the sole production caller.
     *
     * @param {string} message - Interpolated core speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     *   Day position computed by {@link computeDayPosition}
     * @returns {string} Full AI prompt (equals `message` when no markers apply)
     */
    buildAiPrompt(message, meta = {}) {
        const parts = []

        // Creative instruction prefix (existing behaviour).
        const aiPrefixKey = this.config.sentence_ai_prefix
        if (aiPrefixKey && this.#bundle) {
            const prefixText = this.#resolveI18n(aiPrefixKey, '')
            if (prefixText) parts.push(prefixText)
        }

        // Opening day-position marker -- exactly one of first / last / only applies per run.
        let openerKey = null
        if (meta.isFirst && meta.isLast)      openerKey = 'weatherman.ai_message_only'
        else if (meta.isFirst)                openerKey = 'weatherman.ai_message_first'
        else if (meta.isLast)                 openerKey = 'weatherman.ai_message_last'
        if (openerKey) {
            const opener = this.#interpolate(this.#resolveI18n(openerKey, ''))
            if (opener) parts.push(opener)
        }

        parts.push(message)

        // Closing "next update" line -- middle-of-session runs only. Skipped gracefully
        // when the bundle lacks the template or localized duration words.
        if (!meta.isFirst && !meta.isLast && typeof meta.nextIntervalMs === 'number' && meta.nextIntervalMs > 0) {
            const template = this.#resolveI18n('weatherman.ai_message_next', '')
            const phrase = temporal.msToHumanPhrase(meta.nextIntervalMs, this.#bundle?.duration_units ?? {})
            if (template && phrase) {
                parts.push(this.#interpolate(template, null, { next_interval: phrase }))
            }
        }

        return parts.length === 1 ? message : parts.join('\n')
    }

    /**
     * Resolve the global "stupid AI engine" switch from the AI section of automaton.yaml.
     * When enabled (the default), components simplify what they hand to the model by
     * pre-rendering linguistic content up front so weak engines never have to convert raw
     * data into words themselves; see the config comment there for current consumers and
     * planned future hooks. Only an explicit `false` disables the accommodation. Exposed
     * without the # prefix so unit tests can pin either behaviour per instance without
     * mutating global config state.
     * @returns {boolean} true when the configured model should be treated as weak [default]
     */
    isStupidAiEngine() {
        return ConfigService.get('stupid_ai_engine', true) !== false
    }

    /**
     * Render the opening time-of-day line for a weather update, or '' when no applicable
     * template exists. The line is prepended to the base sentence on both output paths
     * (AI rewrite and direct TTS), which keeps tiny models away from converting clock
     * strings into words and keeps Piper TTS away from ambiguous bare H:M digits -- the
     * "N minutes past H + period word" frame stays unambiguous either way.
     *
     * Style selection comes from the global stupid_ai_engine switch (AI section of
     * automaton.yaml, resolved via isStupidAiEngine()): only an explicit false selects
     * the bundle's "smart" subtree ({% time %} left for the model to spell out in words);
     * anything else -- true or absent -- keeps the pre-rendered digit frame ("explicit").
     * Within a style, #pickTimeTemplate() chooses the variant matching the clock fraction
     * with fallback to its default entry. Clock tokens are pre-resolved from `now` via
     * the specialValues mechanism so rendering is deterministic per instant.
     *
     * Exposed without the # prefix so unit tests can verify rendering and i18n degradation
     * without MQTT or AI providers; execute() is the sole production caller. The optional
     * bundle parameter lets tests inject synthetic bundles without touching private state.
     *
     * @param {Date} [now=new Date()] - Moment to render
     * @param {Record<string, unknown>|null} [bundle=this.#bundle] - Weatherman i18n bundle
     * @returns {string} Interpolated opening line, or '' when nothing applicable exists
     */
    buildTimeSentence(now = new Date(), bundle = this.#bundle) {
        const tree = bundle?.time_sentence
        if (!tree || typeof tree !== 'object') return ''

        // Global weak-model switch: only an explicit false opts into legacy "model spells
        // out the hour" behaviour; anything else keeps the digit frame -- fail-safe for tiny models.
        const style = this.isStupidAiEngine() ? 'explicit' : 'smart'
        const variants = tree[style]
        if (!variants || typeof variants !== 'object') return ''

        const tpl = this.#pickTimeTemplate(variants, now)
        if (!tpl) return ''

        const period = temporal.getCurrentTimePeriod(now)
        const words = bundle.period_words ?? {}
        const h24 = now.getHours()
        return this.#interpolate(tpl, null, {
            hours: String(I18nLoader.is12HourFormat() ? ((h24 + 11) % 12) + 1 : h24),
            minutes: String(now.getMinutes()),
            time_of_day: (period && words[period]) || period || '',
        })
    }


    // -- Private Helpers ----------------------------------------------------

    /**
     * Pick the variant template for a moment within one style subtree of
     * bundle.time_sentence. Exact clock fractions win when their locale-specific
     * template exists (:00 -> exact_hour; :30/:15/:45 -> half_past/quarter_to/quarter_past
     * -- reserved hooks for future i18n templates, none shipped yet); otherwise fall back
     * to the generic default entry. Returns '' when nothing usable is present so callers
     * can skip the opening line gracefully.
     * @param {Record<string, unknown>} variants - Style subtree under bundle.time_sentence
     * @param {Date} now - Moment to evaluate
     * @returns {string} Chosen raw (uninterpolated) template, or ''
     */
    #pickTimeTemplate(variants, now) {
        const m = now.getMinutes()
        let key = null
        if (m === 0)          key = 'exact_hour'
        else if (m === 30)    key = 'half_past'
        else if (m === 15)    key = 'quarter_past'
        else if (m === 45)    key = 'quarter_to'
        return typeof variants[key] === 'string' ? variants[key]
             : typeof variants.default === 'string' ? variants.default
             : ''
    }

    /**
     * Load the weatherman i18n bundle from etc/i18n/{locale}/weatherman.yaml.
     * Falls back to pl_PL if not found.
     * @returns {Record<string, unknown>|null}
     */
    #loadWeathermanBundle() {
        const locale = I18nLoader.getLanguage()
        const LOCALE_MAP = { pl: 'pl_PL', en: 'en_US' }
        const localeDir = LOCALE_MAP[locale] || 'pl_PL'
        const filePath = path.join(I18N_ROOT, localeDir, 'weatherman.yaml')

        try {
            if (!fs.existsSync(filePath)) {
                this.log(`Weatherman i18n file not found: ${filePath}`, 'warn')
                return null
            }
            const doc = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            const data = doc.contents?.toJSON()
            if (!data || typeof data !== 'object') {
                this.log(`Invalid weatherman i18n format in ${filePath}`, 'error')
                return null
            }
            return data
        } catch (error) {
            this.log(`Failed to load weatherman bundle: ${error.message}`, 'error')
            return null
        }
    }

    /**
     * Resolve a dotted i18n key against the loaded weatherman bundle.
     * Example: 'weatherman.warning_apocalypse' -> bundle['warning_apocalypse']
     * The first segment ('weatherman') is stripped as the namespace prefix.
     * @param {string} key - Dot-separated key (e.g., "weatherman.base")
     * @param {*} fallback - Default value if key not found
     * @returns {*|null}
     */
    #resolveI18n(key, fallback) {
        if (!this.#bundle || !key) return fallback
        // Strip the namespace prefix (first segment before dot)
        const parts = key.split('.')
        if (parts.length < 2) return this.#bundle[key] ?? fallback
        // Skip first part (namespace), resolve rest
        let current = this.#bundle
        for (let i = 1; i < parts.length; i++) {
            if (current == null || typeof current !== 'object') return fallback
            current = current[parts[i]]
        }
        return current !== undefined ? current : fallback
    }

    /**
     * Replace {{ DeviceName.property }} placeholders with live sensor data,
     * and {% keyword %} placeholders with locale-aware values (e.g., {% time %},
     * or {% next_interval %} when a pre-resolved value is supplied via specialValues).
     * If device or property not found, replaces with INTERPOLATION_MISSING.
     * @param {string} text - Template string with placeholders
     * @param {Object} [_context] - Unused context param (kept for signature compat)
     * @param {Record<string, string>} [specialValues] - Pre-resolved values for extra
     *   {% keyword %} placeholders; keywords without an entry pass through unchanged
     * @returns {string} Text with all placeholders resolved
     */
    #interpolate(text, _context, specialValues = {}) {
        // First resolve special-function placeholders like {% time %}.
        let result = text.replace(TIME_INTERPOLATION_REGEX, (_match, keyword) => {
            if (keyword === 'time') return I18nLoader.formatTime()
            return specialValues[keyword] ?? `{% ${keyword} %}`   // unknown -> pass through unchanged
        })

        // Then resolve device-property placeholders
        return result.replace(INTERPOLATION_REGEX, (_match, deviceName, property) => {
            try {
                const trimmedName = deviceName.trim()
                const trimmedProp = property.trim()
                const device = DeviceContainer.findByName(trimmedName)
                if (!device) {
                    this.log(`Interpolation: device "${trimmedName}" not found`, 'debug')
                    return INTERPOLATION_MISSING
                }
                const state = device.getStateLast()
                if (!state || state[trimmedProp] === undefined || state[trimmedProp] === null) {
                    this.log(`Interpolation: property "${trimmedProp}" missing on "${trimmedName}"`, 'debug')
                    return INTERPOLATION_MISSING
                }
                // Format numbers using I18nLoader's locale-aware formatter with rounding
                if (typeof state[trimmedProp] === 'number') {
                    return I18nLoader.formatNumber(round(state[trimmedProp]))
                }
                return String(state[trimmedProp])
            } catch (error) {
                this.log(`Interpolation error for "{{ ${deviceName}.${property} }}": ${error.message}`, 'warn')
                return INTERPOLATION_MISSING
            }
        })
    }

    /**
     * Send the built message to TTS, optionally routing through AI first. When the AI
     * handles it, day-position markers frame the core content via buildAiPrompt().
     * @param {string} message - Final interpolated speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     *   Day position computed by {@link computeDayPosition}
     */
    async #speak(message, meta = {}) {
        const trimmedMessage = message.trim()
        if (!trimmedMessage) {
            this.log('Empty message after building, skipping TTS', 'debug')
            return
        }

        this.log(`Sending weather update (${trimmedMessage.length} chars)`, 'info')

        // Build the full prompt BEFORE any emissions, so Window 3 sees exactly
        // what will be sent to the AI (creative prefix and day-position markers included).
        let displayText = trimmedMessage
        let aiPrompt = trimmedMessage

        if (AiAssistant.isAvailable()) {
            const fullPrompt = this.buildAiPrompt(trimmedMessage, meta)
            if (fullPrompt !== trimmedMessage) {
                aiPrompt = fullPrompt
                displayText = fullPrompt   // UI shows the full prompt including prefix/markers
            }
        }

        // Emit system input to UI with the actual text that goes into the LLM.
        // Guard against --no-ui runs where no subscribers exist.
        if (EventBus.hasSubscribers('ai:systemMessage')) {
            EventBus.emit('ai:systemMessage', { text: displayText })
        }

        if (AiAssistant.isAvailable()) {

            try {
                const response = await AiAssistant.processMessage(aiPrompt, {
                    origin: ChatMessageOrigin.SYSTEM
                })

                // Emit the AI's response back to UI for rendering with <AI> prefix.
                // Guard against --no-ui runs where no subscribers exist.
                if (response && EventBus.hasSubscribers('ai:periodicResponse')) {
                    EventBus.emit('ai:periodicResponse', { text: response })
                }

                this.log('Weather update sent via AI -> TTS pipeline', 'debug')
            } catch (error) {
                this.log(`AI processing failed: ${error.message}`, 'error')
                // Fallback to direct TTS on AI failure
                EventBus.emit('tts:speak', { text: trimmedMessage })
            }
        } else {
            // Direct TTS when AI unavailable
            EventBus.emit('tts:speak', { text: trimmedMessage })
            this.log('Weather update sent via direct TTS', 'debug')
        }
    }

    /**
     * Epoch ms of the most recent past occurrence of the silence-window END boundary --
     * i.e., the moment the current announcement session began ("wake-up"). For a normal
     * window like "0230-1030" at 15:00 this is today's 10:30; at 01:45 it is yesterday's.
     * Note: local-midnight arithmetic assumes a 24 h day (DST transitions shift results
     * by an hour for runs near midnight on those days -- acceptable for speech markers).
     * @param {{startMin: number, endMin: number}} win - Parsed silence window
     * @param {Date} now - Reference moment (assumed outside the silent window)
     * @returns {number} Epoch milliseconds
     */
    #sessionBeganAt(win, now) {
        const DAY_MS = 86_400_000
        let epoch = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + win.endMin * 60_000
        if (epoch > now.getTime()) epoch -= DAY_MS   // today's wake-up hasn't happened yet -> yesterday's
        return epoch
    }

    /**
     * Epoch ms of the next upcoming occurrence of the silence-window START boundary --
     * i.e., the moment the current announcement session will end ("sleep"). For a normal
     * window like "0230-1030" this is tonight's/tomorrow's 02:30 depending on the clock.
     * Same DST caveat as {@link #sessionBeganAt}.
     * @param {{startMin: number, endMin: number}} win - Parsed silence window
     * @param {Date} now - Reference moment (assumed outside the silent window)
     * @returns {number} Epoch milliseconds
     */
    #sessionEndsAt(win, now) {
        const DAY_MS = 86_400_000
        let epoch = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + win.startMin * 60_000
        if (epoch <= now.getTime()) epoch += DAY_MS  // today's sleep already passed -> tomorrow's
        return epoch
    }
}