/**
 * Abstract base class for rule-based (YAML-driven) automations.
 * Extends {@link ../automationBase.js} with context building (sensor readings.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'

import temporal from '../../lib/date.js'
import solar from '../../lib/sun.js'

import CacheService from '../../service/cacheService.js'
import DatabaseService from '../../service/databaseService.js'
import LoggerService from '../../service/loggerService.js'
import StateService from '../../service/stateService.js'
import EventBus from '../../service/eventBus.js'
import { parseDocument as yamlParseDocument } from 'yaml'
import { slugify, toTargetKey } from '../../lib/string.js'

import DeviceContainer from '../../device/container/deviceContainer.js'
import Mechanism from '../../device/type/mechanism.js'
import networkPresence from '../../monitor/networkPresence.js'
import videoPlayerMonitor from '../../monitor/videoPlayerMonitor.js'
import AutomationContainer from '../container/automationContainer.js'

import AutomationBase from './automationBase.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'

/** Maximum consecutive context-build failures before escalating from warn to error.
 * @type {number} */
const CONTEXT_FAILURE_ESCALATION_THRESHOLD = 5

/** TTL for per-rule daily "once" markers stored in Redis (48 hours, seconds).
 * @type {number} */
const ONCE_MARKER_TTL_SECONDS = 172_800

/** How many recent rule matches one automation keeps for the UI rules window.
 * @type {number} */
const RULE_MATCH_HISTORY_SIZE = 25

/** Enumerated status meaning "no usable player signal" */
const VIDEO_PLAYER_OFFLINE = 'offline'

/** Condition keys handled by dedicated gates in #checkScalarConditions() (and mirrored by
 * the miss explainer); anything else is a dynamic numeric sensor range check.
 * @type {Readonly<Set<string>>} */
const SCALAR_CONDITION_KEYS = Object.freeze(new Set([
    'time_of_day',
    'hour',
    'season',
    'presence',
    'video_player',
    'state_changed_ago_minutes',
    'after_latest_of',
    'after_earliest_of',
    'any_of',
    'all_of'
]))

/** Rule-miss explanations cost a few cache lookups per unmatched rule, so they run only
 * where TRACE logs are actually routed (mirrors the trace-file transport: off in production,
 * off when the stream was suppressed at startup with --no-trace). Evaluated lazily because
 * the --no-trace flag lands in StateService only after this module has been imported.
 * @returns {boolean} True when rule-miss explanations should be produced */
function ruleMissExplanationEnabled() {
    return process.env.NODE_ENV !== 'production' && !StateService.get('cli.noTrace')
}

/** Legacy kebab-case condition keys that were unified to snake_case.
 * @type {Readonly<Record<string,string>>} */
const LEGACY_CONDITION_KEY_RENAMES = Object.freeze({
    'time-of-day': 'time_of_day',
    'video-player': 'video_player',
    'state-changed-ago-minutes': 'state_changed_ago_minutes'
})

/** Recursively scan a rule's conditions tree for legacy kebab-case condition keys.
 * @param {object|Array|null|undefined} node - Condition mapping, composite value, or anything else
 * @param {string} [path=''] - Dot-path prefix used in report entries
 * @returns {Array<{key: string, renameTo: string, where: string}>} One entry per legacy key found */
export function findLegacyConditionKeys(node, path = '') {
    const found = []
    if (!node || typeof node !== 'object') return found
    if (Array.isArray(node)) {
        node.forEach((item, index) => {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                found.push(...findLegacyConditionKeys(item, `${path}[${index}]`))
            }
        })
        return found
    }
    for (const [key, value] of Object.entries(node)) {
        const here = path ? `${path}.${key}` : key
        if (Object.prototype.hasOwnProperty.call(LEGACY_CONDITION_KEY_RENAMES, key)) {
            found.push({ key, renameTo: LEGACY_CONDITION_KEY_RENAMES[key], where: here })
        }
        if (value && typeof value === 'object') {
            found.push(...findLegacyConditionKeys(value, here))
        }
    }
    return found
}

export default class RuleBasedAutomationBase extends AutomationBase {
    /** Consecutive context-build failure count for log-level escalation.
     * @type {number} */
    #contextFailCount = 0

    /** Epoch-ms timestamp up to which monitored-state transitions have been consumed by this
     * @type {number} */
    #lastEvaluatedAtMs = Date.now()

    /** Cached list of {domain, subject} pairs this automation monitors, derived from its rules'
     * @type {Array<{domain: string, subject: string}>|null} */
    #monitoredSubjects = null

    /** Config reference that the cached #monitoredSubjects was computed against.
     * @type {{rules?: unknown}|null} */
    #monitoredConfigRef = null

    /** Most recent rule matches performed by this automation, newest first, capped at
     * @type {Array<{automation: string, rule: string, at: number, trigger: string, forced: boolean, acted: boolean}>} */
    #recentRuleMatches = []

    /** Construct a rule-based automation.
     * @param {object} options - Constructor options
     * @param {string} options.name - Automation display name
     * @param {string} options.configPath - Filesystem path to YAML config */
    constructor({ name, configPath }) {
        let config = {}
        try {
            const raw = fs.readFileSync(configPath, 'utf8')
            config = yamlParseDocument(raw).contents?.toJSON() || {}
        } catch (error) {
            LoggerService.error(
                `Failed to load config from ${configPath}: ${error.message}`,
                `Auto:${name}`
            )
        }

        super({ name, config })
        this.#warnOnLegacyConditionKeys()
        this.#logConfigLoaded()
    }

