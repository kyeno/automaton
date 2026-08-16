/**
 * Abstract base class for all automations.
 *
 * Manages lifecycle (init, cleanup), EventBus trigger subscriptions, periodic
 * timers, and human-interaction cooldown checks. Subclasses implement {@link execute}.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import temporal from '../../lib/date.js'
import CacheService from '../../service/cacheService.js'
import ConfigService from '../../service/configService.js'
import EventBus from '../../service/eventBus.js'
import LoggerService from '../../service/loggerService.js'
import { slugify } from '../../lib/string.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cooldown after human interaction before automation resumes (ms). */
const DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS = 15 * 60 * 1_000

/** Default timer interval -- `0` means timer is disabled; automation is event-driven only. */
const DEFAULT_TIMER_INTERVAL_MS = 0

// ---------------------------------------------------------------------------
// AutomationBase (abstract)
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all automations.
 *
 * Manages lifecycle (init, cleanup), EventBus trigger subscriptions, periodic
 * timers, and human-interaction cooldown checks. Subclasses implement {@link execute}.
 */
export default class AutomationBase {

    // -- Constructor --------------------------------------------------------

    /**
     * Construct an automation instance.
     *
     * @param {object} options - Constructor options
     * @param {string} options.name - Display name of the automation (used in log context)
     * @param {Record<string, unknown>} [options.config] - Parsed YAML configuration or inline config object
     */
    constructor({ name, config = {} }) {
        this.name = name
        this.config = config
        this._initialized = false   // guard against double init() calls
        this._timer = null          // setInterval handle
        this._unsubscribes = []     // stored unsubscribe functions for cleanup
    }

    // -- Lifecycle ----------------------------------------------------------

