/**
 * Abstract base class for rule-based (YAML-driven) automations.
 *
 * Extends {@link ../automationBase.js} with context building (sensor readings,
 * time-of-day periods, network presence), YAML config parsing, condition
 * evaluation (including optional `season` conditions and per-rule daily `once`
 * markers), an optional top-level `video_player_suppression` stand-down guard,
 * and a template-method `execute()` flow. Target devices are derived from the
 * rules' own "targets:" maps and resolved against the live DeviceContainer;
 * subclasses may override {@link loadDevices} for custom device structures and
 * implement the {@link resolveCommand} hook.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
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
import { parseDocument as yamlParseDocument } from 'yaml'
import { slugify, toTargetKey } from '../../lib/string.js'

import DeviceContainer from '../../device/container/deviceContainer.js'
import Mechanism from '../../device/type/mechanism.js'
import networkPresence from '../../monitor/networkPresence.js'
import videoPlayerMonitor from '../../monitor/videoPlayerMonitor.js'
import AutomationContainer from '../container/automationContainer.js'

import AutomationBase from './automationBase.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'

/**
 * Maximum consecutive context-build failures before escalating from warn to error.
 * @type {number}
 */
const CONTEXT_FAILURE_ESCALATION_THRESHOLD = 5

/**
 * TTL for per-rule daily "once" markers stored in Redis (48 hours, seconds).
 * The stored calendar day is authoritative -- the TTL only keeps keys self-cleaning.
 * @type {number}
 */
const ONCE_MARKER_TTL_SECONDS = 172_800

/**
 * Enumerated status meaning "no usable player signal" (host offline, player not answering, or
 * nothing recorded at all). It is a real, always-available status: unlike the raw detail behind
 * it, rules match it by simply listing `offline`, so playback requirements (`[playing]`) stay
 * inert while restore/hand-back rules opt in explicitly.
 */
const VIDEO_PLAYER_OFFLINE = 'offline'

/**
 * Legacy kebab-case condition keys that were unified to snake_case.
 * Kept as a lookup table so activation-time validation can name the exact
 * replacement when it finds a stale rule; these keys no longer evaluate.
 * @type {Readonly<Record<string,string>>}
 */
const LEGACY_CONDITION_KEY_RENAMES = Object.freeze({
    'time-of-day': 'time_of_day',
    'video-player': 'video_player',
    'state-changed-ago-minutes': 'state_changed_ago_minutes'
})

