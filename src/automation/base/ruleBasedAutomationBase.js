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
 * Explicit condition token for an unknown player state (host offline, or the
 * monitor has not determined a status yet). Unlike real statuses it must be
 * listed explicitly: an unknown status matches ONLY condition lists that
 * include this token, so rules decide whether an unknown state is "safe to
 * act on" (ambient restore, ownership hand-back) or not (playback).
 */
const VIDEO_PLAYER_UNKNOWN = 'unknown'

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
     * presence / video-player conditions. Recomputed when the config object is replaced (tests,
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

        return ctx
    }

    /**
     * Evaluate a single rule's conditions against the built context.
     *
     * Checks `time-of-day`, actual wall-clock `hour`, `season`, numeric sensor ranges (`illuminance`, `temperature`, ...), and `presence` constraints.
     * A condition key that is absent or falsy is treated as "always passes".
     *
     * @param {Record<string, unknown>} [conditions] - Conditions object from YAML rule
     * @param {{illuminance: number|null, temperature: number|null, timeOfDay: string}} context
     * @returns {Promise<boolean>}
     */
    async conditionsMatch(conditions, context) {
        if (!conditions) return true // no conditions = always matches

        // time-of-day check
        if (conditions['time-of-day']) {
            const periods = Array.isArray(conditions['time-of-day'])
                ? conditions['time-of-day']
                : [conditions['time-of-day']]

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
                if (!this.#matchesNumericRange(nowHour, constraint)) return false
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
        if (conditions['video-player'] !== undefined) {
            const expected = this.#normalizeVideoPlayerCondition(conditions['video-player'])
            for (const [host, statuses] of Object.entries(expected)) {
                const status = await videoPlayerMonitor.getStatus(host)
                if (!status) {
                    // Unknown host (offline / not yet swept): matches ONLY lists that
                    // explicitly accept the 'unknown' token. Rules that must act on an
                    // unknown state opt in (ambient restore, ownership hand-back);
                    // everything else -- in particular playback requirements -- stays
                    // inert so no dark-mode action can fire on a guess.
                    return statuses.includes(VIDEO_PLAYER_UNKNOWN)
                }
                if (!statuses.includes(status)) {
                    return false
                }
            }
        }

        // state-change recency check -- require that the last recorded transition for each
        // listed "<domain>:<subject>" was at least N minutes ago. Backed by
        // DatabaseService.lastTransitionTs(). A subject with no history satisfies any bound;
        // an unavailable store fails open so a downed database never blocks an automation.
        if (conditions['state-changed-ago-minutes'] !== undefined) {
            const expected = conditions['state-changed-ago-minutes']
            for (const [ref, bounds] of Object.entries(expected ?? {})) {
                const minMinutes = typeof bounds === 'number' ? bounds : Number(bounds?.gte ?? bounds?.min ?? NaN)
                if (!Number.isFinite(minMinutes)) continue   // malformed -> ignore rather than fail closed
                const { domain, subject } = this.#parseSubjectRef(ref)
                const ts = await DatabaseService.lastTransitionTs(domain, subject)
                if (ts == null) continue                       // never changed -> satisfies "at least N ago"
                if ((Date.now() - ts) < minMinutes * 60_000) return false
            }
        }

        // Dynamic: any remaining condition key -> numeric range check against context.
        // Supports illuminance, temperature, humidity, pressure, or any future sensor type
        // defined in config.sensors without code changes.
        for (const [key, constraint] of Object.entries(conditions)) {
            if (key === 'time-of-day' || key === 'hour' || key === 'season' || key === 'presence' || key === 'video-player' || key === 'state-changed-ago-minutes') continue // handled above

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
     *   silent-period suppression and per-rule once-per-day markers (both checking and writing them); human-interaction cooldowns still
     *   apply, and the top-level video_player_suppression stand-down guard is never bypassed
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
                    const scope = rule.conditions?.['time-of-day'] ? ` during ${context.timeOfDay}` : ''
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
                const spec = rule.invoke_automation
                if (!spec) continue
                const name = typeof spec === 'string' ? spec : spec.name
                if (!name || typeof name !== 'string') continue
                const force = typeof spec === 'object' && spec.force === true
                invocations.set(name, (invocations.get(name) ?? false) || force)
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
            const outcome = await this.#dispatchDeviceCommands(devices, matchingRules)
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
     * Dispatch exactly one consolidated command per resolved device, collecting candidate
     * commands from ALL matching rules (subclasses apply merge semantics such as "lowest
     * position wins" via resolveCommand). Prevents duplicate MQTT publishes when multiple
     * rules match simultaneously targeting the same device; recently-touched devices are
     * deferred unless this automation overrides the human-interaction cooldown.
     *
     * @private
     * @param {Map<string, DeviceBase>} devices - Resolved target key -> mechanism map
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @returns {Promise<{dispatchedCount: number, humanSkippedCount: number}>} Outcome counters
     */
    async #dispatchDeviceCommands(devices, matchingRules) {
        const tasks = []
        let dispatchedCount = 0   // devices that actually received a command
        let humanSkippedCount = 0 // devices deferred to recent human interaction

        for (const [targetKey, device] of devices) {
            // Capture loop variables in closure
            const tk = targetKey
            const dev = device

            tasks.push(async () => {
                // Skip recently touched devices (Redis-only check), unless this
                // automation overrides the human-interaction cooldown (e.g., home theater mode).
                if (!this.getOverrideHumanInteraction() && await this.checkAndLogHumanInteraction(dev)) {
                    humanSkippedCount++
                    return
                }

                // Collect per-target commands from every matching rule.
                // Simple automations may instead define a flat `action` field on the rule,
                // which applies uniformly to every listed device -- fall back to it when no
                // target-specific command was found.
                const commands = []
                for (const rule of matchingRules) {
                    const cmd = rule.targets?.[tk]
                    if (cmd !== undefined) {
                        commands.push(cmd)
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

                // Log which rules contributed to this device's decision
                if (commands.length > 1) {
                    this.log(
                        `${dev.getName()}: ${commands.length} rules matched, resolving: [${commands.join(', ')}]`,
                        'debug'
                    )
                }

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
     * payloads, OPEN/CLOSE become bare state strings, and numeric values
     * become `{position}` payloads.
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
     * `time-of-day` condition get one slot per calendar day PER WINDOW -- suffixed with
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
        const declaresWindow = Boolean(rule.conditions?.['time-of-day'])
        return declaresWindow && typeof period === 'string' && period !== '' ? `${base}:${period}` : base
    }

    /**
     * Check whether an `once` rule has already consumed its action slot today -- either
     * that window's slot on this calendar day when the rule declares a `time-of-day`
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
     * Redis (window-scoped key when the rule declares a `time-of-day` condition). Called
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
     * Normalize a video-player condition to an object of { host: string[] } pairs.
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
     * `presence` (network) and `video-player` conditions. Cached per config object; recomputed only
     * when the config reference changes (tests / reloads). De-duplicated by "domain:subject".
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
            const conds = rule?.conditions ?? {}
            if (conds.presence !== undefined) {
                for (const name of Object.keys(this.#normalizePresenceCondition(conds.presence))) add('network', name)
            }
            if (conds['video-player'] !== undefined) {
                for (const host of Object.keys(this.#normalizeVideoPlayerCondition(conds['video-player']))) add('videoPlayer', host)
            }
        }
        this.#monitoredConfigRef = this.config
        this.#monitoredSubjects = out
        return out
    }

    /**
     * Evaluate the top-level `video_player_suppression` stand-down guard.
     *
     * Inverted semantics vs. the per-rule `video-player` condition: instead of
     * statuses a rule requires, the suppression map lists statuses that make
     * the whole automation stand down. Hosts combine with OR -- while ANY
     * listed host reports one of its listed statuses, the guard is active. A
     * null (unknown) status maps to the explicit `unknown` token, so it
     * suppresses only when listed -- mirroring the per-rule condition
     * semantics.
     *
     * @private
     * @returns {Promise<boolean>} true while the automation should stand down
     */
    async #evaluateVideoPlayerSuppression() {
        const suppression = this.#normalizeVideoPlayerCondition(this.config.video_player_suppression)
        for (const [host, statuses] of Object.entries(suppression)) {
            const status = await videoPlayerMonitor.getStatus(host)
            const effective = status ?? VIDEO_PLAYER_UNKNOWN
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