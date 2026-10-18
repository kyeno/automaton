/**
 * TTS WeatherMan Automation.
 * Rule-based weather announcer that builds a speech message from a base sentence.
 * and condition-matched additions, then routes through AI -> TTS pipeline.
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
import DeviceContainer from '../../src/device/container/deviceContainer.js'
import EventBus from '../../src/service/eventBus.js'
import I18nLoader from '../../src/service/i18nLoader.js'
import TtsService from '../../src/service/ttsService.js'
import AiAssistant from '../../src/ai/aiAssistant.js'
import ChatMessageOrigin from '../../src/enum/aiChatMessageOrigin.js'
import { PROJECT_ROOT } from '../../src/lib/projectRoot.js'
import { round } from '../../src/lib/math.js'
import { interpolateTokens } from '../../src/lib/string.js'
import { readRandomLine } from '../../src/lib/randomLine.js'
import TtsProfiles from '../../src/lib/ttsProfiles.js'
import DatabaseService from '../../src/service/databaseService.js'
import { countedUnit } from '../../src/lib/polish.js'
import temporal from '../../src/lib/date.js'


/** Path to this automation's YAML config file. */
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-weatherman.yaml')

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Per-locale proverb list -- one proverb per line, drawn when add_proverb is true. */
const PROVERBS_FILENAME = 'proverbs.txt'

/** Line prefix treated as a comment in the proverb file (header docs are not proverbs). */
const PROVERBS_COMMENT_CHAR = '#'

/** Fallback text when a device or property is not found during interpolation. */
const INTERPOLATION_MISSING = 'N/A'

/** Regex to match {{ DeviceName.property }} placeholders in i18n strings. */
const INTERPOLATION_REGEX = /\{\{\s*([\w\s]+?)\.([\w]+)\s*\}\}/g

/** Scan horizon when predicting the next non-silent tick -- two days exceeds any sane config. */
const NEXT_ANNOUNCEMENT_HORIZON_MS = 48 * 3600 * 1000


export default class TtsWeatherManAutomation extends RuleBasedAutomationBase {

    /** @type {Record<string, unknown>|null} Cached weatherman i18n bundle */
    #bundle = null

    /** Fixed identity constructor -- name and config path are constants of this automation. */
    constructor() {
        super({ name: 'TtsWeatherManAutomation', configPath: CONFIG_PATH })
    }

    /** Lifecycle hook -- loads the weatherman i18n bundle once on top of the base init; */
    async init() {
        await super.init()
        this.#bundle = this.#loadWeathermanBundle()
    }

    //  -- Public API (override template method) ------------------------------

    /** Custom execute that builds a speech message and sends it to TTS.
     * @param {{trigger?: string, force?: boolean, forceFirst?: boolean}|null} [triggerData] - */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        this.log(`Triggered by: ${triggerSource}`, 'info')

        //  Off-guard: if neither the AI pipeline nor the TTS server is available there.
        if (!AiAssistant.isAvailable() && !TtsService.isEnabled()) {
            this.log('Both AI and TTS unavailable -- skipping weather run', 'debug')
            return
        }

        //  Suppress execution during configured silent period (before any work begins)
        if (this.isInSilentPeriod()) {
            if (triggerData?.force === true) {
                this.log(`Forced run -- silent period bypassed (${triggerSource})`, 'info')
            } else {
                this.log(
                    `Suppressed during silent period (${triggerSource})`,
                    'debug'
                )
                return
            }
        }

        //  Stand down while a configured player is actively playing -- do not interrupt an active.
        if (await this.isVideoPlayerSuppressionActive()) {
            this.log(`Suppressed by video_player_suppression (${triggerSource})`, 'debug')
            return
        }

        //  Reload bundle fresh each run (interpolation is runtime, not cached)
        this.#bundle = this.#loadWeathermanBundle()
        if (!this.#bundle) {
            this.log('No weatherman i18n bundle loaded, skipping', 'warn')
            return
        }

        //  Build context for condition evaluation (reuses parent logic)
        let context
        try {
            context = await this.buildContext()
        } catch (error) {
            this.log(`Context build failed: ${error.message}`, 'warn')
            return
        }

        //  One shared clock instant per run -- the opening time line and the day-position.
        const now = new Date()

