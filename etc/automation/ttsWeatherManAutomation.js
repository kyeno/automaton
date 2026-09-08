/**
 * TTS WeatherMan Automation.
 * Rule-based weather announcer that builds a speech message from a base sentence
 * and condition-matched additions, then routes through AI -> TTS pipeline (or
 * direct TTS if AI unavailable). Supports {{ DeviceName.property }} string
 * interpolation for live sensor data in i18n strings. Optional tts_options config entries
 * (intro/outro wave files, intro_spacing) are forwarded verbatim into the TTS server request
 * via the 'tts:speak' EventBus payload -- on both output paths -- so only this automation's
 * utterances carry them; see resolveTtsOptions().
 *
 * When routing through AI, day-position markers derived purely from clock + config
 * (no stored state) frame the core content: an opening line marks the first / last /
 * only announcement of each daily session (the stretch between two silence windows),
 * while "next update in {% next_interval %}" now closes every run except the last (first/middle runs included), not just middle-of-session runs.
 *
 * An opening time-of-day line is rendered before the base sentence on both output
 * paths; its clock parts are pre-rendered as plain digits so tiny models never have
 * to convert a clock string into words.
 *
 * On the first run of the day (within one interval of local midnight) and on the
 * first run of each daily session (after a silence window), the calendar date is
 * fused into that opening line via the {% date %} token -- e.g. "Jest wtorek,
 * 1 września 2026 roku, 32 minut po godzinie 9 w nocy." The date is pre-rendered,
 * so a weak model never has to convert it. The date vocabulary (day/month names,
 * period words, duration units) lives in the per-locale date.yaml bundle owned by
 * the date helper, not in this bundle.
 *
 * If neither the AI pipeline nor the TTS server is available the run is skipped
 * entirely (no output channel); a run with exactly one of the two still proceeds.
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
import EventBus from '../../src/service/eventBus.js'
import I18nLoader from '../../src/service/i18nLoader.js'
import TtsService from '../../src/service/ttsService.js'
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

    /**
     * Fixed identity constructor -- name and config path are constants of this automation.
     */
    constructor() {
        super({ name: 'TtsWeatherManAutomation', configPath: CONFIG_PATH })
    }

    /**
     * Lifecycle hook -- loads the weatherman i18n bundle once on top of the base init;
     * execute() re-reads it fresh per run so interpolation always sees current values.
     */
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
     * @param {{trigger?: string, force?: boolean, forceFirst?: boolean}|null} [triggerData] -
     *   Trigger info; force:true bypasses the silent-period suppression below, and
     *   forceFirst:true forces the first-of-day day-position (dated opening time line)
     */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        this.log(`Triggered by: ${triggerSource}`, 'info')

        // Off-guard: if neither the AI pipeline nor the TTS server is available there is
        // no output channel for the report -- skip the run entirely (no context build, no
        // device reads, no log spam) rather than assembling a message that can only be
        // dropped. A run with exactly one of the two available still proceeds: AI-only
        // runs are rewritten and voiced by the assistant, TTS-only runs speak directly.
        if (!AiAssistant.isAvailable() && !TtsService.isEnabled()) {
            this.log('Both AI and TTS unavailable -- skipping weather run', 'debug')
            return
        }

        // Suppress execution during configured silent period (before any work begins),
        // unless explicitly forced from outside (e.g., "/automation force")
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

        // Stand down while a configured player is actively playing -- do not interrupt an active
        // movie with weather chatter. WeatherMan overrides execute(), so apply the same
        // video_player_suppression gate here that the parent's shared flow would otherwise run;
        // like the parent, this is NOT bypassed by a forced run.
        if (await this.isVideoPlayerSuppressionActive()) {
            this.log(`Suppressed by video_player_suppression (${triggerSource})`, 'debug')
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

        // Day position (first/last/only/next + first-of-day) computed once, before the
        // message is assembled, so the opening time line can fuse the calendar date into
        // the clock sentence on first-of-day / first-of-session runs.
        const meta = this.computeDayPosition(now)
        // Debug poke: a forced "first" run (e.g. "/automation force <name> first") pretends
        // this is the first run of the session, so the dated opening time line renders even
        // at a mid-session clock time.
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

        // Opening time-of-day line rendered BEFORE the base sentence on both output paths
        // (AI rewrite and direct TTS). Dated runs (first of day/session) fuse the calendar
        // date into the clock sentence via the {% date %} token. Empty when the active
        // bundle has no decoupled time_sentence templates; such bundles keep their inline
        // {% time %} in the base.
        const timeLine = this.buildTimeSentence(now, this.#bundle, meta)

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
     * @param {Object|null} _device - Unused in this override (kept for signature parity)
     * @param {string} _targetKey - Unused in this override
     * @param {Array<Object>} _matchingRules - Unused in this override
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
     * @returns {{isFirst: boolean, isLast: boolean, isFirstOfDay: boolean, nextIntervalMs: number|null}}
     *   isFirst/isLast require both a positive timer interval and a valid silence window;
     *   isFirstOfDay (first run of the calendar day, within one interval of local midnight)
     *   requires only a positive interval; nextIntervalMs is milliseconds until the next
     *   non-silent tick, or null when the timer is disabled or no such tick exists within
     *   the scan horizon.
     */
    computeDayPosition(now = new Date()) {
        const result = { isFirst: false, isLast: false, isFirstOfDay: false, nextIntervalMs: null }

        const intervalMs = this.getTimerIntervalMs()
        if (!(intervalMs > 0)) return result            // event-driven only -- nothing periodic to predict

        // "First run of the day": within one interval of local midnight. Independent of
        // the silence window (a midnight run is usually mid-session), so it is computed
        // before the mid-silence early-return below. Drives the calendar date in the
        // opening time line (see buildTimeSentence()).
        const midnight = new Date(now)
        midnight.setHours(0, 0, 0, 0)
        result.isFirstOfDay = (now.getTime() - midnight.getTime()) < intervalMs

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
     * Assemble the ordered day-position speech segments for a run -- an optional single
     * opener (first / last / only), then the core message, then an optional "next update"
     * closer. Excludes the creative ai_prefix entirely; these are plain sentences meant to
     * be spoken verbatim on BOTH output paths. The closer now appears on every run except
     * the last (and whenever a next tick can be predicted), so first runs announce it too.
     * @private
     * @param {string} message - Interpolated core speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     *   Day position computed by {@link computeDayPosition}
     * @returns {string[]} Ordered segments (message always present)
     */
    #speechSegments(message, meta = {}) {
        const parts = []

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

        // Closing "next update" line -- every run except the last, when a next tick is known.
        if (!meta.isLast && typeof meta.nextIntervalMs === 'number' && meta.nextIntervalMs > 0) {
            const template = this.#resolveI18n('weatherman.ai_message_next', '')
            const phrase = temporal.msToHumanPhrase(meta.nextIntervalMs, temporal.getDurationUnits())
            if (template && phrase) {
                parts.push(this.#interpolate(template, null, { next_interval: phrase }))
            }
        }

        return parts
    }

    /**
     * Assemble the full prompt sent to the AI for a weather update. Layout: creative prefix
     * -> optional day-position opener (first / last / only) -> core message -> optional
     * "next update in ..." closer. The creative prefix is prepended whenever it is
     * configured, independent of whether any day-position markers apply; the core message
     * itself is always present.
     *
     * Exposed without the # prefix so unit tests can verify assembly order and i18n
     * degradation without a live AI provider; #speak() is the sole production caller.
     *
     * @param {string} message - Interpolated core speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     *   Day position computed by {@link computeDayPosition}
     * @returns {string} Full AI prompt (creative prefix + day-position markers + core message)
     */
    buildAiPrompt(message, meta = {}) {
        const segments = this.#speechSegments(message, meta)
        const body = segments.join('\n')          // keep the newline layout the model expects

        // Creative instruction prefix (existing behaviour). Only the AI leg carries it --
        // direct TTS must never read these instructions aloud.
        const aiPrefixKey = this.config.sentence_ai_prefix
        if (aiPrefixKey && this.#bundle) {
            const prefixText = this.#resolveI18n(aiPrefixKey, '')
            if (prefixText) return `${prefixText}\n${body}`
        }

        return body
    }

    /**
     * Plain-speech text for the direct-TTS path (AI unavailable). Includes every day-position
     * marker (first / last / only + next-update closer) so listeners get the same framing even
     * without AI -- but deliberately excludes the creative ai_prefix, which is an instruction to
     * the model, not something to be spoken. Segments are space-joined for natural sentence flow.
     *
     * Exposed without the # prefix so unit tests can pin the pure-TTS output shape; #speak()
     * is the sole production caller.
     *
     * @param {string} message - Interpolated core speech text
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     *   Day position computed by {@link computeDayPosition}
     * @returns {string} Speech text with markers (no ai_prefix)
     */
    buildDirectTtsText(message, meta = {}) {
        const segments = this.#speechSegments(message, meta)
        return segments.join(' ').trim()
    }

    /**
     * Build the validated extra-TTS-server-parameters object for this automation's
     * utterances from the optional tts_options section of the YAML config. Recognized
     * keys map 1:1 onto TTS server request fields:
     *   intro         - string, wave filename played before the synthesized speech
     *   outro         - string, wave filename played after the synthesized speech
     *   intro_spacing - number (negative allowed), seconds between intro end and speech start
     * Malformed entries are dropped with a warning instead of failing the run; an absent
     * or fully empty section yields {} so emissions keep their plain { text } shape.
     * Exposed without the # prefix so unit tests can pin validation behaviour per instance
     * by injecting synthetic configs without touching the on-disk YAML file.
     * @param {Record<string, unknown>} [rawConfig=this.config] - Config source to read from
     * @returns {{intro?: string, outro?: string, intro_spacing?: number}} Validated options (possibly empty)
     */
    resolveTtsOptions(rawConfig = this.config) {
        const raw = rawConfig?.tts_options
        if (!raw || typeof raw !== 'object') return {}

        const result = {}
        for (const key of ['intro', 'outro']) {
            const value = raw[key]
            if (value == null) continue
            if (typeof value === 'string' && value.trim()) {
                result[key] = value.trim()
            } else {
                this.log(`tts_options.${key} must be a non-empty wave filename -- ignoring`, 'warn')
            }
        }
        const spacing = raw.intro_spacing
        if (spacing != null) {
            if (typeof spacing === 'number' && Number.isFinite(spacing)) {
                result.intro_spacing = spacing
            } else {
                this.log('tts_options.intro_spacing must be a finite number of seconds (negative allowed) -- ignoring', 'warn')
            }
        }
        return result
    }

    /**
     * Render the opening time-of-day line for a weather update, or '' when no applicable
     * template exists. The line is prepended to the base sentence on both output paths
     * (AI rewrite and direct TTS), which keeps tiny models away from converting clock
     * strings into words and keeps Piper TTS away from ambiguous bare H:M digits -- the
     * "N minutes past H + period word" frame stays unambiguous either way.
     *
     * #pickTimeTemplate() chooses the variant matching the clock fraction with fallback
     * to the default entry. Clock tokens are pre-resolved from `now` via the
     * specialValues mechanism so rendering is deterministic per instant.
     *
     * Exposed without the # prefix so unit tests can verify rendering and i18n degradation
     * without MQTT or AI providers; execute() is the sole production caller. The optional
     * bundle parameter lets tests inject synthetic bundles without touching private state.
     *
     * @param {Date} [now=new Date()] - Moment to render
     * @param {Record<string, unknown>|null} [bundle=this.#bundle] - Weatherman i18n bundle
     * @param {{isFirst?: boolean, isFirstOfDay?: boolean}} [meta] - Day position from
     *   {@link computeDayPosition}; when either flag is set the line is "dated" (see below)
     * @returns {string} Interpolated opening line, or '' when nothing applicable exists
     */
    buildTimeSentence(now = new Date(), bundle = this.#bundle, meta = {}) {
        const tree = bundle?.time_sentence
        if (!tree || typeof tree !== 'object') return ''

        // Dated runs (first of the day / first of the session) fuse the calendar date
        // into the clock sentence via the {% date %} token.
        const dated = Boolean(meta?.isFirst || meta?.isFirstOfDay)
        const tpl = this.#pickTimeTemplate(tree, now, dated)
        if (!tpl) return ''

        const period = temporal.getCurrentTimePeriod(now)
        // Day-period words come from the date bundle (date.yaml) -- all date/time
        // vocabulary now lives in one place owned by the date helper.
        const words = temporal.getPeriodWords()
        const h24 = now.getHours()
        return this.#interpolate(tpl, null, {
            date: dated ? this.#buildDateFragment(now) : '',
            hours: String(I18nLoader.is12HourFormat() ? ((h24 + 11) % 12) + 1 : h24),
            minutes: String(now.getMinutes()),
            time_of_day: (period && words[period]) || period || '',
        })
    }

    /**
     * Render the localized calendar-date fragment (e.g. "wtorek, 1 września 2026 roku")
     * by interpolating the date bundle's `date_sentence` template with the resolved date
     * parts. The fragment carries no leading "Jest"/"It is" and no trailing period -- it is
     * fused into the opening time line via the `{% date %}` token so the date and the clock
     * read as one grammatical sentence rather than two.
     * @private
     * @param {Date} now - Moment to render
     * @returns {string} Interpolated date fragment, or '' when the bundle has no template
     */
    #buildDateFragment(now) {
        const template = temporal.loadDateBundle()?.date_sentence
        if (!template || typeof template !== 'string') return ''
        return this.#interpolate(template, null, temporal.getDateParts(now))
    }


    // -- Private Helpers ----------------------------------------------------

    /**
     * Pick the variant template for a moment within bundle.time_sentence. Exact clock
     * fractions win when their locale-specific template exists (:00 -> exact_hour;
     * :30/:15/:45 -> half_past/quarter_to/quarter_past -- reserved hooks for future i18n
     * templates, none shipped yet); otherwise fall back to the generic default entry.
     * Dated runs prefer their own dated_* variants (which fuse the {% date %} token) but
     * fall back to the plain variants, then to the default, so a bundle that ships only
     * the dated default still renders. Returns '' when nothing usable is present so
     * callers can skip the opening line gracefully.
     * @private
     * @param {Record<string, unknown>} variants - The bundle.time_sentence object
     * @param {Date} now - Moment to evaluate
     * @param {boolean} [dated=false] - Whether this is a dated run (first of day/session)
     * @returns {string} Chosen raw (uninterpolated) template, or ''
     */
    #pickTimeTemplate(variants, now, dated = false) {
        const m = now.getMinutes()
        let suffix = null
        if (m === 0)          suffix = 'exact_hour'
        else if (m === 30)    suffix = 'half_past'
        else if (m === 15)    suffix = 'quarter_past'
        else if (m === 45)    suffix = 'quarter_to'

        // Priority: dated-specific -> dated default -> plain specific -> plain default.
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

    /**
     * Load the weatherman i18n bundle from etc/i18n/{locale}/weatherman.yaml.
     * Falls back to pl_PL if not found.
     * @private
     * @returns {Record<string, unknown>|null}
     */
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

    /**
     * Resolve a dotted i18n key against the loaded weatherman bundle.
     * Example: 'weatherman.warning_apocalypse' -> bundle['warning_apocalypse']
     * The first segment ('weatherman') is stripped as the namespace prefix.
     * @private
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
     * @private
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
     * Send the built message to TTS, optionally routing through AI first. When the AI handles
     * it, day-position markers frame the core content via buildAiPrompt(); on the direct-TTS
     * fallback they come from buildDirectTtsText() so listeners get the same framing either way.
     * Configured tts_options extras travel along in every 'tts:speak' payload -- both paths.
     * @private
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

        // Optional per-utterance TTS server params from tts_options; {} keeps every
        // emission byte-identical to the plain-text shape when nothing is configured.
        const ttsOptions = this.resolveTtsOptions()

        const aiAvailable = AiAssistant.isAvailable()

        // The text shown in Window 3 must match what is actually heard. On the AI leg that
        // is the full prompt (creative prefix + day-position markers, which go into the
        // model); on the direct-TTS fallback it is the spoken text (markers, but no
        // creative prefix, which is an instruction to the model rather than something to
        // read aloud).
        const spokenText = aiAvailable
            ? this.buildAiPrompt(trimmedMessage, meta)
            : this.buildDirectTtsText(trimmedMessage, meta)

        // Emit system input to UI with the exact text that will be heard.
        // Guard against --no-ui runs where no subscribers exist.
        if (EventBus.hasSubscribers('ai:systemMessage')) {
            EventBus.emit('ai:systemMessage', { text: spokenText })
        }

        if (aiAvailable) {
            await this.routeThroughAi(spokenText, trimmedMessage, ttsOptions, meta)
        } else {
            // Direct TTS when AI unavailable: speak every day-position marker minus the creative
            // ai_prefix, which is an instruction to the model rather than something to read aloud.
            EventBus.emit('tts:speak', { text: spokenText, ...ttsOptions })
            this.log('Weather update sent via direct TTS', 'debug')
        }
    }

    /**
     * Send one built weather report through the AI -> TTS pipeline with graceful
     * degradation. A non-empty model reply is surfaced in the chat window as a periodic
     * response (the audio itself was already fired by AiAssistant for that reply). An
     * empty reply or any provider failure falls back to speaking the message directly
     * (with the same day-position markers the AI-unavailable path uses) and posts a
     * visible <system> notice explaining why no rewritten report appears -- so a
     * slow/dead LLM never leaves Window 3 looking dead while audio plays from nowhere.
     *
     * Exposed without the # prefix so unit tests can pin fallback behaviour against a
     * stubbed AiAssistant without MQTT, devices, or a live LLM; #speak() is the sole
     * production caller.
     * @param {string} aiPrompt - Full prompt sent to the model (prefix/markers included)
     * @param {string} trimmedMessage - Plain core text used for the direct-TTS fallback
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} ttsOptions - Jingle passthrough options
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     *   Day position, forwarded to the fallback so it speaks the same markers
     */
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
            // Model answered with nothing usable -- nothing was spoken yet; degrade loudly.
            this.log('AI reply was empty -- falling back to direct TTS', 'warn')
            return this.#degradeToRawTts(trimmedMessage, ttsOptions, 'empty reply from model', meta)
        }

        // Emit the AI's response back to UI for rendering with <AI> prefix.
        // Guard against --no-ui runs where no subscribers exist.
        if (EventBus.hasSubscribers('ai:periodicResponse')) {
            EventBus.emit('ai:periodicResponse', { text: spoken })
        }
        this.log(`Weather update sent via AI -> TTS pipeline (${spoken.length} chars)`, 'debug')
    }

    /**
     * Fallback leg of routeThroughAi(): post a visible <system> notice explaining that the
     * assistant did not deliver (localized via the weatherman bundle key
     * `weatherman.ai_fallback_notice`), then speak the message directly (with the same
     * day-position markers the AI-unavailable path uses) so the report is never lost.
     * Jingle params still apply on the fallback path.
     * @private
     * @param {string} trimmedMessage - Plain core text to speak
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} ttsOptions - Jingle passthrough options
     * @param {string} reason - Failure description kept in the log trail
     * @param {{isFirst?: boolean, isLast?: boolean, nextIntervalMs?: number|null}} [meta]
     *   Day position, so the fallback speaks the same markers as the direct-TTS path
     */
    #degradeToRawTts(trimmedMessage, ttsOptions, reason, meta = {}) {
        const notice = this.#resolveI18n('weatherman.ai_fallback_notice', '') ||
            'The assistant did not answer in time -- reading the plain report instead.'
        if (EventBus.hasSubscribers('ai:systemMessage')) {
            EventBus.emit('ai:systemMessage', { text: notice })
        }
        // Fallback to direct TTS on AI failure -- speak the same day-position markers the
        // AI-unavailable path uses (minus the creative prefix), so a flaky AI never drops
        // them. Jingle params still apply on the fallback path.
        EventBus.emit('tts:speak', { text: this.buildDirectTtsText(trimmedMessage, meta), ...ttsOptions })
        this.log(`Weather update fell back to direct TTS (${reason})`, 'debug')
    }

    /**
     * Epoch ms of the most recent past occurrence of the silence-window END boundary --
     * i.e., the moment the current announcement session began ("wake-up"). For a normal
     * window like "0230-1030" at 15:00 this is today's 10:30; at 01:45 it is yesterday's.
     * Note: local-midnight arithmetic assumes a 24 h day (DST transitions shift results
     * by an hour for runs near midnight on those days -- acceptable for speech markers).
     * @private
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
     * @private
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