    /**
     * Initialize the automation: subscribe to EventBus triggers and start timer.
     *
     * Called once during system startup. Uses a guard flag to prevent duplicate
     * subscriptions if called multiple times. Subclasses may override but should
     * call `await super.init()` first.
     *
     * @async
     */
    async init() {
        // Guard against double initialization -- prevents duplicate subscriptions + timers.
        if (this._initialized) {
            LoggerService.warn(
                `${this.name}.init() called more than once, subsequent call ignored`,
                `Auto:${this.name}`
            )
            return
        }
        this._initialized = true

        // Subscribe to EventBus triggers.
        const triggers = this.getTriggerTopics()
        if (triggers && triggers.length > 0) {
            for (const topic of triggers) {
                const unsub = EventBus.subscribe(topic, () => {
                    try {
                        this.execute({ trigger: topic })
                    } catch (error) {
                        LoggerService.error(`Error executing event trigger "${topic}" for ${this.name}: ${error.message}`, `Auto:${this.name}`)
                    }
                })
                if (unsub) {
                    this._unsubscribes.push(unsub)
                }
            }
            LoggerService.info(`${this.name} subscribed to triggers: [${triggers.join(', ')}]`, `Auto:${this.name}`)
        }

        // Start periodic timer if configured.
        const intervalMs = this.getTimerIntervalMs()
        if (intervalMs != null && intervalMs > 0) {
            this.startTimer(intervalMs)
        }
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Return a list of EventBus topics this automation wants to react to.
     * Reads `triggers_zigbee` and `triggers_network` arrays from config.
     * Subclasses with custom trigger logic can override.
     *
     * @return {string[]} Array of topic strings to subscribe to
     */
    getTriggerTopics() {
        const topics = []

        if (Array.isArray(this.config?.triggers_zigbee)) {
            for (const name of this.config.triggers_zigbee) {
                topics.push(`zigbee:${name}`)
            }
        }

        if (Array.isArray(this.config?.triggers_network)) {
            for (const name of this.config.triggers_network) {
                topics.push(`network:${name}`)
            }
        }

        return topics
    }

    /**
     * Return the interval in milliseconds for the periodic timer.
     * Reads `timer_interval_ms` from config, falling back to DEFAULT_TIMER_INTERVAL_MS.
     * Return null or 0 to disable the timer (event-driven only).
     *
     * @return {number|null} Interval in milliseconds, or null/0 to disable
     */
    getTimerIntervalMs() {
        return typeof this.config?.timer_interval_ms === 'number'
            ? this.config.timer_interval_ms
            : DEFAULT_TIMER_INTERVAL_MS
    }

    // -- Abstract method ----------------------------------------------------

    /**
     * Main execution logic -- pure virtual; must be overridden by subclasses.
     *
     * Invoked either by an EventBus trigger or by the periodic timer.
     *
     * @param {{trigger: string}|null} [triggerData] - Trigger metadata (e.g., `{trigger: 'zigbee:Living Room Light'}`)
     * @throws {Error} If not overridden
     */
    execute(triggerData = null) {
        throw new Error('Method "execute()" must be implemented in subclasses.')
    }

    // -- Timer management ---------------------------------------------------

    /**
     * Start a periodic timer that calls {@link execute} at fixed intervals.
     *
     * @param {number} intervalMs - Interval in milliseconds
     */
    startTimer(intervalMs) {
        const _tick = () => {
            try {
                this.execute({ trigger: 'timer' })
            } catch (error) {
                LoggerService.error(`Error executing timer for ${this.name}: ${error.message}`, `Auto:${this.name}`)
            }
        }

        this._timer = setInterval(_tick, intervalMs)
        LoggerService.info(
            `${this.name} timer started with interval ${temporal.millisecondsToHumanReadable(intervalMs)}`,
            `Auto:${this.name}`
        )
    }

    /**
     * Stop the periodic timer.
     */
    stopTimer() {
        if (this._timer) {
            clearInterval(this._timer)
            this._timer = null
            LoggerService.info(`${this.name} timer stopped`, `Auto:${this.name}`)
        }
    }

    // -- Cleanup ------------------------------------------------------------

    /**
     * Clean up all event subscriptions and timers.
     * Called during graceful shutdown.
     */
    cleanup() {
        this.stopTimer()
        for (const unsub of this._unsubscribes) {
            try {
                unsub()
            } catch (e) {
                LoggerService.warn(`Error cleaning up subscription for ${this.name}: ${e.message}`, `Auto:${this.name}`)
            }
        }
        this._unsubscribes = []
        this._initialized = false  // allow re-init after cleanup
    }

    /**
     * Return the human-interaction cooldown in milliseconds.
     * Reads `human_interaction_cooldown_ms` from ConfigService, otherwise defaults
     * to DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS (15 minutes).
     * @returns {number} Cooldown in milliseconds
     */
    getHumanInteractionCooldownMs() {
        return ConfigService.get('human_interaction_cooldown_ms', DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS)
    }

    /**
     * Check whether the current local time falls within the configured silent period.
     * The config key is `silence_between` with format `"HHmm-HHmm"` (e.g., "0500-0900"
     * or overnight "2300-0600"). Returns false when no config is set so that existing
     * automations are unaffected. Invalid formats produce a one-time warning and fall
     * through to normal behaviour (fail-open).
     *
     * @returns {boolean} true if execution should be suppressed right now
     */
    isInSilentPeriod() {
        const silenceConfig = this.config?.silence_between
        if (!silenceConfig || typeof silenceConfig !== 'string') return false

        // Parse "HHmm-HHmm" -- e.g. "0500-0900", "2300-0600"
        const match = String(silenceConfig).match(/^(\d{4})-(\d{4})$/)
        if (!match) {
            LoggerService.warn(
                `Invalid silence_between format "${silenceConfig}", expected "HHmm-HHmm". Ignoring.`,
                `Auto:${this.name}`
            )
            return false
        }

        const parseToMinutes = (hhmm) => {
            const hours = parseInt(hhmm.slice(0, 2), 10)
            const minutes = parseInt(hhmm.slice(2, 4), 10)
            return hours * 60 + minutes
        }

        const startMinutes = parseToMinutes(match[1])
        const endMinutes   = parseToMinutes(match[2])

        const now = new Date()
        const currentMinutes = now.getHours() * 60 + now.getMinutes()

        if (startMinutes < endMinutes) {
            // Normal range: e.g., 0500-0900 -> between 5 AM and 9 AM
            return currentMinutes >= startMinutes && currentMinutes < endMinutes
        } else if (startMinutes > endMinutes) {
            // Overnight wrap: e.g., 2300-0600 -> from 11 PM to 6 AM next day
            return currentMinutes >= startMinutes || currentMinutes < endMinutes
        }
        // start === end means the window covers either all or no time -- treat as no-op.
        return false
    }

    /**
     * Check whether a device is under a human-interaction cooldown using Redis TTL.
     * The cooldown key (`cooldown:<slug>`) is set by DeviceBase when it detects
     * a genuine human-initiated state change outside the grace period. It auto-
     * expires after the configured cooldown duration (stored as epoch in JSON payload),
     * so automations simply check remaining time and skip if still active.
     *
     * Requires Redis to be available. If Redis is offline or an error occurs,
     * returns false (device will NOT be skipped).
     *
     * @param {object} device - Device instance with getName() method
     * @returns {Promise<boolean>} true if the device should be skipped due to recent human interaction
     */
    async checkAndLogHumanInteraction(device) {
        const slug = slugify(device.getName())

        try {
            const remainingMs = await CacheService.getHumanCooldownRemaining(slug)
            if (remainingMs != null && remainingMs > 0) {
                const totalSeconds = Math.ceil(remainingMs / 1_000)
                this.log(
                    `Recent human interaction on ${device.getName()}, skipping (${temporal.secondsToHumanReadable(totalSeconds)} remaining)`,
                    'debug'
                )
                return true
            }
        } catch (_) {
            // Redis unavailable - cannot verify cooldown, allow automation to proceed.
        }

        return false
    }

    /**
     * Helper method to log messages associated with this automation.
     *
     * @param {string} message - The message to log
     * @param {string} level - Log level ('info', 'debug', 'warn', 'error')
     */
    log(message, level = 'info') {
        const context = `Auto:${this.name}`
        switch (level.toLowerCase()) {
            case 'debug': LoggerService.debug(message, context); break
            case 'warn':  LoggerService.warn(message, context); break
            case 'error': LoggerService.error(message, context); break
            default:      LoggerService.info(message, context); break
        }
    }
}