        //  Day position (first/last/only/next + first-of-day) computed once.
        const meta = this.computeDayPosition(now)
        //  Debug poke: a forced "first" run (e.g. "/automation force <name> first") pretends.
        if (triggerData?.forceFirst === true) {
            meta.isFirst = true
            this.log(`Forced first-of-day day-position (${triggerSource})`, 'info')
        }
        if (meta.isFirst || meta.isLast || meta.isFirstOfDay || meta.nextIntervalMs != null) {
            this.log(
                `Day position: first=${meta.isFirst}, last=${meta.isLast}, firstOfDay=${meta.isFirstOfDay}` +
                (meta.nextIntervalMs != null ? `, next in ${temporal.millisecondsToHumanReadable(meta.nextIntervalMs)}` : ''),
                'debug'
            )
        }

        //  Opening time-of-day line rendered BEFORE the base sentence on both output paths.
        const timeLine = this.buildTimeSentence(now, this.#bundle, meta)

        //  Start with base sentence + interpolate sensor data.
        const baseKey = this.config.sentence_base
        let baseText = this.#resolveI18n(baseKey, '')
        if (!baseText) {
            this.log(`Base sentence key "${baseKey}" not found in bundle`, 'warn')
            return
        }
        if (timeLine && /{%\s*time\s*%}/.test(baseText)) {
            this.log('Base sentence still contains {% time %}; the opening line already states the time -- consider removing it from your base template', 'debug')
        }
        const history = this.buildHistoryTokens(now.getTime())
        const baseMessage = this.#interpolate(baseText, context, history)
        let message = timeLine ? `${timeLine} ${baseMessage}` : baseMessage

        //  Evaluate all rules, collect matches, then pick highest priority winner.
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
            //  Sort descending by priority; stable sort preserves YAML order for ties.
            winners.sort((a, b) => b.priority - a.priority)
            const best = winners[0]

            //  Log suppressed lower-priority rules for debugging.
            if (winners.length > 1) {
                const losers = winners.slice(1).map(
                    w => `"${w.rule.name}" (p=${w.priority})`
                ).join(', ')
                this.log(
                    `Multiple rules matched (${winners.length}), "${best.rule.name}" wins with priority ${best.priority}. Suppressed: ${losers}`,
                    'debug'
                )
            }

            //  Append only the winner's sentence.
            if (best.rule.sentence) {
                const ruleText = this.#resolveI18n(best.rule.sentence, '')
                if (ruleText) {
                    const interpolated = this.#interpolate(ruleText, context, history)
                    message += ' ' + interpolated
                    this.log(`Rule matched: "${best.rule.name}" -> appended sentence`, 'debug')
                }
            }
        }