    /** Log how many rules were loaded. Uses debug level so it's visible but not noisy.
     * @private */
    #logConfigLoaded() {
        this.log(`Config loaded: ${this.config.rules?.length ?? 0} rules defined`, 'debug')
    }

    /** Activation-time guard for the snake_case condition-key unification.
     * @private */
    #warnOnLegacyConditionKeys() {
        for (const rule of this.config.rules ?? []) {
            if (!rule || typeof rule !== 'object') continue
            const hits = findLegacyConditionKeys(rule.conditions)
            if (hits.length === 0) continue
            const detail = hits.map(h => `${h.where}: ${h.key} -> ${h.renameTo}`).join('; ')
            LoggerService.warn(
                `Rule "${rule.name ?? '(unnamed)'}" uses legacy kebab-case condition key(s) that no longer evaluate -- rename them now (${detail})`,
                `Auto:${this.name}`
            )
        }
    }

    /** Lifecycle hook -- fail-fast target validation before this automation becomes active.
     * @throws {Error} When rules declare target devices but none of them resolves to a valid */
    async init() {
        const devices = this.loadDevices()
        const declared = this.#declaredTargetKeys()
        if (devices.size === 0 && declared.length > 0) {
            throw new Error(
                `All ${declared.length} declared target key(s) failed validation [${declared.join(', ')}] ` +
                '-- no addressable mechanisms remain; see warnings above'
            )
        }
        await super.init()
    }

    /** Gather current sensor readings and time-of-day into a context object.
     * @returns {Promise<{illuminance: number|null, temperature: number|null, timeOfDay: string}>} */
    async buildContext() {
        //  Dynamically read every sensor defined in config.sensors.
        const ctx = {}
        const sensors = this.config.sensors ?? {}

        for (const [sensorKey, deviceName] of Object.entries(sensors)) {
            let value = null
            try {
                const sensor = DeviceContainer.findByName(deviceName)
                if (!sensor) {
                    this.log(`Sensor "${deviceName}" not found in container`, 'warn')
                    continue
                }
                const state = sensor.getStateLast()
                if (state && typeof state[sensorKey] === 'number') {
                    value = state[sensorKey]
                } else {
                    this.log(
                        `Could not retrieve ${sensorKey} from "${deviceName}" (no numeric "${sensorKey}")`,
                        'warn'
                    )
                }
            } catch (error) {
                this.log(`Error reading ${sensorKey} from "${deviceName}": ${error.message}`, 'warn')
            }
            ctx[sensorKey] = value
        }

        //  Time period -- always included regardless of config.
        ctx.timeOfDay = temporal.getCurrentTimePeriod()

        //  Sun-event instants (epoch ms) powering merged-gate conditions ("sundawn"/"sundusk"); null when geo is unconfigured/invalid.
        const sunTimes = solar.getSunTimes(new Date())
        ctx.sundawn = sunTimes.sundawn ? sunTimes.sundawn.getTime() : null
        ctx.sundusk = sunTimes.sundusk ? sunTimes.sundusk.getTime() : null

        return ctx
    }

    /** Evaluate a single rule's conditions against the built context.
     * @param {Record<string, unknown>} [conditions] - Conditions object from YAML rule
     * @param {{illuminance?: number|null, temperature?: number|null, timeOfDay: string, sundawn: number|null, sundusk: number|null}} context
     * @returns {Promise<boolean>} */
    async conditionsMatch(conditions, context) {
        if (!conditions) return true // no conditions = always matches
        return this.#evaluateConditionGroup(conditions, context)
    }

    /** Recursively evaluate one condition group.
     * @private
     * @param {Record<string, unknown>|null|undefined} group - Condition group from YAML
     * @param {{illuminance?: number|null, temperature?: number|null, timeOfDay: string, sundawn: number|null, sundusk: number|null}} context
     * @returns {Promise<boolean>} True when every gate in the group holds. */
    async #evaluateConditionGroup(group, context) {
        if (!group || typeof group !== 'object' || Array.isArray(group)) return false // malformed group -> fail closed

        for (const [key, value] of Object.entries(group)) {
            if (key === 'any_of') {
                if (!Array.isArray(value) || value.length === 0) return false
                let anyMatched = false
                for (const sub of value) {
                    if (await this.#evaluateConditionGroup(sub, context)) { anyMatched = true; break }
                }
                if (!anyMatched) return false
            } else if (key === 'all_of') {
                if (!Array.isArray(value)) return false
                for (const sub of value) {
                    if (!(await this.#evaluateConditionGroup(sub, context))) return false
                }
            }
        }

        return this.#checkScalarConditions(group, context)
    }

    /** Evaluate one condition group's scalar entries against the built context -- the historical.
     * @private
     * @param {Record<string, unknown>} conds - Scalar condition entries from YAML
     * @param {{illuminance?: number|null, temperature?: number|null, timeOfDay: string, sundawn: number|null, sundusk: number|null}} context
     * @returns {Promise<boolean>} */
    async #checkScalarConditions(conditions, context) {

        //  time_of_day check.
        if (conditions['time_of_day']) {
            const periods = Array.isArray(conditions['time_of_day'])
                ? conditions['time_of_day']
                : [conditions['time_of_day']]

            if (!periods.includes(context.timeOfDay)) {
                return false
            }
        }

        //  season check.

        //  Actual wall-clock hour check -- independent of the calendar-based day periods.
        if (conditions.hour !== undefined) {
            const nowHour = new Date().getHours()
            const constraint = conditions.hour
            if (typeof constraint === 'number') {
                if (!Number.isFinite(constraint) || Math.trunc(constraint) !== nowHour) return false
            } else if (constraint && typeof constraint === 'object' && !Array.isArray(constraint)) {
                //  A bound may be a sun shorthand ('sunrise'/'sunset', ...) resolving to today's real.
                if (!this.#matchesHourBounds(nowHour, constraint, context)) return false
            } else {
                return false
            }
        }
        if (conditions.season) {
            const seasons = Array.isArray(conditions.season)
                ? conditions.season
                : [conditions.season]

            if (!seasons.includes(temporal.getCurrentSeason())) {
                return false
            }
        }

        //  presence check.
        if (conditions.presence !== undefined) {
            const expected = this.#normalizePresenceCondition(conditions.presence)
            for (const [deviceName, shouldBeOnline] of Object.entries(expected)) {
                const isOnline = await networkPresence.isOnline(deviceName)
                if (isOnline !== shouldBeOnline) {
                    return false
                }
            }
        }

        //  video player status check.
        if (conditions['video_player'] !== undefined) {
            const expected = this.#normalizeVideoPlayerCondition(conditions['video_player'])
            for (const [host, statuses] of Object.entries(expected)) {
                const status = await videoPlayerMonitor.getStatus(host)
                //  No recorded state (host not configured / monitor never swept it) counts.
                const effective = status ?? VIDEO_PLAYER_OFFLINE
                if (!statuses.includes(effective)) {
                    return false
                }
            }
        }

        //  state-change recency check -- require that the last recorded transition.
        if (conditions['state_changed_ago_minutes'] !== undefined) {
            const expected = conditions['state_changed_ago_minutes']
            for (const [ref, bounds] of Object.entries(expected ?? {})) {
                const minMinutes = typeof bounds === 'number' ? bounds : Number(bounds?.gte ?? bounds?.min ?? NaN)
                if (!Number.isFinite(minMinutes)) continue   // malformed -> ignore rather than fail closed
                const { domain, subject } = this.#parseSubjectRef(ref)
                const ts = await DatabaseService.lastTransitionTs(domain, subject)
                if (ts == null) continue                       // never changed -> satisfies "at least N ago"
                if ((Date.now() - ts) < minMinutes * 60_000) return false
            }
        }

        //  Sun/clock merged gates -- fire once now has passed the LATEST (after_latest_of) or EARLIEST.
        for (const [gateKey, candidates] of Object.entries(conditions)) {
            if (gateKey !== 'after_latest_of' && gateKey !== 'after_earliest_of') continue
            if (!Array.isArray(candidates) || candidates.length === 0) return false // malformed -> fail closed
            const instants = []
            for (const candidate of candidates) {
                const instantMs = this.#resolveGateInstant(candidate, context)
                if (instantMs !== null && Number.isFinite(instantMs)) instants.push(instantMs)
            }
            if (instants.length === 0) return false // nothing resolvable -> fail closed
            const thresholdMs = gateKey === 'after_latest_of' ? Math.max(...instants) : Math.min(...instants)
            if (Date.now() < thresholdMs) return false
        }

        //  Dynamic: any remaining condition key -> numeric range check against context.
        for (const [key, constraint] of Object.entries(conditions)) {
            if (SCALAR_CONDITION_KEYS.has(key)) continue // handled above / by the group evaluator

            if (constraint && typeof constraint === 'object') {
                const value = context[key]
                if (!this.#matchesNumericRange(value, constraint)) {
                    return false
                }
            }
        }

        return true
    }

    /** Explain, for debug logs only, which gate rejected a rule's conditions.
     *
     * Mirrors the gate order and the evaluators of #checkScalarConditions() and
     * #evaluateConditionGroup(), and reports the concrete values involved. Sun/clock gates
     * leave no trace in the logs today, which is why a pre-dawn pause rejected by
     * `hour: { gte: sunset }` looks like a silently missing rule: this names the gate and
     * prints the resolved hours (e.g. "hour 4.59 fails gte sunset 18.44").
     *
     * Diagnostic only -- never changes a match outcome, and never throws. Mirrors the public
     * conditionsMatch() so tests and callers can ask the same question the matcher answers.
     * @param {Record<string, unknown>|null|undefined} conditions - Rule conditions to explain
     * @param {{illuminance?: number|null, temperature?: number|null, timeOfDay: string, sundawn: number|null, sundusk: number|null}} context
     * @returns {Promise<string>} Human-readable reason for the miss */
    async explainRuleMiss(conditions, context) {
        if (!conditions || typeof conditions !== 'object') return 'no conditions'

        try {
            const asList = (value) => Array.isArray(value) ? value : [value]

            //  Day-period gate.
            if (conditions['time_of_day'] !== undefined) {
                const periods = asList(conditions['time_of_day'])
                if (!periods.includes(context.timeOfDay)) {
                    return `time_of_day '${context.timeOfDay ?? 'none'}' not in [${periods.join(', ')}]`
                }
            }

            //  Clock/sun gate -- resolve sun shorthands to the same fractional hours the matcher used.
            if (conditions.hour !== undefined) {
                const constraint = conditions.hour
                const nowHour = new Date().getHours()
                if (typeof constraint === 'number') {
                    if (Math.trunc(constraint) !== nowHour) return `hour ${nowHour} != ${constraint}`
                } else if (constraint && typeof constraint === 'object' && !Array.isArray(constraint)) {
                    if (!this.#matchesHourBounds(nowHour, constraint, context)) {
                        const startOfTodayMs = new Date().setHours(0, 0, 0, 0)
                        const nowFractional = (Date.now() - startOfTodayMs) / 3_600_000
                        const bounds = Object.entries(constraint).map(([op, bound]) => {
                            const value = this.#resolveHourValue(bound, context, startOfTodayMs)
                            const label = this.#isSunShorthand(bound)
                                ? `${bound} ${Number.isFinite(value) ? value.toFixed(2) : 'unresolved'}`
                                : String(value)
                            return `${op} ${label}`
                        })
                        return `hour ${nowFractional.toFixed(2)} fails ${bounds.join(', ')}`
                    }
                } else {
                    return `hour ${JSON.stringify(constraint)} malformed`
                }
            }

            //  Season gate.
            if (conditions.season) {
                const seasons = asList(conditions.season)
                const season = temporal.getCurrentSeason()
                if (!seasons.includes(season)) return `season '${season}' not in [${seasons.join(', ')}]`
            }
            //  Presence gate.
            if (conditions.presence !== undefined) {
                for (const [host, shouldBeOnline] of Object.entries(this.#normalizePresenceCondition(conditions.presence))) {
                    const isOnline = await networkPresence.isOnline(host)
                    if (isOnline !== shouldBeOnline) {
                        return `presence '${host}' is ${isOnline ? 'online' : 'offline'}, required ${shouldBeOnline ? 'online' : 'offline'}`
                    }
                }
            }

            //  Video-player status gate.
            if (conditions['video_player'] !== undefined) {
                for (const [host, statuses] of Object.entries(this.#normalizeVideoPlayerCondition(conditions['video_player']))) {
                    const status = await videoPlayerMonitor.getStatus(host) ?? VIDEO_PLAYER_OFFLINE
                    if (!statuses.includes(status)) {
                        return `video_player '${host}' is '${status}', required [${statuses.join(', ')}]`
                    }
                }
            }

            //  State-change recency gate.
            if (conditions['state_changed_ago_minutes'] !== undefined) {
                for (const [ref, bounds] of Object.entries(conditions['state_changed_ago_minutes'] ?? {})) {
                    const minMinutes = typeof bounds === 'number' ? bounds : Number(bounds?.gte ?? bounds?.min ?? NaN)
                    if (!Number.isFinite(minMinutes)) continue
                    const { domain, subject } = this.#parseSubjectRef(ref)
                    const ts = await DatabaseService.lastTransitionTs(domain, subject)
                    if (ts == null) continue
                    const ageMinutes = (Date.now() - ts) / 60_000
                    if (ageMinutes < minMinutes) {
                        return `state_changed_ago_minutes '${ref}' is ${ageMinutes.toFixed(1)}, required >= ${minMinutes}`
                    }
                }
            }

            //  Sun/clock merged gates.
            for (const [gateKey, candidates] of Object.entries(conditions)) {
                if (gateKey !== 'after_latest_of' && gateKey !== 'after_earliest_of') continue
                if (!Array.isArray(candidates) || candidates.length === 0) return `${gateKey} malformed`
                const instants = candidates
                    .map((candidate) => this.#resolveGateInstant(candidate, context))
                    .filter((instantMs) => instantMs !== null && Number.isFinite(instantMs))
                if (instants.length === 0) return `${gateKey}: no candidate resolvable`
                const thresholdMs = gateKey === 'after_latest_of' ? Math.max(...instants) : Math.min(...instants)
                if (Date.now() < thresholdMs) return `${gateKey} not reached (threshold ${new Date(thresholdMs).toLocaleTimeString()})`
            }

            //  Composite groups, then dynamic numeric sensor gates.
            for (const [key, constraint] of Object.entries(conditions)) {
                if (key === 'any_of' || key === 'all_of') {
                    const groups = Array.isArray(constraint) ? constraint : []
                    let matched = (key === 'all_of')
                    for (const group of groups) {
                        const groupMatched = await this.#evaluateConditionGroup(group, context)
                        if (key === 'any_of' && groupMatched) { matched = true; break }
                        if (key === 'all_of' && !groupMatched) { matched = false; break }
                    }
                    if (!matched) return `${key}: no group matched`
                    continue
                }
                if (SCALAR_CONDITION_KEYS.has(key)) continue
                if (constraint && typeof constraint === 'object') {
                    const value = context[key]
                    if (!this.#matchesNumericRange(value, constraint)) {
                        return `${key} ${value == null ? 'missing' : value} not in ${JSON.stringify(constraint)}`
                    }
                }
            }
        } catch (error) {
            return `reason unavailable: ${error.message}`
        }

        return 'conditions not met'
    }

    //  Template method - common execute flow.

    /** Main execution flow shared by all rule-based automations.
     * @param {Object} [triggerData] - Info about what triggered this run
     * @param {string} [triggerData.trigger] - Trigger source identifier
     * @param {boolean} [triggerData.force] - When true (e.g., "/automation force" or an `invoke_automation` action), bypasses both checks and writes of */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        const forced = triggerData?.force === true
        this.log(`Triggered by: ${triggerSource}`, 'info')

        // Opt-in react-on-change gating (config.trigger_on_change_only)
        if (this.config.trigger_on_change_only === true && !forced && triggerSource === 'timer') {
            if (!await this.#changedSinceLastEvaluation()) {
                this.log('No monitored state change since last run -- skipping scheduled tick', 'debug')
                return
            }
        }

        //  Reached here => we will evaluate now; advance the consumed-changes baseline.
        this.#lastEvaluatedAtMs = Date.now()

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

        //  Top-level video-player stand-down guard (video_player_suppression)
        let suppressionActive = false
        if (this.config.video_player_suppression) {
            if (await this.#evaluateVideoPlayerSuppression()) {
                const hasExemptRule = (this.config.rules ?? []).some(
                    (rule) => rule.ignore_video_player_suppression === true
                )
                if (!hasExemptRule) {
                    this.log(`Suppressed by video_player_suppression (${triggerSource})`, 'debug')
                    return
                }
                suppressionActive = true
                this.log(
                    `video_player_suppression active -- evaluating exempt rules only (${triggerSource})`,
                    'debug'
                )
            }
        }

        let context
        try {
            context = await this.buildContext()
            //  Reset failure counter on success.
            this.#contextFailCount = 0
        } catch (error) {
            this.#contextFailCount++
            const level = this.#contextFailCount >= CONTEXT_FAILURE_ESCALATION_THRESHOLD
                ? 'warn'
                : 'info'
            this.log(
                `Context build failed (${this.#contextFailCount}/${CONTEXT_FAILURE_ESCALATION_THRESHOLD}): ${error.message}`,
                level
            )
            return
        }

        const rules = this.config.rules ?? []

        //  Collect all matching rules.
        const matchingRules = []
        //  Match records created.
        const runRecords = []
        for (const rule of rules) {
            //  Stand-down guard active: only rules that opted out participate.
            if (suppressionActive && rule.ignore_video_player_suppression !== true) continue

            //  Invoke-only rules (forced_only): respond solely to forced/delegated runs -- e.g.
            if (rule.forced_only === true && !forced) {
                this.log(`Rule "${rule.name}" is invoke-only and this is a natural run, skipping`, 'debug')
                continue
            }

            try {
                const match = await this.conditionsMatch(rule.conditions, context)
                if (!match) {
                    //  TRACE-only diagnosis: name the gate that rejected the rule, so a silently
                    //  skipped rule (a sun/clock gate in particular) is diagnosable from the log.
                    //  High-volume and noise-heavy (every unmatched rule on every trigger), so it
                    //  stays out of DEBUG -- the debug log and the UI log window.
                    if (ruleMissExplanationEnabled()) {
                        this.log(`Rule skipped: "${rule.name}" - ${await this.explainRuleMiss(rule.conditions, context)}`, 'trace')
                    }
                    continue
                }

                //  Per-rule daily "once" marker -- at most one action per calendar day, and
                //  one per time-of-day window for rules that declare a `time_of_day` gate.
                if (rule.once && triggerData?.force !== true && await this.hasActedToday(rule, context.timeOfDay)) {
                    const scope = this.declaresTimeWindow(rule.conditions) ? ` during ${context.timeOfDay}` : ''
                    this.log(`Rule "${rule.name}" already acted today${scope}, skipping`, 'debug')
                    continue
                }

                matchingRules.push(rule)
                runRecords.push(this.#recordRuleMatch(rule, triggerSource, forced))
                this.log(`Rule matched: "${rule.name}"`, 'debug')
            } catch (error) {
                this.log(`Error evaluating rule "${rule.name}": ${error.message}`, 'error')
            }
        }

        if (matchingRules.length === 0) {
            this.log('No rules matched, no action', 'debug')
            return
        }

        //  Fire any `invoke_automation` actions declared by matched rules -- e.g.
        let invokedCount = 0   // successful invoke_automation firings this run
        {
            const invocations = new Map()   // name -> force (OR-merged across referencing rules)
            for (const rule of matchingRules) {
                for (const { name, force } of this.#normalizeInvokeSpec(rule.invoke_automation)) {
                    invocations.set(name, (invocations.get(name) ?? false) || force)
                }
            }
            for (const [name, force] of invocations.entries()) {
                try {
                    this.log(`Invoking automation "${name}"${force ? ' (forced)' : ''}`, 'info')
                    await AutomationContainer.callAutomation(name, { trigger: this.name, ...(force ? { force: true } : {}) })
                    invokedCount++
                } catch (error) {
                    this.log(`Failed to invoke automation "${name}": ${error.message}`, 'warn')
                }
            }
        }

        //  Device targets are resolved here -- AFTER rule matching and invocations fired.
        let dispatchedCount = 0    // devices that actually received a command
        let humanSkippedCount = 0  // devices deferred to recent human interaction

        const devices = this.loadDevices()
        if (devices.size === 0) {
            this.log('No target devices declared or resolvable -- only non-device actions applied', 'debug')
        } else {
            const outcome = await this.#dispatchDeviceCommands(devices, matchingRules, forced)
            dispatchedCount = outcome.dispatchedCount
            humanSkippedCount = outcome.humanSkippedCount
        }

        //  Consume the daily slot for `once` rules when we either acted on a device.
        if ((dispatchedCount > 0 || humanSkippedCount > 0 || invokedCount > 0) && triggerData?.force !== true) {
            for (const rule of matchingRules) {
                if (rule.once) {
                    await this.markActedToday(rule, context.timeOfDay)
                }
            }
        }

        this.#publishRuleMatchOutcome(runRecords, dispatchedCount > 0 || humanSkippedCount > 0 || invokedCount > 0)
    }

    /** Record one rule match in this automation's recent-match history and publish it.
     * @private
     * @param {{name?: string}} rule - The rule whose conditions matched
     * @param {string} triggerSource - What started the run ('timer', an EventBus topic, ...)
     * @param {boolean} forced - True for forced/delegated runs (`/automation force` and friends)
     * @returns {{automation: string, rule: string, at: number, trigger: string, forced: boolean, acted: boolean}} The live record */
    #recordRuleMatch(rule, triggerSource, forced) {
        const record = {
            automation: this.name,
            rule: (rule && typeof rule.name === 'string' && rule.name) ? rule.name : '(unnamed)',
            at: Date.now(),
            trigger: triggerSource,
            forced: forced === true,
            acted: false,
        }

        this.#recentRuleMatches.unshift(record)
        if (this.#recentRuleMatches.length > RULE_MATCH_HISTORY_SIZE) {
            this.#recentRuleMatches.length = RULE_MATCH_HISTORY_SIZE
        }

        EventBus.emit('automation:ruleMatched', { ...record })
        return record
    }

    /** Publish the outcome of a finished run's matches on the `automation:ruleActed`
     * @private
     * @param {Array<Object>} records - Records created by this run (see #recordRuleMatch)
     * @param {boolean} acted - True when the run produced at least one action */
    #publishRuleMatchOutcome(records, acted) {
        if (acted !== true) return
        for (const record of records) {
            record.acted = true
            EventBus.emit('automation:ruleActed', { ...record })
        }
    }

    /** This automation's most recent rule matches, newest first.
     * @returns {Array<{automation: string, rule: string, at: number, trigger: string, forced: boolean, acted: boolean}>} Recent matches (empty when none yet) */
    getRecentRuleMatches() {
        return this.#recentRuleMatches.map((record) => ({ ...record }))
    }

    /** Normalize an `invoke_automation` spec into a list of {name, force} entries.
     * @private
     * @param {string|Object|string[]|Object[]|null|undefined} spec - Raw `invoke_automation` value from a rule
     * @returns {Array<{name: string, force: boolean}>} Normalized entries (empty when the spec is absent or unusable) */
    #normalizeInvokeSpec(spec) {
        if (!spec) return []
        //  Object with a `names` array: one shared force flag applied to every listed name.
        if (typeof spec === 'object' && !Array.isArray(spec) && Array.isArray(spec.names)) {
            const force = spec.force === true
            return spec.names
                .filter((n) => typeof n === 'string' && n)
                .map((n) => ({ name: n, force }))
        }
        //  Array form: each element is a bare name or a {name, force} object.
        if (Array.isArray(spec)) {
            const out = []
            for (const item of spec) {
                if (typeof item === 'string' && item) {
                    out.push({ name: item, force: false })
                } else if (item && typeof item === 'object' && typeof item.name === 'string' && item.name) {
                    out.push({ name: item.name, force: item.force === true })
                }
            }
            return out
        }
        //  Legacy single-target forms: bare string or {name, force}.
        const name = typeof spec === 'string' ? spec : spec?.name
        if (!name || typeof name !== 'string') return []
        return [{ name, force: typeof spec === 'object' && spec.force === true }]
    }

    /** Dispatch exactly one consolidated command per resolved device, collecting candidate.
     * @private
     * @param {Map<string, DeviceBase>} devices - Resolved target key -> mechanism map
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @param {boolean} [bypassHumanCooldown=false] - When true (forced runs), per-device
     * @returns {Promise<{dispatchedCount: number, humanSkippedCount: number}>} Outcome counters */
    async #dispatchDeviceCommands(devices, matchingRules, bypassHumanCooldown = false) {
        const tasks = []
        let dispatchedCount = 0   // devices that actually received a command
        let humanSkippedCount = 0 // devices deferred to recent human interaction

        for (const [targetKey, device] of devices) {
            //  Capture loop variables in closure.
            const tk = targetKey
            const dev = device

            tasks.push(async () => {
                //  Skip recently touched devices (Redis-only check)
                if (!this.getOverrideHumanInteraction()
                    && await this.checkAndLogHumanInteraction(dev, { bypassCooldown: bypassHumanCooldown })) {
                    humanSkippedCount++
                    return
                }

                //  Collect per-target commands from every matching rule.
                const commands = []
                const contributions = []
                for (const rule of matchingRules) {
                    const cmd = rule.targets?.[tk]
                    if (cmd !== undefined) {
                        commands.push(cmd)
                        contributions.push(`${rule.name ?? 'unnamed rule'}=${cmd}`)
                    }
                }

                if (commands.length === 0) {
                    for (const rule of matchingRules) {
                        if (rule.action !== undefined) {
                            commands.push(rule.action)
                        }
                    }
                }

                if (commands.length === 0) return

                //  Log every rule that contributed to this device's decision.
                this.log(
                    `${dev.getName()}: merged ${contributions.length} contribution(s) [${contributions.join(', ')}]`,
                    'debug'
                )

                //  Resolve via subclass hook - e.g., blinds use "lowest position wins"
                const result = this.resolveCommand(dev, tk, matchingRules)
                if (!result || result.skip) return

                //  Re-assert semantics: a forced hand-off (`/automation force`, an
                //  `invoke_automation: {force: true}` player-gone hand-off) or a rule flagged
                //  `reassert_state` must reach the device even when its cached state already
                //  matches -- that cache can be a stale pre-command snapshot whenever the device
                //  never confirmed our own previous command (see doc/ht-lights-bug.md).
                const reassert = bypassHumanCooldown === true || matchingRules.some((rule) =>
                    rule?.reassert_state === true
                    && (rule.targets?.[tk] !== undefined || rule.action !== undefined))

                let payload = result.payload
                this.log(`${dev.getName()} -> ${JSON.stringify(payload)}`)
                if (reassert) {
                    this.log(`${dev.getName()}: re-assert requested -- no-op suppression bypassed`, 'debug')
                }
                dev.receiveCommand(payload, DeviceCommandSource.AUTOMATION, { bypassNoOpSuppression: reassert })
                dispatchedCount++
            })
        }

        //  Run all tasks in parallel - MqttService queue handles global rate-limiting.
        try {
            await Promise.allSettled(tasks.map(t => t()))
        } catch (error) {
            this.log(`Task execution error: ${error.message}`, 'error')
        }

        return { dispatchedCount, humanSkippedCount }
    }

    /** Resolve this automation's target devices from its rules' own "targets:" maps --
     * @returns {Map<string, DeviceBase>} map of target key -> mechanism */
    loadDevices() {
        const result = new Map()
        const declared = this.#declaredTargetKeys()
        if (declared.length === 0) return result

        //  Build key -> [device] index over the live container once per call.
        const byKey = new Map()
        for (const [name, dev] of Object.entries(DeviceContainer.getAll({ includeBridge: false }))) {
            const key = toTargetKey(name)
            if (!byKey.has(key)) byKey.set(key, [])
            byKey.get(key).push(dev)
        }
        for (const [key, devs] of byKey) {
            if (devs.length > 1) {
                this.log(
                    `Duplicate target key "${key}": ${devs.map(d => `"${d.getName()}"`).join(' and ')} collapse onto it -- only one can be addressed`,
                    'warn'
                )
            }
        }

        let resolvedCount = 0
        for (const key of declared) {
            const candidates = byKey.get(key) ?? []
            if (candidates.length === 0) {
                this.log(`Declared target "${key}" not found in device container -- rules referencing it stay inert`, 'warn')
                continue
            }
            const device = candidates[0]
            if (!(device instanceof Mechanism)) {
                this.log(
                    `Declared target "${key}" resolves to a ${device.constructor.name}, expected a mechanism -- excluded from dispatch`,
                    'warn'
                )
                continue
            }
            result.set(key, device)
            resolvedCount++
        }

        if (resolvedCount < declared.length) {
            this.log(`${resolvedCount}/${declared.length} declared targets resolved; see warnings above`, 'warn')
        } else {
            this.log(`${resolvedCount} target device(s) resolved: [${[...result.keys()].join(', ')}]`, 'debug')
        }
        return result
    }

    /** Collect the union of target keys declared across all rules' "targets:"
     * @private
     * @returns {string[]} Declared target keys (empty when no rule declares any) */
    #declaredTargetKeys() {
        const out = []
        const seen = new Set()
        for (const rule of (this.config?.rules ?? [])) {
            const targets = rule?.targets
            if (!targets || typeof targets !== 'object') continue
            for (const key of Object.keys(targets)) {
                if (key && !seen.has(key)) {
                    seen.add(key)
                    out.push(key)
                }
            }
        }
        return out
    }

    /** Find a device by name. Subclasses may override to use a different container.
     * @param {string} name
     * @returns {DeviceBase|null} */
    findDevice(name) {
        return DeviceContainer.findByName(name)
    }

    /** Blinds-specific helper: resolve multiple position commands.
     * @param {Array} commands - Array of target values (numbers, 'CLOSE', 'OPEN') from all matching rules
     * @returns {'CLOSE'|'OPEN'|number|null} The resolved command, or null if no valid commands */
    blindsResolveLowestPosition(commands) {
        if (!commands || commands.length === 0) return null

        //  Resolve each command to a numeric position for comparison.
        const resolved = commands.map(c => {
            if (c === 'CLOSE') return 0
            if (c === 'OPEN') return 100
            if (typeof c === 'number') return c
            return null
        }).filter(c => c !== null)

        if (resolved.length === 0) return null

        const minPos = Math.min(...resolved)

        //  Map back to original representation.
        if (minPos === 0) return 'CLOSE'
        if (minPos === 100) return 'OPEN'
        return minPos
    }

    /** Blinds-specific helper: full resolveCommand implementation for blinds.
     * @param {DeviceBase} device - Target device
     * @param {string} targetId - Rule-target key for the device -- its friendly name trimmed, whitespace collapsed to underscores (see toTargetKey in lib/string.js)
     * @param {Array} matchingRules - Array of rules whose conditions matched
     * @returns {Object|null} Object with payload property, or null */
    blindsResolveCommand(device, targetId, matchingRules) {
        //  Collect commands from all matching rules for this target.
        const commands = []
        for (const rule of matchingRules) {
            const cmd = rule.targets?.[targetId]
            if (cmd !== undefined) {
                commands.push(cmd)
            }
        }

        const result = this.blindsResolveLowestPosition(commands)
        if (result === null) return null

        //  Resolve payload.
        let payload
        if (typeof result === 'number') {
            payload = { position: result }
        } else {
            payload = result
        }

        return { payload }
    }

    /** Resolve a command for a single device given all matching rules.
     * @param {DeviceBase} device - Target device
     * @param {string} targetKey - Rule-target key identifying the target device (see toTargetKey in lib/string.js)
     * @param {Array} matchingRules - Array of rules whose conditions matched
     * @returns {Object|null} Object with payload and optional skip flag, or null */
    resolveCommand(device, targetKey, matchingRules) {
        throw new NotImplementedError('resolveCommand() must be implemented by subclass')
    }

    /** Switches-style resolveCommand implementation: EVERY matching rule acts.
     *
     * Every matching rule that declares this target contributes to one command, folded in
     * config order so a later, more specific rule refines the earlier one instead of being
     * shadowed by it -- structured payloads merge field-wise (their `brightness` maps merge
     * per channel), a plain ON/OFF contributes only its `state`, and a scalar OPEN/CLOSE is
     * terminal. Rules owning disjoint targets are unaffected: each device still gets exactly
     * one command per run. A single contribution yields exactly the payload the old
     * first-match-wins rule produced, so existing configs keep their behavior.
     * @param {DeviceBase} device - Target device (unused; present for
     * @param {string} targetId - Rule-target key for the device -- its friendly name trimmed, whitespace collapsed to underscores (see toTargetKey in lib/string.js)
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @returns {{payload: object|string}|null} Object with payload, or null */
    simpleResolveCommand(device, targetId, matchingRules) {
        let merged = null
        for (const rule of matchingRules) {
            const cmd = rule.targets?.[targetId]
            if (cmd === undefined) continue
            merged = this.#mergeSimpleCommand(merged, cmd)
        }

        if (merged === null) return null
        return { payload: merged }
    }

    /** Fold one matching rule's command for a target into the accumulated payload.
     * @private
     * @param {object|string|null} accumulated - Payload built from the rules seen so far
     * @param {*} command - This rule's raw target value: ON/OFF, OPEN/CLOSE, a position, or a structured map
     * @returns {object|string|null} Accumulated payload after applying this command */
    #mergeSimpleCommand(accumulated, command) {
        if (command === null || command === undefined) return accumulated

        //  Structured commands are already device-native payloads ({brightness}, {state}, ...).
        //  The per-channel brightness map merges channel-wise; every other field wins whole.
        if (typeof command === 'object') {
            if (accumulated === null || typeof accumulated === 'string') return { ...command }
            const out = { ...accumulated }
            for (const [key, value] of Object.entries(command)) {
                const isBrightness = key === 'brightness'
                    && value && typeof value === 'object' && !Array.isArray(value)
                if (isBrightness && out.brightness && typeof out.brightness === 'object') {
                    out.brightness = { ...out.brightness, ...value }
                } else {
                    out[key] = value
                }
            }
            return out
        }

        const upper = String(command).toUpperCase()
        if (upper === 'OPEN' || upper === 'CLOSE') return upper

        const piece = (upper === 'ON' || upper === 'OFF')
            ? { state: upper }
            : { position: Number(command) }

        if (accumulated === null || typeof accumulated === 'string') return piece
        return { ...accumulated, ...piece }
    }

    //  Private helpers.

    /** Detect a `time_of_day` gate anywhere in one condition group, recursing through the
     * `any_of` / `all_of` sub-groups exactly like #collectSubjectRefs() walks them. A gate
     * nested in an `any_of` gates the rule just as a top-level one does, so it must scope the
     * `once` marker too -- otherwise a rule whose window list lives inside an `any_of` gets a
     * single all-day budget and an early firing silently eats the later window's slot.
     *
     * Protected API: also drives the marker keys of speech automations that reuse
     * {@link hasActedToday} / {@link markActedToday} instead of the device flow.
     * @param {Record<string, unknown>|null|undefined} conds - Condition group from YAML
     * @returns {boolean} true when a `time_of_day` gate exists at any depth */
    declaresTimeWindow(conds) {
        if (!conds || typeof conds !== 'object' || Array.isArray(conds)) return false
        if (conds['time_of_day'] !== undefined) return true
        for (const list of [conds.any_of, conds.all_of]) {
            if (!Array.isArray(list)) continue
            for (const sub of list) {
                if (this.declaresTimeWindow(sub)) return true
            }
        }
        return false
    }

    /** Build the Redis key for a rule's daily "once" marker. Rules that declare a
     * `time_of_day` gate -- at the top level or nested in `any_of`/`all_of` -- get one slot
     * per window, so a pre-dawn firing never consumes the dusk slot.
     *
     * Protected API -- see {@link hasActedToday} / {@link markActedToday}.
     * @param {Object} rule - Rule object carrying an `once: true` flag
     * @param {string|null} period - Context time-of-day period ('morning' ... 'night')
     * @returns {string} Redis key for the marker */
    onceMarkerKey(rule, period) {
        const base = `auto:${this.name}:once:${slugify(rule.name)}`
        const declaresWindow = this.declaresTimeWindow(rule.conditions)
        return declaresWindow && typeof period === 'string' && period !== '' ? `${base}:${period}` : base
    }

    /** Check whether an `once` rule has already consumed its action slot today.
     *
     * Protected API shared by the device flow and by speech automations that speak
     * instead of commanding devices: the marker lives in Redis under
     * `auto:<automation>:once:<slug>` (suffixed with the period for rules declaring a
     * `time_of_day` gate) and fails open -- a Redis outage reports "not yet acted".
     * @param {Object} rule - Rule object carrying an `once: true` flag
     * @param {string|null} [period] - Context time-of-day period; scopes the lookup per window
     * @returns {Promise<boolean>} true if this rule already acted in this window today */
    async hasActedToday(rule, period) {
        try {
            const stored = await CacheService.get(this.onceMarkerKey(rule, period))
            return Boolean(stored && stored.date === temporal.getLocalDayString())
        } catch (_) {
            //  Redis unavailable / parse issue -- allow the automation to proceed.
            return false
        }
    }

    /** Consume an `once` rule's action slot for this window by writing its marker.
     *
     * Protected API -- see {@link hasActedToday}. Forced runs deliberately do not call
     * this, so a manual poke never eats the day's slot.
     * @param {Object} rule - Rule object carrying an `once: true` flag
     * @param {string|null} [period] - Context time-of-day period; scopes the write per window
     * @returns {Promise<void>} */
    async markActedToday(rule, period) {
        try {
            const ok = await CacheService.set(
                this.onceMarkerKey(rule, period),
                { date: temporal.getLocalDayString(), at: Date.now() },
                ONCE_MARKER_TTL_SECONDS
            )
            if (!ok) {
                this.log(`Failed to store once-marker for rule "${rule.name}"`, 'warn')
            }
        } catch (error) {
            this.log(`Error storing once-marker for rule "${rule.name}": ${error.message}`, 'warn')
        }
    }
    /** Epoch-ms instant for the given local clock hour on the current calendar day.
     * @private
     * @param {number} hour - Hour of day (0-24, fractional allowed).
     * @returns {number} Epoch milliseconds at that clock time today. */
    #todayAtHour(hour) {
        const now = new Date()
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
            + Math.round(hour * 3_600_000)
    }

    /** Resolve one merged-gate candidate to an absolute epoch-ms instant.
     * @private
     * @param {*} spec - Candidate value from an after_latest_of / after_earliest_of list.
     * @param {{}} context - Evaluation context carrying sundawn/sundusk epoch-ms (or null).
     * @returns {number|null} Epoch-ms instant, or null when the candidate cannot be resolved. */
    #resolveGateInstant(spec, context) {
        if (typeof spec === 'string') {
            const normalized = spec.trim().toLowerCase()
            if (normalized === 'sundusk' || normalized === 'sunset') return context.sundusk ?? null
            if (normalized === 'sundawn' || normalized === 'sunrise') return context.sundawn ?? null
            const startHour = temporal.getPeriodStartHour(normalized)
            return startHour !== null ? this.#todayAtHour(startHour) : null
        }

        if (typeof spec === 'number' && Number.isFinite(spec)) {
            const hour = temporal.parseClockHour(spec)
            return hour !== null ? this.#todayAtHour(hour) : null
        }

        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            if ('hour' in spec) return this.#resolveGateInstant(spec.hour, context)
            if ('time_of_day' in spec) return this.#resolveGateInstant(spec['time_of_day'], context)
        }

        return null
    }

    /** Whether a value is one of the recognized sun-event shorthands usable as an `hour:` bound.
     * @private
     * @param {*} value - Candidate bound value from an `hour:` condition object.
     * @returns {boolean} True when the value is 'sunrise'/'sundawn', 'sunset' or 'sundusk'. */
    #isSunShorthand(value) {
        return typeof value === 'string' && ['sunrise', 'sundawn', 'sunset', 'sundusk'].includes(value.trim().toLowerCase())
    }

    /** Resolve a single `hour:` bound to a finite number on the hour axis.
     * @private
     * @param {*} value - Bound value from an `hour:` condition object.
     * @param {{}} context - Evaluation context carrying sundawn/sundusk epoch-ms (or null).
     * @param {number} startOfTodayMs - Epoch ms at local midnight, used to derive fractional hours.
     * @returns {number} Resolved numeric hour, or NaN when the value cannot be resolved. */
    #resolveHourValue(value, context, startOfTodayMs) {
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase()
            let instantMs = null
            if (normalized === 'sunrise' || normalized === 'sundawn') instantMs = context.sundawn ?? null
            else if (normalized === 'sunset' || normalized === 'sundusk') instantMs = context.sundusk ?? null
            if (instantMs !== null) {
                return Number.isFinite(instantMs) ? (instantMs - startOfTodayMs) / 3_600_000 : NaN
            }
        }
        const clockHour = temporal.parseClockHour(value)
        return (clockHour !== null) ? clockHour : NaN
    }

    /** Evaluate an `hour:` bounds object against the current time.
     * @private
     * @param {number} nowHour - Current local clock hour (integer 0-23).
     * @param {{lt?: number|string, lte?: number|string, gt?: number|string, gte?: number|string}} constraints - Hour bounds object.
     * @param {{}} context - Evaluation context carrying sundawn/sundusk epoch-ms (or null).
     * @returns {boolean} True when all present bounds hold. */
    #matchesHourBounds(nowHour, constraints, context) {
        const ops = ['lt', 'lte', 'gt', 'gte']
        const precise = ops.some((op) => {
            const bound = constraints[op]
            if (bound === undefined) return false
            //  Sun tokens and named anchors ('midnight'/'noon') arrive as strings and must be
            //  resolved to fractional hours; comparing them raw would fail closed on a string.
            return this.#isSunShorthand(bound) || temporal.isNatoClockBound(bound) || temporal.isClockWordBound(bound)
        })
        if (!precise) return this.#matchesNumericRange(nowHour, constraints)

        //  At least one sun shorthand -> precise path: resolve every bound to a fractional hour.
        const startOfTodayMs = new Date().setHours(0, 0, 0, 0)
        const nowFractional = (Date.now() - startOfTodayMs) / 3_600_000
        const resolved = {}
        for (const op of ops) {
            if (constraints[op] === undefined) continue
            const value = this.#resolveHourValue(constraints[op], context, startOfTodayMs)
            if (!Number.isFinite(value)) return false // unresolvable/malformed bound -> fail closed
            resolved[op] = value
        }
        return this.#matchesNumericRange(nowFractional, resolved)
    }

    /** Check if a numeric value satisfies range bounds defined in config.
     * @private
     * @param {number|null} value - The sensor reading to check
     * @param {Object} constraints - Range bounds (lt, lte, gt, gte)
     * @returns {boolean} */
    #matchesNumericRange(value, constraints) {
        if (value === null || value === undefined) return false

        if (constraints.lt !== undefined && !(value < constraints.lt)) return false
        if (constraints.lte !== undefined && !(value <= constraints.lte)) return false
        if (constraints.gt !== undefined && !(value > constraints.gt)) return false
        if (constraints.gte !== undefined && !(value >= constraints.gte)) return false

        return true
    }

    /** Normalize presence condition to an object of { name: boolean } pairs.
     * @private
     * @param {string|string[]|Object} presence - Raw condition value from YAML
     * @returns {Object} Map of device name to boolean */
    #normalizePresenceCondition(presence) {
        if (typeof presence === 'string') {
            return { [presence]: true }
        }

        if (Array.isArray(presence)) {
            const result = {}
            for (const name of presence) {
                result[name] = true
            }
            return result
        }

        //  Already an object.
        return presence
    }

    /** Normalize a video_player condition to an object of { host: string[] } pairs.
     * @private
     * @param {Object} videoPlayer - Raw condition value from YAML (host -> status or status list)
     * @returns {Object} Map of host name to array of accepted statuses */
    #normalizeVideoPlayerCondition(videoPlayer) {
        const result = {}
        for (const [host, value] of Object.entries(videoPlayer ?? {})) {
            result[host] = Array.isArray(value) ? value : [value]
        }
        return result
    }

    /** Split a "<domain>:<subject>" reference.
     * @private
     * @param {string} ref - Raw subject reference from a condition value
     * @returns {{domain: string, subject: string}} Parsed domain and subject */
    #parseSubjectRef(ref) {
        const str = String(ref ?? '')
        const idx = str.indexOf(':')
        if (idx <= 0) return { domain: '', subject: str }
        return { domain: str.slice(0, idx), subject: str.slice(idx + 1) }
    }

    /** Whether any subject this automation monitors recorded a state transition after our last.
     * @private
     * @returns {Promise<boolean>} true when a relevant change occurred (or none can be determined) */
    async #changedSinceLastEvaluation() {
        const subjects = this.#collectMonitoredSubjects()
        if (!subjects || subjects.length === 0) return true
        if (!DatabaseService.isAvailable()) return true   // fail open during an outage
        const baseline = this.#lastEvaluatedAtMs ?? 0
        for (const { domain, subject } of subjects) {
            const ts = await DatabaseService.lastTransitionTs(domain, subject)
            if (ts != null && ts > baseline) return true
        }
        return false
    }

    /** Derive the set of {domain, subject} pairs this automation reacts to by scanning its rules'
     * @private
     * @returns {Array<{domain: string, subject: string}>} Monitored subjects (may be empty) */
    #collectMonitoredSubjects() {
        if (this.#monitoredConfigRef === this.config && Array.isArray(this.#monitoredSubjects)) {
            return this.#monitoredSubjects
        }
        const seen = new Set()
        const out = []
        const add = (domain, subject) => {
            const key = `${domain}:${subject}`
            if (!seen.has(key)) { seen.add(key); out.push({ domain, subject }) }
        }
        for (const rule of (this.config.rules ?? [])) {
            this.#collectSubjectRefs(rule?.conditions, add)
        }
        this.#monitoredConfigRef = this.config
        this.#monitoredSubjects = out
        return out
    }

    /** Recursively collect monitored-subject references from one condition group -- its own.
     * @private
     * @param {Record<string, unknown>|null|undefined} conds - Condition group from YAML
     * @param {(domain: string, subject: string) => void} add - Accumulator callback */
    #collectSubjectRefs(conds, add) {
        if (!conds || typeof conds !== 'object' || Array.isArray(conds)) return
        if (conds.presence !== undefined) {
            for (const name of Object.keys(this.#normalizePresenceCondition(conds.presence))) add('network', name)
        }
        if (conds['video_player'] !== undefined) {
            for (const host of Object.keys(this.#normalizeVideoPlayerCondition(conds['video_player']))) add('videoPlayer', host)
        }
        for (const list of [conds.any_of, conds.all_of]) {
            if (Array.isArray(list)) {
                for (const sub of list) this.#collectSubjectRefs(sub, add)
            }
        }
    }

    /** Evaluate the top-level `video_player_suppression` stand-down guard.
     * @private
     * @returns {Promise<boolean>} true while the automation should stand down */
    async #evaluateVideoPlayerSuppression() {
        const suppression = this.#normalizeVideoPlayerCondition(this.config.video_player_suppression)
        for (const [host, statuses] of Object.entries(suppression)) {
            const status = await videoPlayerMonitor.getStatus(host)
            const effective = status ?? VIDEO_PLAYER_OFFLINE
            if (statuses.includes(effective)) {
                this.log(`video_player_suppression: "${host}" is ${effective}`, 'debug')
                return true
            }
        }
        return false
    }

    /** Public accessor so subclasses that override execute() can honor the same
     * @returns {Promise<boolean>} true while the automation should stand down */
    async isVideoPlayerSuppressionActive() {
        if (!this.config.video_player_suppression) return false
        return await this.#evaluateVideoPlayerSuppression()
    }
}
