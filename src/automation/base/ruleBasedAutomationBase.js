/**
 * Abstract base class for rule-based (YAML-driven) automations.
 *
 * Extends {@link ../automationBase.js} with context building (sensor readings,
 * time-of-day periods, network presence), YAML config parsing, condition
 * evaluation, and a template-method `execute()` flow. Subclasses implement
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

import LoggerService from '../../service/loggerService.js'
import { parseDocument as yamlParseDocument } from 'yaml'

import DeviceContainer from '../../device/container/deviceContainer.js'
import networkPresence from '../../monitor/networkPresence.js'

import AutomationBase from './automationBase.js'

/**
 * Maximum consecutive context-build failures before escalating from warn to error.
 * @type {number}
 */
const CONTEXT_FAILURE_ESCALATION_THRESHOLD = 5

export default class RuleBasedAutomationBase extends AutomationBase {
    /**
     * Consecutive context-build failure count for log-level escalation.
     * Resets to 0 on each successful build.
     * @type {number}
     */
    #contextFailCount = 0

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
        // E.g., { humidity: 'Balkon Temperatura' } reads state.humidity from that device.
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
     * Checks `time-of-day`, `illuminance`, `temperature`, and `presence` constraints.
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

        // Dynamic: any remaining condition key -> numeric range check against context.
        // Supports illuminance, temperature, humidity, pressure, or any future sensor type
        // defined in config.sensors without code changes.
        for (const [key, constraint] of Object.entries(conditions)) {
            if (key === 'time-of-day' || key === 'presence') continue // handled above

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
            try {
                const match = await this.conditionsMatch(rule.conditions, context)
                if (match) {
                    matchingRules.push(rule)
                    this.log(`Rule matched: "${rule.name}"`, 'debug')
                }
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

        for (const [targetKey, device] of devices) {
            // Capture loop variables in closure
            const tk = targetKey
            const dev = device

            tasks.push(async () => {
                // Skip recently touched devices (Redis-only check)
                if (await this.checkAndLogHumanInteraction(dev)) {
                    return
                }

                // Collect per-target commands from every matching rule
                const commands = []
                for (const rule of matchingRules) {
                    const cmd = rule.targets?.[tk]
                    if (cmd !== undefined) {
                        commands.push(cmd)
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

                const payload = result.payload
                this.log(`${dev.getName()} -> ${JSON.stringify(payload)}`)
                dev.receiveCommand(payload, true)
            })
        }

        // Run all tasks in parallel - MqttService queue handles global rate-limiting
        Promise.allSettled(tasks.map(t => t())).catch(err => {
            this.log(`Task execution error: ${err.message}`, 'error')
        })
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

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Check if a numeric value satisfies range bounds defined in config.
     * Supports: lt, lte, gt, gte
     * 
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
}