        //  Route output through AI->TTS or direct TTS.
        await this.#speak(message, meta)
    }

    /** Localized history clauses from adjacent time-weighted SQL windows.
     * Current readings remain live values; deltas explicitly describe window means.
     * @param {number} [now=Date.now()] - Shared report instant in epoch milliseconds.
     * @returns {Record<string, string>} Optional temperature/humidity/pressure history tokens. */
    buildHistoryTokens(now = Date.now()) {
        const tokens = { temperature_history: '', humidity_history: '', pressure_history: '' }
        const history = this.config.history ?? {}
        if (history.enabled === false) return tokens
        const windowMs = temporal.parseDurationMs(history.window ?? '1h')
        const maxGap = temporal.parseDurationMs(history.max_gap ?? '30m')
        const coverage = history.min_coverage ?? 0.8
        if (!(windowMs > 0) || !(maxGap > 0) || !Number.isFinite(coverage) || coverage <= 0 || coverage > 1) return tokens
        const tolerances = { temperature: 0.2, humidity: 2, pressure: 0.5, ...history.tolerances }
        for (const metric of Object.keys(tokens).map((key) => key.replace('_history', ''))) {
            const device = this.config.sensors?.[metric]
            const tolerance = tolerances[metric]
            if (typeof device !== 'string' || !Number.isFinite(tolerance) || tolerance < 0) continue
            const query = (from, to) => DatabaseService.sensorWindowStats({ device, property: metric, from, to, maxGap })
            const recent = query(now - windowMs, now)
            const earlier = query(now - 2 * windowMs, now - windowMs)
            if (![recent, earlier].every((stats) => stats && Number.isFinite(stats.mean) && stats.coverageMs >= windowMs * coverage)) continue
            // Historical coverage alone does not establish a fresh current observation.
            if (!Number.isFinite(recent.latestAt) || now - recent.latestAt > maxGap || recent.latestAt > now) continue
            const delta = round(recent.mean - earlier.mean)
            const direction = Math.abs(delta) <= tolerance ? 'stable' : delta > 0 ? 'rising' : 'falling'
            const template = this.#resolveI18n(`weatherman.history.${metric}.${direction}`, '')
            if (typeof template !== 'string' || !template) continue
            const mean = round(recent.mean)
            const difference = round(Math.abs(delta))
            const unit = (kind, value) => {
                const forms = this.#resolveI18n(`weatherman.history.${metric}.units.${kind}`, [])
                return /^pl(?:_|-|$)/i.test(I18nLoader.getLocale()) ? countedUnit(value, forms) : forms[value === 1 ? 0 : 2] ?? ''
            }
            tokens[`${metric}_history`] = this.#interpolate(template, null, {
                mean: I18nLoader.formatNumber(mean),
                delta: I18nLoader.formatNumber(difference),
                mean_unit: unit('mean', mean),
                delta_unit: unit('delta', difference),
                window: temporal.getSpeechDuration(windowMs, 'genitive') ?? temporal.millisecondsToHumanReadable(windowMs),
            })
        }
        return tokens
    }

    /** No device targets for this automation -- returns empty Map so parent
     * @returns {Map<string, never>} */
    loadDevices() {
        return new Map()
    }

    /** Not used by ttsWeatherman (no device commands). Required abstract method.
     * @param {Object|null} _device - Unused in this override (kept for signature parity)
     * @param {string} _targetKey - Unused in this override
     * @param {Array<Object>} _matchingRules - Unused in this override
     * @returns {null} */
    resolveCommand(_device, _targetKey, _matchingRules) {
        return null
    }

    /** Compute where an announcement sits within its daily "session" -- the continuous.
     * @param {Date} [now=new Date()] - Moment to evaluate
     * @returns {{isFirst: boolean, isLast: boolean, isFirstOfDay: boolean, nextIntervalMs: number|null}} */
    computeDayPosition(now = new Date()) {
        const result = { isFirst: false, isLast: false, isFirstOfDay: false, nextIntervalMs: null }

        const intervalMs = this.getTimerIntervalMs()
        if (!(intervalMs > 0)) return result            // event-driven only -- nothing periodic to predict

        // "First run of the day": within one interval of local midnight.
        const midnight = new Date(now)
        midnight.setHours(0, 0, 0, 0)
        result.isFirstOfDay = (now.getTime() - midnight.getTime()) < intervalMs

        if (this.isInSilentPeriodAt(now)) return result // defensive: markers are meaningless mid-silence

        // Next announcement = first upcoming tick outside the silent window.
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

    /** Assemble the ordered day-position speech segments for a run -- an optional single.
     * @private
     * @param {string} message - Interpolated core speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     * @param {string} [proverbKey] - i18n key for the proverb line, per output path
     * @returns {string[]} Ordered segments (message always present) */
    #speechSegments(message, meta = {}, proverbKey) {
        const parts = []

        //  Opening day-position marker -- exactly one of first / last / only applies per run.
        let openerKey = null
        if (meta.isFirst && meta.isLast)      openerKey = 'weatherman.ai_message_only'
        else if (meta.isFirst)                openerKey = 'weatherman.ai_message_first'
        else if (meta.isLast)                 openerKey = 'weatherman.ai_message_last'
        if (openerKey) {
            const opener = this.#interpolate(this.#resolveI18n(openerKey, ''))
            if (opener) parts.push(opener)
        }

        parts.push(message)

        //  Proverb -- directly after the report body, ahead of the next-update closer.
        const proverb = this.#buildProverbSegment(proverbKey)
        if (proverb) parts.push(proverb)

        //  Closing "next update" line -- every run except the last, when a next tick is known.
        if (!meta.isLast && typeof meta.nextIntervalMs === 'number' && meta.nextIntervalMs > 0) {
            const template = this.#resolveI18n('weatherman.ai_message_next', '')
            const phrase = temporal.getSpeechDuration(meta.nextIntervalMs, 'accusative')
            if (template && phrase) {
                parts.push(this.#interpolate(template, null, { next_interval: phrase }))
            }
        }

        return parts
    }

    /** Assemble the full prompt sent to the AI for a weather update. Layout: creative prefix.
     * @param {string} message - Interpolated core speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     * @returns {string} Full AI prompt (creative prefix + day-position markers + core message) */
    buildAiPrompt(message, meta = {}) {
        //  The AI leg gets the instruction phrasing: the model reads it as a direction.
        const segments = this.#speechSegments(message, meta, 'weatherman.ai_proverb')
        const body = segments.join('\n')          // keep the newline layout the model expects

        //  Creative instruction prefix (existing behaviour). Only the AI leg carries it --
        const aiPrefixKey = this.config.sentence_ai_prefix
        if (aiPrefixKey && this.#bundle) {
            const prefixText = this.#resolveI18n(aiPrefixKey, '')
            if (prefixText) return `${prefixText}\n${body}`
        }

        return body
    }

    /** Plain-speech text for the direct-TTS path (AI unavailable). Includes every day-position.
     * @param {string} message - Interpolated core speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     * @returns {string} Speech text with markers (no ai_prefix) */
    buildDirectTtsText(message, meta = {}) {
        //  Direct TTS gets the spoken phrasing -- there is no model to obey an instruction.
        const segments = this.#speechSegments(message, meta, 'weatherman.tts_proverb')
        return segments.join(' ').trim()
    }

    /** Build the validated extra-TTS-server-parameters object for this automation's.
     * @param {Record<string, unknown>} [rawConfig=this.config] - Config source to read from
     * @returns {{intro?: string, outro?: string, intro_spacing?: number}} Validated options (possibly empty) */
    resolveTtsOptions(rawConfig = this.config) {
        return TtsProfiles.resolve(rawConfig, (message) => this.log(message, 'warn'))
    }

    /** Render the opening time-of-day line for a weather update, or '' when no applicable.
     * @param {Date} [now=new Date()] - Moment to render
     * @param {Record<string, unknown>|null} [bundle=this.#bundle] - Weatherman i18n bundle
     * @param {{isFirst?: boolean, isFirstOfDay?: boolean}} [meta] - Day position from
     * @returns {string} Interpolated opening line, or '' when nothing applicable exists */
    buildTimeSentence(now = new Date(), bundle = this.#bundle, meta = {}) {
        const tree = bundle?.time_sentence
        if (!tree || typeof tree !== 'object') return ''

        //  Dated runs (first of the day / first of the session) fuse the calendar date.
        const dated = Boolean(meta?.isFirst || meta?.isFirstOfDay)
        const tpl = this.#pickTimeTemplate(tree, now, dated)
        if (!tpl) return ''

        const period = temporal.getCurrentTimePeriod(now)
        //  Day-period words come from the date bundle (date.yaml) -- all date/time.
        const words = temporal.getPeriodWords()
        const h24 = now.getHours()
        return this.#interpolate(tpl, null, {
            date: dated ? this.#buildDateFragment(now) : '',
            hours: String(I18nLoader.is12HourFormat() ? ((h24 + 11) % 12) + 1 : h24),
            minutes: String(now.getMinutes()),
            //  Spoken clock words when the locale's language can generate them (pl_PL:
            //  "szósta osiemnaście"); the digit clock otherwise, so a template never loses it.
            time_words: temporal.getClockWords(now) || temporal.formatClockTime(now),
            time_of_day: (period && words[period]) || period || '',
        })
    }

    /** Render the localized calendar-date fragment (e.g. "wtorek, 1 września 2026 roku")
     * @private
     * @param {Date} now - Moment to render
     * @returns {string} Interpolated date fragment, or '' when the bundle has no template */
    #buildDateFragment(now) {
        const template = temporal.loadDateBundle()?.date_sentence
        if (!template || typeof template !== 'string') return ''
        return this.#interpolate(template, null, temporal.getDateParts(now))
    }


    //  -- Private Helpers ----------------------------------------------------

    /** Build the closing proverb segment, or '' when it should not be spoken.
     * @private
     * @param {string} [proverbKey] - i18n key to resolve, e.g. 'weatherman.ai_proverb'
     * @returns {string} Interpolated proverb line, or '' when unavailable */
    #buildProverbSegment(proverbKey) {
        if (!proverbKey || this.config?.add_proverb !== true) return ''

        const template = this.#resolveI18n(proverbKey, '')
        if (!template) {
            this.log(`add_proverb is on but "${proverbKey}" is missing from the bundle`, 'warn')
            return ''
        }

        const filePath = path.join(I18N_ROOT, I18nLoader.getLocale(), PROVERBS_FILENAME)
        //  readRandomLine streams the file -- it is never loaded whole, so an oversized.
        const proverb = readRandomLine(filePath, { commentChar: PROVERBS_COMMENT_CHAR })
        if (!proverb) {
            this.log(`add_proverb is on but no proverb could be read from ${filePath}`, 'warn')
            return ''
        }

        return this.#interpolate(template, null, { proverb })
    }

    /** Pick the variant template for a moment within bundle.time_sentence.
     * @private
     * @param {Record<string, unknown>} variants - The bundle.time_sentence object
     * @param {Date} now - Moment to evaluate
     * @param {boolean} [dated=false] - Whether this is a dated run (first of day/session)
     * @returns {string} Chosen raw (uninterpolated) template, or '' */
    #pickTimeTemplate(variants, now, dated = false) {
        const m = now.getMinutes()
        let suffix = null
        if (m === 0)          suffix = 'exact_hour'
        else if (m === 30)    suffix = 'half_past'
        else if (m === 15)    suffix = 'quarter_past'
        else if (m === 45)    suffix = 'quarter_to'

        //  Priority: dated-specific -> dated default -> plain specific -> plain default.
        const candidates = []
        if (dated && suffix) candidates.push(`dated_${suffix}`)
        if (dated)            candidates.push('dated')
        if (suffix)           candidates.push(suffix)
        candidates.push('default')

        for (const key of candidates) {
            if (typeof variants[key] === 'string') return variants[key]
        }
        return ''
    }

    /** Load the weatherman i18n bundle from etc/i18n/{locale}/weatherman.yaml.
     * @private
     * @returns {Record<string, unknown>|null} */
    #loadWeathermanBundle() {
        const localeDir = I18nLoader.getLocale()
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

    /** Resolve a dotted i18n key against the loaded weatherman bundle.
     * @private
     * @param {string} key - Dot-separated key (e.g., "weatherman.base")
     * @param {*} fallback - Default value if key not found
     * @returns {*|null} */
    #resolveI18n(key, fallback) {
        if (!this.#bundle || !key) return fallback
        //  Strip the namespace prefix (first segment before dot)
        const parts = key.split('.')
        if (parts.length < 2) return this.#bundle[key] ?? fallback
        //  Skip first part (namespace), resolve rest.
        let current = this.#bundle
        for (let i = 1; i < parts.length; i++) {
            if (current == null || typeof current !== 'object') return fallback
            current = current[parts[i]]
        }
        return current !== undefined ? current : fallback
    }

    /** Replace {{ DeviceName.property }} placeholders with live sensor data.
     * @private
     * @param {string} text - Template string with placeholders
     * @param {Object} [_context] - Unused context param (kept for signature compat)
     * @param {Record<string, string>} [specialValues] - Pre-resolved values for extra
     * @returns {string} Text with all placeholders resolved */
    #interpolate(text, _context, specialValues = {}) {
        //  First resolve special-function placeholders like {% time %} through the shared.
        let result = interpolateTokens(text, { ...specialValues, time: I18nLoader.formatTime() })

        //  Then resolve device-property placeholders.
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
                //  Format numbers using I18nLoader's locale-aware formatter with rounding.
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

    /** Send the built message to TTS, optionally routing through AI first.
     * @private
     * @param {string} message - Final interpolated speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta] */
    async #speak(message, meta = {}) {
        const trimmedMessage = message.trim()
        if (!trimmedMessage) {
            this.log('Empty message after building, skipping TTS', 'debug')
            return
        }

        this.log(`Sending weather update (${trimmedMessage.length} chars)`, 'info')

        //  Optional per-utterance TTS server params from tts_options.
        const ttsOptions = this.resolveTtsOptions()
        await this.routeReport(trimmedMessage, meta, ttsOptions)
    }

    /** Pipeline decision for a fully-built report: rewrite via AI before TTS when `use_ai`
     * @param {string} trimmedMessage - Plain core speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} ttsOptions - Jingle passthrough options */
    async routeReport(trimmedMessage, meta = {}, ttsOptions = {}) {
        const aiEnabled = this.config?.use_ai !== false
        const useAi = aiEnabled && AiAssistant.isAvailable()

        if (!aiEnabled) {
            this.log('use_ai disabled in config -- speaking directly', 'debug')
        } else if (!useAi) {
            this.log('AI assistant unavailable -- speaking directly', 'debug')
        }

        //  The text shown in Window 3 must match what is actually heard. On the AI leg.
        const spokenText = useAi
            ? this.buildAiPrompt(trimmedMessage, meta)
            : this.buildDirectTtsText(trimmedMessage, meta)

        //  Emit system input to UI with the exact text that will be heard.
        if (EventBus.hasSubscribers('ai:systemMessage')) {
            EventBus.emit('ai:systemMessage', { text: spokenText })
        }

        if (useAi) {
            await this.routeThroughAi(spokenText, trimmedMessage, ttsOptions, meta)
        } else {
            //  Direct TTS when AI is off/unavailable: speak every day-position marker minus.
            EventBus.emit('tts:speak', { text: spokenText, ...ttsOptions })
            this.log('Weather update sent via direct TTS', 'debug')
        }
    }

    /** Send one built weather report through the AI -> TTS pipeline with graceful.
     * @param {string} aiPrompt - Full prompt sent to the model (prefix/markers included)
     * @param {string} trimmedMessage - Plain core text used for the direct-TTS fallback
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} ttsOptions - Jingle passthrough options
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta] */
    async routeThroughAi(aiPrompt, trimmedMessage, ttsOptions, meta = {}) {
        let spoken = ''
        try {
            const response = await AiAssistant.processMessage(aiPrompt, {
                origin: ChatMessageOrigin.SYSTEM,
                tts: ttsOptions
            })
            spoken = typeof response === 'string' ? response.trim() : ''
        } catch (error) {
            this.log(`AI processing failed: ${error.message}`, 'error')
            return this.#degradeToRawTts(trimmedMessage, ttsOptions, error.message, meta)
        }

        if (!spoken) {
            //  Model answered with nothing usable -- nothing was spoken yet; degrade loudly.
            this.log('AI reply was empty -- falling back to direct TTS', 'warn')
            return this.#degradeToRawTts(trimmedMessage, ttsOptions, 'empty reply from model', meta)
        }

        //  Emit the AI's response back to UI for rendering with <AI> prefix.
        if (EventBus.hasSubscribers('ai:periodicResponse')) {
            EventBus.emit('ai:periodicResponse', { text: spoken })
        }
        this.log(`Weather update sent via AI -> TTS pipeline (${spoken.length} chars)`, 'debug')
    }

    /** Fallback leg of routeThroughAi(): post a visible <system> notice explaining.
     * @private
     * @param {string} trimmedMessage - Plain core text to speak
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} ttsOptions - Jingle passthrough options
     * @param {string} reason - Failure description kept in the log trail
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta] */
    #degradeToRawTts(trimmedMessage, ttsOptions, reason, meta = {}) {
        const notice = this.#resolveI18n('weatherman.ai_fallback_notice', '') ||
            'The assistant did not answer in time -- reading the plain report instead.'
        if (EventBus.hasSubscribers('ai:systemMessage')) {
            EventBus.emit('ai:systemMessage', { text: notice })
        }
        //  Fallback to direct TTS on AI failure -- speak the same day-position markers.
        EventBus.emit('tts:speak', { text: this.buildDirectTtsText(trimmedMessage, meta), ...ttsOptions })
        this.log(`Weather update fell back to direct TTS (${reason})`, 'debug')
    }

    /** Epoch ms of the most recent past occurrence of the silence-window END boundary --
     * @private
     * @param {{startMin: number, endMin: number}} win - Parsed silence window
     * @param {Date} now - Reference moment (assumed outside the silent window)
     * @returns {number} Epoch milliseconds */
    #sessionBeganAt(win, now) {
        const DAY_MS = 86_400_000
        let epoch = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + win.endMin * 60_000
        if (epoch > now.getTime()) epoch -= DAY_MS   // today's wake-up hasn't happened yet -> yesterday's
        return epoch
    }

    /** Epoch ms of the next upcoming occurrence of the silence-window START boundary --
     * @private
     * @param {{startMin: number, endMin: number}} win - Parsed silence window
     * @param {Date} now - Reference moment (assumed outside the silent window)
     * @returns {number} Epoch milliseconds */
    #sessionEndsAt(win, now) {
        const DAY_MS = 86_400_000
        let epoch = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + win.startMin * 60_000
        if (epoch <= now.getTime()) epoch += DAY_MS  // today's sleep already passed -> tomorrow's
        return epoch
    }
}