/**
 * Recursively scan a rule's conditions tree for legacy kebab-case condition keys.
 *
 * Walks plain object mappings and recurses into composite group values
 * (`any_of` / `all_of` sub-group arrays), so a stale key nested anywhere in a
 * boolean tree is reported with its dot path (e.g. `any_of[1].time-of-day`).
 *
 * @param {object|Array|null|undefined} node - Condition mapping, composite value, or anything else
 * @param {string} [path=''] - Dot-path prefix used in report entries
 * @returns {Array<{key: string, renameTo: string, where: string}>} One entry per legacy key found
 */
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
    /**
     * Consecutive context-build failure count for log-level escalation.
     * Resets to 0 on each successful build.
     * @type {number}
     */
    #contextFailCount = 0

    /**
     * Epoch-ms timestamp up to which monitored-state transitions have been consumed by this
     * automation's evaluations. Used by the opt-in react-on-change gate so scheduled ticks stay
     * quiet until a new transition occurs; initialized at construction time so changes recorded
     * before this process started are not re-acted on by timers.
     * @type {number}
     */
    #lastEvaluatedAtMs = Date.now()

    /**
     * Cached list of {domain, subject} pairs this automation monitors, derived from its rules'
     * presence / video_player conditions. Recomputed when the config object is replaced (tests,
     * reloads).
     * @type {Array<{domain: string, subject: string}>|null}
     */
    #monitoredSubjects = null

    /**
     * Config reference that the cached #monitoredSubjects was computed against.
     * @type {{rules?: unknown}|null}
     */
    #monitoredConfigRef = null

    /**
     * Construct a rule-based automation.
     *
     * Synchronously reads and parses the YAML configuration file. If loading
     * fails, an empty config is used and an error is logged.
     *
     * @param {object} options - Constructor options
     * @param {string} options.name - Automation display name
     * @param {string} options.configPath - Filesystem path to YAML config
     */
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

    /**
     * Log how many rules were loaded. Uses debug level so it's visible but not noisy.
     * @private
     */
    #logConfigLoaded() {
        this.log(`Config loaded: ${this.config.rules?.length ?? 0} rules defined`, 'debug')
    }

    /**
     * Activation-time guard for the snake_case condition-key unification.
     *
     * Scans every rule's conditions tree (including nested any_of/all_of groups)
     * for legacy kebab-case keys and logs a loud per-rule warning naming each
     * stale key, its location, and the replacement. Warn-only by design: a
     * stale key simply stops matching (fail-closed evaluation), so startup must
     * not be blocked -- but the hint makes the required rename impossible to
     * miss in the log.
     * @private
     */
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

    /**
     * Lifecycle hook -- fail-fast target validation before this automation becomes active.
     *
     * Runs BEFORE super.init() subscribes triggers / starts timers, so an instance whose
     * declared targets all failed validation dies cleanly with no dangling subscriptions.
     * Validation goes through the virtual loadDevices() seam: subclasses supplying their own
     * device structure (or declaring no device targets at all -- e.g., speech-only or pure
     * invoke_automation automations) are unaffected and simply pass through.
     *
     * @throws {Error} When rules declare target devices but none of them resolves to a valid
     *   mechanism in the live container (per-key warnings were already logged by loadDevices())
     */
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

    /**
     * Gather current sensor readings and time-of-day into a context object.
     *
     * Reads illuminance and temperature from configured sensors (via DeviceContainer),
     * and determines the current time period using {@link ../../lib/date.js}.
     * Override in subclasses to inject additional context fields.
     *
     * @returns {Promise<{illuminance: number|null, temperature: number|null, timeOfDay: string}>}
     */
    async buildContext() {
        // Dynamically read every sensor defined in config.sensors.
        // Each entry maps a logical name -> Zigbee device name.
        // The logical name also serves as the property key on the device's state object.
        // E.g., { illuminance: 'Outdoor Luminance' } reads state.illuminance from that device.
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

        // Time period -- always included regardless of config
        ctx.timeOfDay = temporal.getCurrentTimePeriod()

        // Sun-event instants (epoch ms) powering merged-gate conditions ("sundawn"/"sundusk"); null when geo is unconfigured/invalid.
        const sunTimes = solar.getSunTimes(new Date())
        ctx.sundawn = sunTimes.sundawn ? sunTimes.sundawn.getTime() : null
        ctx.sundusk = sunTimes.sundusk ? sunTimes.sundusk.getTime() : null

        return ctx
    }

    /**
     * Evaluate a single rule's conditions against the built context.
     *
     * Top-level conditions form an implicit AND group; the composite keys `any_of:` (OR gate)
     * and `all_of:` (explicit AND gate) combine lists of nested condition groups -- which may
     * themselves nest further composites into arbitrary boolean expression trees (see
     * #evaluateConditionGroup()). Scalar checks cover `time_of_day`, actual wall-clock `hour`,
     * `season`, numeric sensor ranges (`illuminance`, `temperature`, ...), and `presence`
     * constraints, plus the merged-gate conditions `after_latest_of` / `after_earliest_of`
     * (fire once now has passed the latest/earliest instant of a list of sun/clock candidates).
     * A condition key that is absent or falsy is treated as "always passes".
     *
     * @param {Record<string, unknown>} [conditions] - Conditions object from YAML rule
     * @param {{illuminance?: number|null, temperature?: number|null, timeOfDay: string, sundawn: number|null, sundusk: number|null}} context
     * @returns {Promise<boolean>}
     */
    async conditionsMatch(conditions, context) {
        if (!conditions) return true // no conditions = always matches
        return this.#evaluateConditionGroup(conditions, context)
    }

    /**
     * Recursively evaluate one condition group.
     *
     * Every scalar entry must pass (implicit AND); on top of that two composite keys combine
     * lists of nested groups:
     *   - `any_of:` -- passes when AT LEAST ONE sub-group fully matches; an empty or non-array
     *     value fails closed (nothing can satisfy "any of" nothing). Multiple matching
     *     sub-groups are fine -- the gate is inclusive, not exclusive.
     *   - `all_of:` -- passes only when EVERY sub-group fully matches; an empty list passes
     *     vacuously (mirrors "no conditions = always matches"); a non-array value fails closed.
     * Sub-groups are full condition groups in their own right and may nest further composites.
     * A subgroup that is not a plain object fails closed rather than passing silently.
     *
     * @private
     * @param {Record<string, unknown>|null|undefined} group - Condition group from YAML
     * @param {{illuminance?: number|null, temperature?: number|null, timeOfDay: string, sundawn: number|null, sundusk: number|null}} context
     * @returns {Promise<boolean>} True when every gate in the group holds.
     */
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

    /**
     * Evaluate one condition group's scalar entries against the built context -- the historical
     * conditionsMatch() body: time_of_day, hour, season, presence, video_player,
     * state_changed_ago_minutes, after_latest_of/after_earliest_of merged gates, and dynamic
     * numeric sensor ranges. Composite keys (`any_of`/`all_of`) are handled by the caller and
     * skipped here so their list values are never treated as sensor bounds.
     *
     * @private
     * @param {Record<string, unknown>} conds - Scalar condition entries from YAML
     * @param {{illuminance?: number|null, temperature?: number|null, timeOfDay: string, sundawn: number|null, sundusk: number|null}} context
     * @returns {Promise<boolean>}
     */
    async #checkScalarConditions(conditions, context) {

        // time_of_day check
        if (conditions['time_of_day']) {
            const periods = Array.isArray(conditions['time_of_day'])
                ? conditions['time_of_day']
                : [conditions['time_of_day']]

            if (!periods.includes(context.timeOfDay)) {
                return false
            }
        }

        // season check

        // Actual wall-clock hour check -- independent of the calendar-based day periods, so a rule can
        // gate on "it is late" without caring which period label that hour carries. A bare number requires
        // exactly that hour; a bounds object ({lt|lte|gt|gte}) ranges over hours 0-23 like any sensor
        // condition. Anything else fails closed rather than passing silently.
        if (conditions.hour !== undefined) {
            const nowHour = new Date().getHours()
            const constraint = conditions.hour
            if (typeof constraint === 'number') {
                if (!Number.isFinite(constraint) || Math.trunc(constraint) !== nowHour) return false
            } else if (constraint && typeof constraint === 'object' && !Array.isArray(constraint)) {
                // A bound may be a sun shorthand ('sunrise'/'sunset', ...) resolving to today's real
                // fractional hour; plain numbers keep integer-hour semantics. Absent ops impose no bound.
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

        // presence check
        if (conditions.presence !== undefined) {
            const expected = this.#normalizePresenceCondition(conditions.presence)
            for (const [deviceName, shouldBeOnline] of Object.entries(expected)) {
                const isOnline = await networkPresence.isOnline(deviceName)
                if (isOnline !== shouldBeOnline) {
                    return false
                }
            }
        }

        // video player status check
        if (conditions['video_player'] !== undefined) {
            const expected = this.#normalizeVideoPlayerCondition(conditions['video_player'])
            for (const [host, statuses] of Object.entries(expected)) {
                const status = await videoPlayerMonitor.getStatus(host)
                // No recorded state (host not configured / monitor never swept it) counts as the
                // enumerated `offline` status, so restore/hand-back rules that accept an absent
                // player keep working while playback requirements stay inert. The raw detail
                // behind it (unreachable vs. presence-offline) is the monitor's own concern.
                const effective = status ?? VIDEO_PLAYER_OFFLINE
                if (!statuses.includes(effective)) {
                    return false
                }
            }
        }

        // state-change recency check -- require that the last recorded transition for each
        // listed "<domain>:<subject>" was at least N minutes ago. Backed by
        // DatabaseService.lastTransitionTs(). A subject with no history satisfies any bound;
        // an unavailable store fails open so a downed database never blocks an automation.
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

        // Sun/clock merged gates -- fire once now has passed the LATEST (after_latest_of) or EARLIEST
        // (after_earliest_of) of a list of candidate instants. Each candidate is a sun shorthand
        // ("sundusk"/"sundawn"), a clock hour (number / {hour:N}), or a day-period name ('morning', ...).
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

        // Dynamic: any remaining condition key -> numeric range check against context.
        // Supports illuminance, temperature, humidity, pressure, or any future sensor type
        // defined in config.sensors without code changes.
        for (const [key, constraint] of Object.entries(conditions)) {
            if (key === 'time_of_day' || key === 'hour' || key === 'season' || key === 'presence' || key === 'video_player' || key === 'state_changed_ago_minutes' || key === 'after_latest_of' || key === 'after_earliest_of' || key === 'any_of' || key === 'all_of') continue // handled above / by the group evaluator

            if (constraint && typeof constraint === 'object') {
                const value = context[key]
                if (!this.#matchesNumericRange(value, constraint)) {
                    return false
                }
            }
        }

        return true
    }

    // -----------------------------------------------------------------------
    // Template method - common execute flow
    // -----------------------------------------------------------------------

    /**
     * Main execution flow shared by all rule-based automations.
     * Subclasses should NOT override this; instead implement loadDevices()
     * and resolveCommand() hooks.
     * 
     * @param {Object} [triggerData] - Info about what triggered this run
     * @param {string} [triggerData.trigger] - Trigger source identifier
     * @param {boolean} [triggerData.force] - When true (e.g., "/automation force" or an `invoke_automation` action), bypasses both checks and writes of
     *   silent-period suppression and per-rule once-per-day markers (both checking and writing them) as well as per-device
     *   human-interaction cooldowns; the top-level video_player_suppression stand-down guard is never bypassed
     */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        const forced = triggerData?.force === true
        this.log(`Triggered by: ${triggerSource}`, 'info')

        // Opt-in react-on-change gating (config.trigger_on_change_only). When enabled,
        // scheduled ('timer') safety-net ticks are skipped entirely unless one of this
        // automation's monitored subjects actually transitioned since our last evaluation.
        // Event-driven runs (a real EventBus topic) and forced runs always proceed -- they
        // already represent an explicit reason to act. This is what stops a sticky
        // automation from re-firing on every timer tick while its conditions still hold.
        if (this.config.trigger_on_change_only === true && !forced && triggerSource === 'timer') {
            if (!await this.#changedSinceLastEvaluation()) {
                this.log('No monitored state change since last run -- skipping scheduled tick', 'debug')
                return
            }
        }

        // Reached here => we will evaluate now; advance the consumed-changes baseline so
        // subsequent scheduled ticks stay quiet until a new transition occurs.
        this.#lastEvaluatedAtMs = Date.now()

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

        // Top-level video-player stand-down guard (video_player_suppression): while
        // any listed player is in one of its listed statuses, the automation stands
        // down so it does not fight another automation (e.g., Home Theater Mode)
        // over the same devices. Individual rules may opt out via
        // ignore_video_player_suppression. Unlike the silent period, this guard is
        // NOT bypassed by a forced run -- forcing must not create device fights.
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
            // Reset failure counter on success
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

        // Collect all matching rules
        const matchingRules = []
        for (const rule of rules) {
            // Stand-down guard active: only rules that opted out participate.
            if (suppressionActive && rule.ignore_video_player_suppression !== true) continue

            // Invoke-only rules (forced_only): respond solely to forced/delegated runs -- e.g.,
            // late-night light restore handed over by a room's home-theater automation on pause.
            // Natural timer/sensor ticks skip them entirely so they can never fire uninvited in
            // windows we deliberately keep free of autonomous action.
            if (rule.forced_only === true && !forced) {
                this.log(`Rule "${rule.name}" is invoke-only and this is a natural run, skipping`, 'debug')
                continue
            }

            try {
                const match = await this.conditionsMatch(rule.conditions, context)
                if (!match) continue

                // Per-rule daily "once" marker -- at most one action per calendar day.
                // A forced run bypasses this check entirely and also skips writing the
                // marker afterwards, so it can re-fire an already-consumed rule without
                // consuming anyone else's once-per-day budget.
                if (rule.once && triggerData?.force !== true && await this.#hasActedToday(rule, context.timeOfDay)) {
                    const scope = rule.conditions?.['time_of_day'] ? ` during ${context.timeOfDay}` : ''
                    this.log(`Rule "${rule.name}" already acted today${scope}, skipping`, 'debug')
                    continue
                }

                matchingRules.push(rule)
                this.log(`Rule matched: "${rule.name}"`, 'debug')
            } catch (error) {
                this.log(`Error evaluating rule "${rule.name}": ${error.message}`, 'error')
            }
        }

        if (matchingRules.length === 0) {
            this.log('No rules matched, no action', 'debug')
            return
        }

        // Fire any `invoke_automation` actions declared by matched rules -- e.g., hand a
        // room's rollers back to their owner when the player goes offline, or delegate
        // light restore to the ambient-lights automation on pause. Runs before device
        // dispatch so an automation whose only action is invoking still works; each unique
        // target fires exactly once per run regardless of how many rules referenced it.
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

        // Device targets are resolved here -- AFTER rule matching and invocations fired -- so
        // automations declaring no device targets skip dispatch while their side-effect actions
        // above still ran. Startup validation guarantees instances whose declared targets all
        // failed never reach execute() in the first place.
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

        // Consume the daily slot for `once` rules when we either acted on a device, deferred to
        // recent human interaction, or fired an invoke_automation action -- after that, humans
        // keep full control until the next day. If nothing happened at all, keep retrying on
        // later ticks. A forced run neither checks nor writes these markers, so a manual/
        // delegated poke never consumes an automation's once-per-day budget.
        if ((dispatchedCount > 0 || humanSkippedCount > 0 || invokedCount > 0) && triggerData?.force !== true) {
            for (const rule of matchingRules) {
                if (rule.once) {
                    await this.#markActedToday(rule, context.timeOfDay)
                }
            }
        }
    }

    /**
     * Normalize an `invoke_automation` spec into a list of {name, force} entries.
     *
     * Accepted forms (the first two are the original single-target syntax, kept fully
     * backward-compatible; the array forms let one rule hand off to several owners at once,
     * e.g. a home-theater "player gone" rule delegating both the roller owner and the
     * ambient-lights owner in a single rule):
     *   - "Name"                          -> [{ name: 'Name', force: false }]
     *   - { name: 'Name', force: true }   -> [{ name: 'Name', force: true }]
     *   - ['A', 'B']                      -> [{ name: 'A', force: false }, { name: 'B', force: false }]
     *   - [{ name: 'A', force: true }, 'B']-> [{ name: 'A', force: true }, { name: 'B', force: false }]
     *   - { names: ['A', 'B'], force: true } -> [{ name: 'A', force: true }, { name: 'B', force: true }]
     *
     * Unusable entries (non-string names, empty strings) are dropped rather than failing
     * closed, consistent with the rest of the rule engine's lenient parsing.
     *
     * @private
     * @param {string|Object|string[]|Object[]|null|undefined} spec - Raw `invoke_automation` value from a rule
     * @returns {Array<{name: string, force: boolean}>} Normalized entries (empty when the spec is absent or unusable)
     */
    #normalizeInvokeSpec(spec) {
        if (!spec) return []
        // Object with a `names` array: one shared force flag applied to every listed name.
        if (typeof spec === 'object' && !Array.isArray(spec) && Array.isArray(spec.names)) {
            const force = spec.force === true
            return spec.names
                .filter((n) => typeof n === 'string' && n)
                .map((n) => ({ name: n, force }))
        }
        // Array form: each element is a bare name or a {name, force} object.
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
        // Legacy single-target forms: bare string or {name, force}.
        const name = typeof spec === 'string' ? spec : spec?.name
        if (!name || typeof name !== 'string') return []
        return [{ name, force: typeof spec === 'object' && spec.force === true }]
    }

    /**
     * Dispatch exactly one consolidated command per resolved device, collecting candidate
     * commands from ALL matching rules (subclasses apply merge semantics such as "lowest
     * position wins" via resolveCommand). Prevents duplicate MQTT publishes when multiple
     * rules match simultaneously targeting the same device; recently-touched devices are
     * deferred unless this automation overrides the human-interaction cooldown.
     *
     * @private
     * @param {Map<string, DeviceBase>} devices - Resolved target key -> mechanism map
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @param {boolean} [bypassHumanCooldown=false] - When true (forced runs), per-device
     *   human-interaction cooldowns are skipped so an explicit operator poke wins over a recent touch
     * @returns {Promise<{dispatchedCount: number, humanSkippedCount: number}>} Outcome counters
     */
    async #dispatchDeviceCommands(devices, matchingRules, bypassHumanCooldown = false) {
        const tasks = []
        let dispatchedCount = 0   // devices that actually received a command
        let humanSkippedCount = 0 // devices deferred to recent human interaction

        for (const [targetKey, device] of devices) {
            // Capture loop variables in closure
            const tk = targetKey
            const dev = device

            tasks.push(async () => {
                // Skip recently touched devices (Redis-only check), unless this
                // automation overrides the human-interaction cooldown (e.g., home theater mode)
                // or the run is forced (an explicit operator poke wins over a recent touch).
                if (!this.getOverrideHumanInteraction()
                    && await this.checkAndLogHumanInteraction(dev, { bypassCooldown: bypassHumanCooldown })) {
                    humanSkippedCount++
                    return
                }

                // Collect per-target commands from every matching rule.
                // Simple automations may instead define a flat `action` field on the rule,
                // which applies uniformly to every listed device -- fall back to it when no
                // target-specific command was found.
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

                // Log every rule that contributed to this device's decision, by name. The
                // merge is most-closed-wins, so one CLOSE from a park rule silently outranks
                // every OPEN in the same tick; naming the contributors is what makes that
                // outcome traceable from the log instead of guessable.
                this.log(
                    `${dev.getName()}: merged ${contributions.length} contribution(s) [${contributions.join(', ')}]`,
                    'debug'
                )

                // Resolve via subclass hook - e.g., blinds use "lowest position wins"
                const result = this.resolveCommand(dev, tk, matchingRules)
                if (!result || result.skip) return

                let payload = result.payload
                this.log(`${dev.getName()} -> ${JSON.stringify(payload)}`)
                dev.receiveCommand(payload, DeviceCommandSource.AUTOMATION)
                dispatchedCount++
            })
        }

        // Run all tasks in parallel - MqttService queue handles global rate-limiting.
        // Await completion so callers can consume daily "once" markers afterwards.
        try {
            await Promise.allSettled(tasks.map(t => t()))
        } catch (error) {
            this.log(`Task execution error: ${error.message}`, 'error')
        }

        return { dispatchedCount, humanSkippedCount }
    }

    /**
     * Resolve this automation's target devices from its rules' own "targets:" maps --
     * there is no separate top-level declaration; the union of every key declared under
     * any rule defines the addressable set. Each key is looked up against the live
     * DeviceContainer registry via toTargetKey(name) (friendly name trimmed, whitespace
     * collapsed to underscores, casing preserved):
     *   - unknown keys -> warning naming the offending key, excluded from dispatch
     *   - keys resolving to a non-mechanism (sensor / remote / bridge) -> warning with
     *     the actual type class, excluded from dispatch
     *   - duplicate keys (two registered names collapsing onto one key) -> warning;
     *     the first registration wins
     * Rules declaring no targets at all yield an empty Map -- speech-only or pure
     * invoke_automation automations are valid and simply skip device dispatch.
     * Subclasses may override for custom device structures.
     * 
     * @returns {Map<string, DeviceBase>} map of target key -> mechanism
     */
    loadDevices() {
        const result = new Map()
        const declared = this.#declaredTargetKeys()
        if (declared.length === 0) return result

        // Build key -> [device] index over the live container once per call.
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

    /**
     * Collect the union of target keys declared across all rules' "targets:" maps,
     * preserving first-seen order. Pure read of this.config -- safe any time after
     * construction and independent of DeviceContainer state.
     * @private
     * @returns {string[]} Declared target keys (empty when no rule declares any)
     */
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

    /**
     * Find a device by name. Subclasses may override to use a different container.
     * @param {string} name
     * @returns {DeviceBase|null}
     */
    findDevice(name) {
        return DeviceContainer.findByName(name)
    }

    /**
     * Blinds-specific helper: resolve multiple position commands using
     * "lowest position wins" (most-closed-wins) semantics.
     * 
     * Useful for blind/roller-shutter automations where many rules may match
     * simultaneously and the final position should be the most closed one.
     *   - 'CLOSE' resolves to 0 (absolute lowest)
     *   - Numeric values stay as-is
     *   - 'OPEN' resolves to 100 (most open)
     * 
     * @param {Array} commands - Array of target values (numbers, 'CLOSE', 'OPEN') from all matching rules
     * @returns {'CLOSE'|'OPEN'|number|null} The resolved command, or null if no valid commands
     */
    blindsResolveLowestPosition(commands) {
        if (!commands || commands.length === 0) return null

        // Resolve each command to a numeric position for comparison
        const resolved = commands.map(c => {
            if (c === 'CLOSE') return 0
            if (c === 'OPEN') return 100
            if (typeof c === 'number') return c
            return null
        }).filter(c => c !== null)

        if (resolved.length === 0) return null

        const minPos = Math.min(...resolved)

        // Map back to original representation
        if (minPos === 0) return 'CLOSE'
        if (minPos === 100) return 'OPEN'
        return minPos
    }

    /**
     * Blinds-specific helper: full resolveCommand implementation for blinds.
     * Collects per-target commands from matching rules, resolves using
     * "lowest position wins" semantics, and wraps the result in a payload.
     * 
     * Subclasses can simply delegate: `return this.blindsResolveCommand(device, key, rules)`
     * 
     * @param {DeviceBase} device - Target device
     * @param {string} targetId - Rule-target key for the device -- its friendly name trimmed, whitespace collapsed to underscores (see toTargetKey in lib/string.js)
     * @param {Array} matchingRules - Array of rules whose conditions matched
     * @returns {Object|null} Object with payload property, or null
     */
    blindsResolveCommand(device, targetId, matchingRules) {
        // Collect commands from all matching rules for this target
        const commands = []
        for (const rule of matchingRules) {
            const cmd = rule.targets?.[targetId]
            if (cmd !== undefined) {
                commands.push(cmd)
            }
        }

        const result = this.blindsResolveLowestPosition(commands)
        if (result === null) return null

        // Resolve payload
        let payload
        if (typeof result === 'number') {
            payload = { position: result }
        } else {
            payload = result
        }

        return { payload }
    }

    /**
     * Resolve a command for a single device given all matching rules.
     * Subclasses must implement to define their own command resolution logic.
     * 
     * @param {DeviceBase} device - Target device
     * @param {string} targetKey - Rule-target key identifying the target device (see toTargetKey in lib/string.js)
     * @param {Array} matchingRules - Array of rules whose conditions matched
     * @returns {Object|null} Object with payload and optional skip flag, or null
     */
    resolveCommand(device, targetKey, matchingRules) {
        throw new NotImplementedError('resolveCommand() must be implemented by subclass')
    }

    /**
     * Switches-style resolveCommand implementation: the first matching rule
     * that defines a command for the target wins. ON/OFF become `{state}`
     * payloads, OPEN/CLOSE become bare state strings, numeric values become
     * `{position}` payloads, and structured object commands pass through
     * verbatim -- e.g., a dimmer's `{brightness: 50}` percentage request,
     * which the device maps into its per-channel level range at publish time.
     *
     * @param {DeviceBase} device - Target device (unused; present for
     *   resolveCommand signature parity)
     * @param {string} targetId - Rule-target key for the device -- its friendly name trimmed, whitespace collapsed to underscores (see toTargetKey in lib/string.js)
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @returns {{payload: object|string}|null} Object with payload, or null
     *   when no matching rule defines a command for the target
     */
    simpleResolveCommand(device, targetId, matchingRules) {
        let command = null
        for (const rule of matchingRules) {
            const cmd = rule.targets?.[targetId]
            if (cmd !== undefined) {
                command = cmd
                break
            }
        }

        if (command === null || command === undefined) return null

        // Structured commands are already device-native payloads ({brightness}, {state}, ...)
        // -- pass them through untouched instead of running scalar mapping on them.
        if (typeof command === 'object') {
            return { payload: command }
        }

        const upper = String(command).toUpperCase()
        if (upper === 'ON' || upper === 'OFF') {
            return { payload: { state: upper } }
        }
        if (upper === 'OPEN' || upper === 'CLOSE') {
            return { payload: upper }
        }
        return { payload: { position: Number(command) } }
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Build the Redis key for a rule's daily "once" marker. Rules that declare a
     * `time_of_day` condition get one slot per calendar day PER WINDOW -- suffixed with
     * the period active at evaluation time -- so e.g. an [evening, night] dusk rule can
     * act once in pre-dawn AND once at actual dusk instead of its first firing consuming
     * both windows' budgets. Rules without such a condition keep the single plain-key
     * slot per calendar day (unchanged behaviour).
     * @private
     * @param {Object} rule - Rule object carrying an `once: true` flag
     * @param {string|null} period - Context time-of-day period ('morning' ... 'night')
     * @returns {string} Redis key for the marker
     */
    #onceMarkerKey(rule, period) {
        const base = `auto:${this.name}:once:${slugify(rule.name)}`
        const declaresWindow = Boolean(rule.conditions?.['time_of_day'])
        return declaresWindow && typeof period === 'string' && period !== '' ? `${base}:${period}` : base
    }

    /**
     * Check whether an `once` rule has already consumed its action slot today -- either
     * that window's slot on this calendar day when the rule declares a `time_of_day`
     * condition, or its single daily slot otherwise. Reads the marker from Redis
     * (`auto:<name>:once:<rule slug>[:<period>]`); the stored calendar day is compared
     * against the current local date, so markers self-reset each day without cleanup
     * logic. Fails open when Redis is unavailable or the entry cannot be parsed --
     * consistent with checkAndLogHumanInteraction().
     * 
     * @private
     * @param {Object} rule - Rule object carrying an `once: true` flag
     * @param {string|null} [period] - Context time-of-day period; scopes the lookup per window
     * @returns {Promise<boolean>} true if this rule already acted in this window today
     */
    async #hasActedToday(rule, period) {
        try {
            const stored = await CacheService.get(this.#onceMarkerKey(rule, period))
            return Boolean(stored && stored.date === temporal.getLocalDayString())
        } catch (_) {
            // Redis unavailable / parse issue -- allow the automation to proceed.
            return false
        }
    }

    /**
     * Consume an `once` rule's action slot for this window by writing its marker to
     * Redis (window-scoped key when the rule declares a `time_of_day` condition). Called
     * after dispatch completes (commands sent and/or devices deferred to recent human
     * interaction). Failures are logged but never fatal -- worst case the rule may act
     * again on a later tick of the same day.
     * 
     * @private
     * @param {Object} rule - Rule object carrying an `once: true` flag
     * @param {string|null} [period] - Context time-of-day period; scopes the write per window
     * @returns {Promise<void>}
     */
    async #markActedToday(rule, period) {
        try {
            const ok = await CacheService.set(
                this.#onceMarkerKey(rule, period),
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
    /**
     * Epoch-ms instant for the given local clock hour on the current calendar day.
     * Accepts fractional hours (12.5 -> 12:30) so NATO-style and sun-derived bounds land on
     * their exact minute instead of being truncated to the top of the hour.
     * @private
     * @param {number} hour - Hour of day (0-24, fractional allowed).
     * @returns {number} Epoch milliseconds at that clock time today.
     */
    #todayAtHour(hour) {
        const now = new Date()
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
            + Math.round(hour * 3_600_000)
    }

    /**
     * Resolve one merged-gate candidate to an absolute epoch-ms instant.
     *
     * Accepts a sun shorthand ("sundusk"/"sunset", "sundawn"/"sunrise") sourced from the per-tick context snapshot,
     * a clock hour as a bare number or `{hour:N}`, and a day-period name ('morning', ... -> that period's start-of-day
     * hour), also via `{'time_of_day':name}`. Returns null when unresolvable so callers can drop the candidate rather
     * than fail the whole gate.
     *
     * @private
     * @param {*} spec - Candidate value from an after_latest_of / after_earliest_of list.
     * @param {{}} context - Evaluation context carrying sundawn/sundusk epoch-ms (or null).
     * @returns {number|null} Epoch-ms instant, or null when the candidate cannot be resolved.
     */
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

    /**
     * Whether a value is one of the recognized sun-event shorthands usable as an `hour:` bound.
     * Accepts both spellings for each event so rule authors can mix them freely.
     * @private
     * @param {*} value - Candidate bound value from an `hour:` condition object.
     * @returns {boolean} True when the value is 'sunrise'/'sundawn', 'sunset' or 'sundusk'.
     */
    #isSunShorthand(value) {
        return typeof value === 'string' && ['sunrise', 'sundawn', 'sunset', 'sundusk'].includes(value.trim().toLowerCase())
    }

    /**
     * Resolve a single `hour:` bound to a finite number on the hour axis.
     *
     * Sun shorthands map to today's dawn/dusk fractional hour derived from the context
     * instants; every other spelling (plain hour, fractional hour, "HH:MM", NATO-style HHMM
     * such as 1230) goes through temporal.parseClockHour() so the same token means the same
     * moment as it does in a silence window. Returns NaN for anything unresolvable so
     * callers fail closed.
     *
     * @private
     * @param {*} value - Bound value from an `hour:` condition object.
     * @param {{}} context - Evaluation context carrying sundawn/sundusk epoch-ms (or null).
     * @param {number} startOfTodayMs - Epoch ms at local midnight, used to derive fractional hours.
     * @returns {number} Resolved numeric hour, or NaN when the value cannot be resolved.
     */
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

    /**
     * Evaluate an `hour:` bounds object against the current time.
     *
     * Plain-integer bounds keep the legacy whole-hour semantics on the fast path. The moment
     * any bound is a sun shorthand ("sunrise"/"sundusk") or a NATO-style HHMM clock time
     * ("1230"), every bound is resolved to a fractional hour and compared against the exact
     * current time-of-day, so `{ gte: sunrise }` fires at the real dawn moment and
     * `{ lte: 1230 }` stops at 12:30 rather than at 12:00.
     *
     * @private
     * @param {number} nowHour - Current local clock hour (integer 0-23).
     * @param {{lt?: number|string, lte?: number|string, gt?: number|string, gte?: number|string}} constraints - Hour bounds object.
     * @param {{}} context - Evaluation context carrying sundawn/sundusk epoch-ms (or null).
     * @returns {boolean} True when all present bounds hold.
     */
    #matchesHourBounds(nowHour, constraints, context) {
        const ops = ['lt', 'lte', 'gt', 'gte']
        const precise = ops.some((op) => {
            const bound = constraints[op]
            if (bound === undefined) return false
            return this.#isSunShorthand(bound) || temporal.isNatoClockBound(bound)
        })
        if (!precise) return this.#matchesNumericRange(nowHour, constraints)

        // At least one sun shorthand -> precise path: resolve every bound to a fractional hour and
        // compare against the exact current time-of-day (sub-hour granularity).
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

    /**
     * Check if a numeric value satisfies range bounds defined in config.
     * Supports: lt, lte, gt, gte
     * 
     * @private
     * @param {number|null} value - The sensor reading to check
     * @param {Object} constraints - Range bounds (lt, lte, gt, gte)
     * @returns {boolean}
     */
    #matchesNumericRange(value, constraints) {
        if (value === null || value === undefined) return false

        if (constraints.lt !== undefined && !(value < constraints.lt)) return false
        if (constraints.lte !== undefined && !(value <= constraints.lte)) return false
        if (constraints.gt !== undefined && !(value > constraints.gt)) return false
        if (constraints.gte !== undefined && !(value >= constraints.gte)) return false

        return true
    }

    /**
     * Normalize presence condition to an object of { name: boolean } pairs.
     * Supported formats:
     *   "kyeno"             -> { kyeno: true }
     *   ["kyeno", "meerkat"] -> { kyeno: true, meerkat: true }
     *   { kyeno: true, meerkat: false }
     * 
     * @private
     * @param {string|string[]|Object} presence - Raw condition value from YAML
     * @returns {Object} Map of device name to boolean
     */
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

        // Already an object
        return presence
    }

    /**
     * Normalize a video_player condition to an object of { host: string[] } pairs.
     * Supported formats:
     *   { htpc: 'playing' }            -> { htpc: ['playing'] }
     *   { htpc: ['playing', 'paused'] } -> { htpc: ['playing', 'paused'] }
     *
     * @private
     * @param {Object} videoPlayer - Raw condition value from YAML (host -> status or status list)
     * @returns {Object} Map of host name to array of accepted statuses
     */
    #normalizeVideoPlayerCondition(videoPlayer) {
        const result = {}
        for (const [host, value] of Object.entries(videoPlayer ?? {})) {
            result[host] = Array.isArray(value) ? value : [value]
        }
        return result
    }

    /**
     * Split a "<domain>:<subject>" reference (e.g., "network:htpc", "videoPlayer:bedroom") into its
     * domain and subject parts for DatabaseService lookups. A missing/leading colon yields an empty
     * domain that matches no stored rows (fail-open).
     * @private
     * @param {string} ref - Raw subject reference from a condition value
     * @returns {{domain: string, subject: string}} Parsed domain and subject
     */
    #parseSubjectRef(ref) {
        const str = String(ref ?? '')
        const idx = str.indexOf(':')
        if (idx <= 0) return { domain: '', subject: str }
        return { domain: str.slice(0, idx), subject: str.slice(idx + 1) }
    }

    /**
     * Whether any subject this automation monitors recorded a state transition after our last
     * evaluation -- the signal the react-on-change gate uses to decide whether a scheduled tick
     * should run at all. Returns true when no subjects are monitored (nothing to watch -> don't
     * block) and fails open (true) while the database is unavailable so an outage never silences.
     * @private
     * @returns {Promise<boolean>} true when a relevant change occurred (or none can be determined)
     */
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

    /**
     * Derive the set of {domain, subject} pairs this automation reacts to by scanning its rules'
     * `presence` (network) and `video_player` conditions -- including hosts referenced inside
     * nested `any_of`/`all_of` condition groups. Cached per config object; recomputed only when
     * the config reference changes (tests / reloads). De-duplicated by "domain:subject".
     * @private
     * @returns {Array<{domain: string, subject: string}>} Monitored subjects (may be empty)
     */
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

    /**
     * Recursively collect monitored-subject references from one condition group -- its own
     * `presence`/`video_player` entries plus those nested in `any_of`/`all_of` sub-groups.
     * Descending into composites is what keeps the react-on-change gate awake on transitions of
     * hosts referenced only inside an OR branch under trigger_on_change_only.
     * @private
     * @param {Record<string, unknown>|null|undefined} conds - Condition group from YAML
     * @param {(domain: string, subject: string) => void} add - Accumulator callback
     */
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

    /**
     * Evaluate the top-level `video_player_suppression` stand-down guard.
     *
     * Inverted semantics vs. the per-rule `video_player` condition: instead of
     * statuses a rule requires, the suppression map lists statuses that make
     * the whole automation stand down. Hosts combine with OR -- while ANY
     * listed host reports one of its listed statuses, the guard is active. No
     * recorded status for a host counts as the enumerated `offline` status, so
     * it suppresses only when `offline` is listed -- mirroring the per-rule
     * condition semantics.
     *
     * @private
     * @returns {Promise<boolean>} true while the automation should stand down
     */
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

    /**
     * Public accessor so subclasses that override execute() can honor the same
     * video_player_suppression stand-down guard without duplicating its logic. Returns true
     * while any configured player reports one of its listed suppression statuses; returns
     * false when no video_player_suppression block is configured at all.
     * @returns {Promise<boolean>} true while the automation should stand down
     */
    async isVideoPlayerSuppressionActive() {
        if (!this.config.video_player_suppression) return false
        return await this.#evaluateVideoPlayerSuppression()
    }
}
