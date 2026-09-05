/**
 * Abstract base class for rule-based (YAML-driven) automations.
 *
 * Extends {@link ../automationBase.js} with context building (sensor readings,
 * time-of-day periods, network presence), YAML config parsing, condition
 * evaluation (including optional `season` conditions and per-rule daily `once`
 * markers), an optional top-level `videoPlayer_suppression` stand-down guard,
 * and a template-method `execute()` flow. Subclasses implement
 * {@link loadDevices} and {@link resolveCommand} hooks.
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
import LoggerService from '../../service/loggerService.js'
import { parseDocument as yamlParseDocument } from 'yaml'
import { slugify } from '../../lib/string.js'

import DeviceContainer from '../../device/container/deviceContainer.js'
import networkPresence from '../../monitor/networkPresence.js'
import videoPlayerMonitor from '../../monitor/videoPlayerMonitor.js'

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
 * TTL for state-aware-restore snapshots in Redis (12 hours, seconds). A
 * snapshot records that a device was on when this automation turned it off;
 * the TTL only keeps forgotten entries self-cleaning.
 * @type {number}
 */
const RESTORE_SNAPSHOT_TTL_SECONDS = 43_200

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
     * In-memory restore snapshots for state-aware restore, keyed by target id.
     * Redis mirrors them so snapshots survive a restart; the map is the
     * authoritative fast path.
     * @type {Map<string, boolean>}
     */
    #restoreMemory = new Map()

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
     * Checks `time-of-day`, `season`, `illuminance`, `temperature`, and `presence` constraints.
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
        if (conditions.videoPlayer !== undefined) {
            const expected = this.#normalizeVideoPlayerCondition(conditions.videoPlayer)
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

        // Dynamic: any remaining condition key -> numeric range check against context.
        // Supports illuminance, temperature, humidity, pressure, or any future sensor type
        // defined in config.sensors without code changes.
        for (const [key, constraint] of Object.entries(conditions)) {
            if (key === 'time-of-day' || key === 'season' || key === 'presence' || key === 'videoPlayer') continue // handled above

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
     * @param {boolean} [triggerData.force] - When true (e.g., "/automation force"), bypasses the
     *   silent-period suppression and per-rule once-per-day markers; human-interaction cooldowns still
     *   apply, and the top-level videoPlayer_suppression stand-down guard is never bypassed
     */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        this.log(`Triggered by: ${triggerSource}`, 'info')

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

        // Top-level video-player stand-down guard (videoPlayer_suppression): while
        // any listed player is in one of its listed statuses, the automation stands
        // down so it does not fight another automation (e.g., Home Theater Mode)
        // over the same devices. Individual rules may opt out via
        // ignore_videoPlayer_suppression. Unlike the silent period, this guard is
        // NOT bypassed by a forced run -- forcing must not create device fights.
        let suppressionActive = false
        if (this.config.videoPlayer_suppression) {
            if (await this.#evaluateVideoPlayerSuppression()) {
                const hasExemptRule = (this.config.rules ?? []).some(
                    (rule) => rule.ignore_videoPlayer_suppression === true
                )
                if (!hasExemptRule) {
                    this.log(`Suppressed by videoPlayer_suppression (${triggerSource})`, 'debug')
                    return
                }
                suppressionActive = true
                this.log(
                    `videoPlayer_suppression active -- evaluating exempt rules only (${triggerSource})`,
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

        // Build device map via subclass hook
        const devices = this.loadDevices()
        if (devices.size === 0) {
            this.log('No valid target devices found, skipping', 'warn')
            return
        }

        // Collect all matching rules
        const matchingRules = []
        for (const rule of rules) {
            // Stand-down guard active: only rules that opted out participate.
            if (suppressionActive && rule.ignore_videoPlayer_suppression !== true) continue

            try {
                const match = await this.conditionsMatch(rule.conditions, context)
                if (!match) continue

                // Per-rule daily "once" marker -- at most one action per calendar day.
                // A forced manual run may still act after the slot was used today; when it
                // does, #markActedToday() refreshes the marker so later natural runs skip.
                if (rule.once && triggerData?.force !== true && await this.#hasActedToday(rule)) {
                    this.log(`Rule "${rule.name}" already acted today, skipping`, 'debug')
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

        // Resolve a single consolidated command per device from ALL matching rules,
        // then dispatch exactly one command per device. This prevents duplicate MQTT
        // publishes when multiple rules match simultaneously targeting the same device.
        // "Lowest position wins" semantics are applied by subclasses (e.g., blindsResolveCommand).
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
                // State-aware restore (opt-in via `restore_state_aware`): only
                // re-assert ON for lights this automation turned off from an
                // on-state; skip everything else it does not remember.
                if (this.getRestoreStateAware()) {
                    // The first matching rule that commands this target owns the
                    // decision; its `force_restore` flag marks "always on" lights.
                    const owner = matchingRules.find((rule) => rule.targets?.[tk] !== undefined)
                    payload = await this.#applyRestoreAwareness(dev, tk, payload, owner?.force_restore === true)
                    if (!payload) return
                }

                this.log(`${dev.getName()} -> ${JSON.stringify(payload)}`)
                dev.receiveCommand(payload, DeviceCommandSource.AUTOMATION)
                dispatchedCount++
            })
        }

        // Run all tasks in parallel - MqttService queue handles global rate-limiting.
        // Await completion so daily "once" markers can be consumed afterwards.
        try {
            await Promise.allSettled(tasks.map(t => t()))
        } catch (error) {
            this.log(`Task execution error: ${error.message}`, 'error')
        }

        // Consume the daily slot for `once` rules when we either acted or deferred to
        // recent human interaction -- after that, humans have full control until the next
        // day. If nothing happened at all, keep retrying on later ticks.
        if (dispatchedCount > 0 || humanSkippedCount > 0) {
            for (const rule of matchingRules) {
                if (rule.once) {
                    await this.#markActedToday(rule)
                }
            }
        }
    }

    /**
     * Load target devices from config and return as a Map.
     * Supports two config formats:
     *   - targets: [{ id, name }] -- returns Map keyed by id
     *   - devices: ['name1', 'name2'] -- returns Map keyed by name
     * Subclasses may override for custom device structures.
     * 
     * @returns {Map<string, DeviceBase>} map of target key -> device
     */
    loadDevices() {
        const result = new Map()

        // Format 1: targets array with { id, name } objects (blinds)
        if (this.config.targets) {
            for (const target of this.config.targets) {
                const device = this.findDevice(target.name)
                if (device) {
                    result.set(target.id, device)
                } else {
                    this.log(`Target device "${target.name}" not found`, 'warn')
                }
            }
            return result
        }

        // Format 2: devices array of simple name strings (lights)
        if (this.config.devices) {
            for (const devName of this.config.devices) {
                const device = this.findDevice(devName)
                if (device) {
                    result.set(devName, device)
                } else {
                    this.log(`Device "${devName}" not found`, 'warn')
                }
            }
            return result
        }

        return result
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
     * @param {string} targetId - Identifier for the target (from config.targets[].id)
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
     * @param {string} targetKey - Identifier for the target (id or name)
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
     * @param {string} targetId - Identifier of the target (from config.targets[].id)
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

    /**
     * Whether this automation uses state-aware restore: lights are only
     * re-asserted ON when this automation itself turned them off from an
     * on-state. Read live from the `restore_state_aware` config key so the
     * config can also be injected after construction (tests).
     * @returns {boolean}
     */
    getRestoreStateAware() {
        return Boolean(this.config?.restore_state_aware)
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Read a device's last cached state in a normalized shape.
     * @private
     * @param {DeviceBase} device - Target device
     * @returns {{state: string|null, position: number|null}|null} Normalized
     *   state, or null when nothing is cached yet
     */
    #readDeviceState(device) {
        const last = typeof device?.getStateLast === 'function' ? device.getStateLast() : null
        if (!last || typeof last !== 'object') return null
        if (typeof last.state === 'string') {
            return {
                state: last.state.toUpperCase(),
                position: Number.isFinite(last.position) ? last.position : null
            }
        }
        if (Number.isFinite(last.position)) return { state: null, position: last.position }
        return null
    }

    /**
     * Whether a switch-style device is currently on.
     * @private
     * @param {DeviceBase} device - Target device
     * @returns {boolean}
     */
    #deviceIsOn(device) {
        return this.#readDeviceState(device)?.state === 'ON'
    }

    /**
     * Whether a roller device is currently (partially) open.
     * @private
     * @param {DeviceBase} device - Target device
     * @returns {boolean}
     */
    #deviceIsOpen(device) {
        const known = this.#readDeviceState(device)
        if (!known) return false
        if (Number.isFinite(known.position)) return known.position > 0
        return known.state === 'OPEN'
    }

    /**
     * Redis key for a target's restore snapshot.
     * @private
     * @param {string} targetId - Target identifier
     * @returns {string}
     */
    #restoreSnapshotKey(targetId) {
        return `auto:${this.name}:restore:${targetId}`
    }

    /**
     * Fetch a restore snapshot. The key exists only when the device was on
     * before this automation turned it off; null means "no memory".
     * In-memory map first; Redis hydrates it after a restart.
     * @private
     * @param {string} targetId - Target identifier
     * @returns {Promise<boolean|null>} true (was on), or null (no memory)
     */
    async #getRestoreSnapshot(targetId) {
        if (this.#restoreMemory.has(targetId)) return this.#restoreMemory.get(targetId)
        try {
            const stored = await CacheService.get(this.#restoreSnapshotKey(targetId))
            if (stored === true) {
                this.#restoreMemory.set(targetId, true)
                return true
            }
        } catch (_) {
            // Cache unavailable -- memory-only snapshots still apply.
        }
        return null
    }

    /**
     * Record that a device was on when this automation turned it off
     * (memory + best-effort Redis with a self-cleaning TTL).
     * @private
     * @param {string} targetId - Target identifier
     * @returns {Promise<void>}
     */
    async #rememberRestoreSnapshot(targetId) {
        this.#restoreMemory.set(targetId, true)
        try {
            await CacheService.set(this.#restoreSnapshotKey(targetId), true, RESTORE_SNAPSHOT_TTL_SECONDS)
        } catch (_) {
            // Best-effort persistence; the in-memory snapshot still applies.
        }
    }

    /**
     * Consume a restore snapshot after it has been acted on.
     * @private
     * @param {string} targetId - Target identifier
     * @returns {Promise<void>}
     */
    async #clearRestoreSnapshot(targetId) {
        this.#restoreMemory.delete(targetId)
        try {
            await CacheService.delete(this.#restoreSnapshotKey(targetId))
        } catch (_) {
            // Best-effort; the in-memory snapshot is cleared regardless.
        }
    }

    /**
     * State-aware gate for dispatched commands (only active when
     * `restore_state_aware` is on). Also suppresses provable no-ops so the
     * sticky re-assert ticks do not spam MQTT with redundant commands.
     *
     * Light (switch) payloads:
     *   - OFF: skipped when the device is already known-off; otherwise
     *     dispatched, remembering "was on" so a later ON can restore it.
     *   - ON: dispatched only when the snapshot says this automation turned
     *     the light off from an on-state (consuming it) -- or when the owning
     *     rule sets `force_restore: true` ("always on" ambient lights).
     *     Already-on devices are skipped as no-ops; without memory and
     *     without force the command is skipped, leaving lights the automation
     *     did not turn off to the automations that own them.
     *
     * Roller payloads:
     *   - CLOSE: skipped when already known-closed; otherwise dispatched,
     *     remembering "was open" when it closed from an open state.
     *   - OPEN: dispatched only to undo a close this automation performed
     *     itself (ownership hand-back); never opens blinds it found closed.
     *
     * @private
     * @param {DeviceBase} device - Target device
     * @param {string} targetId - Target identifier
     * @param {object|string} payload - Resolved command payload
     * @param {boolean} forceRestore - Owning rule sets `force_restore: true`
     * @returns {Promise<object|string|null>} Payload to dispatch, or null to skip
     */
    async #applyRestoreAwareness(device, targetId, payload, forceRestore) {
        // Light (switch) payloads.
        if (payload && typeof payload === 'object' && typeof payload.state === 'string') {
            const upper = payload.state.toUpperCase()
            if (upper === 'OFF') {
                if (this.#readDeviceState(device)?.state === 'OFF') return null // no-op
                if (this.#deviceIsOn(device)) await this.#rememberRestoreSnapshot(targetId)
                return payload
            }
            if (upper === 'ON') {
                const wasOn = await this.#getRestoreSnapshot(targetId)
                if (wasOn === true) await this.#clearRestoreSnapshot(targetId)
                if (this.#deviceIsOn(device)) return null // no-op
                if (wasOn === true || forceRestore) return payload
                this.log(`${device.getName()}: not restoring (was not on before dark mode)`, 'debug')
                return null
            }
            return payload
        }

        // Roller payloads.
        if (payload === 'CLOSE' || payload === 'OPEN') {
            if (payload === 'CLOSE') {
                const known = this.#readDeviceState(device)
                if (known && (known.position === 0 || known.state === 'CLOSE')) return null // no-op
                if (this.#deviceIsOpen(device)) await this.#rememberRestoreSnapshot(targetId)
                return payload
            }
            if ((await this.#getRestoreSnapshot(targetId)) === true) {
                await this.#clearRestoreSnapshot(targetId)
                return payload
            }
            return null
        }

        return payload
    }

    /**
     * Check whether an `once` rule has already consumed today's action slot.
     * Reads the daily marker from Redis (`auto:<name>:once:<rule slug>`); the stored
     * calendar day is compared against the current local date, so markers self-reset
     * each day without cleanup logic. Fails open when Redis is unavailable or the
     * entry cannot be parsed -- consistent with checkAndLogHumanInteraction().
     * 
     * @private
     * @param {Object} rule - Rule object carrying an `once: true` flag
     * @returns {Promise<boolean>} true if this rule already acted today
     */
    async #hasActedToday(rule) {
        try {
            const key = `auto:${this.name}:once:${slugify(rule.name)}`
            const stored = await CacheService.get(key)
            return Boolean(stored && stored.date === temporal.getLocalDayString())
        } catch (_) {
            // Redis unavailable / parse issue -- allow the automation to proceed.
            return false
        }
    }

    /**
     * Consume an `once` rule's daily action slot by writing its marker to Redis.
     * Called after dispatch completes (commands sent and/or devices deferred to recent
     * human interaction). Failures are logged but never fatal -- worst case the rule may
     * act again on a later tick of the same day.
     * 
     * @private
     * @param {Object} rule - Rule object carrying an `once: true` flag
     * @returns {Promise<void>}
     */
    async #markActedToday(rule) {
        try {
            const key = `auto:${this.name}:once:${slugify(rule.name)}`
            const ok = await CacheService.set(
                key,
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
     * Evaluate the top-level `videoPlayer_suppression` stand-down guard.
     *
     * Inverted semantics vs. the per-rule `videoPlayer` condition: instead of
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
        const suppression = this.#normalizeVideoPlayerCondition(this.config.videoPlayer_suppression)
        for (const [host, statuses] of Object.entries(suppression)) {
            const status = await videoPlayerMonitor.getStatus(host)
            const effective = status ?? VIDEO_PLAYER_UNKNOWN
            if (statuses.includes(effective)) {
                this.log(`videoPlayer_suppression: "${host}" is ${effective}`, 'debug')
                return true
            }
        }
        return false
    }
}