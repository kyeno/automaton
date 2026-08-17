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

/** Maximum acceptable timer interval -- setInterval clamps silently above 32 bits (~24.8 days). */
const MAX_SETTABLE_INTERVAL_MS = 0x7FFFFFFF

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
     * Prefers the human-readable `timer_interval` string ("90s", "3m 45s", "1h")
     * parsed via temporal.humanToMs(); falls back to legacy numeric
     * `timer_interval_ms`, then DEFAULT_TIMER_INTERVAL_MS. Invalid or oversized
     * values log a warning and disable the timer (fail-open, consistent with
     * silence_between handling).
     * Return null or 0 to disable the timer (event-driven only).
     *
     * @return {number|null} Interval in milliseconds, or null/0 to disable
     */
    getTimerIntervalMs() {
        const human = this.config?.timer_interval
        if (typeof human === 'string') {
            const ms = temporal.humanToMs(human)
            if (ms == null || ms > MAX_SETTABLE_INTERVAL_MS) {
                LoggerService.warn(
                    `Invalid timer_interval "${human}" (expected e.g. "90s", "3m 45s" or "1h"). Timer disabled.`,
                    `Auto:${this.name}`
                )
                return DEFAULT_TIMER_INTERVAL_MS
            }
            return ms
        }

        const legacy = this.config?.timer_interval_ms
        if (typeof legacy !== 'number') return DEFAULT_TIMER_INTERVAL_MS
        if (legacy > MAX_SETTABLE_INTERVAL_MS) {
            LoggerService.warn(
                `timer_interval_ms ${legacy} exceeds maximum (${MAX_SETTABLE_INTERVAL_MS}). Timer disabled.`,
                `Auto:${this.name}`
            )
            return DEFAULT_TIMER_INTERVAL_MS
        }
        return legacy
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
     * Reads `human_interaction_cooldown_ms` from ConfigService -- either legacy plain
     * milliseconds or a human-readable duration ("25m", "1h"). Missing values silently
     * default to DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS (15 minutes); present but
     * invalid values log a warning and fall back to that same default (fail-open).
     * A value of 0 disables the cooldown.
     * @returns {number} Cooldown in milliseconds (>= 0)
     */
    getHumanInteractionCooldownMs() {
        const raw = ConfigService.get('human_interaction_cooldown_ms')
        if (raw == null) return DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS
        const ms = temporal.parseDurationMs(raw)
        if (ms == null || ms < 0) {
            LoggerService.warn(
                `Invalid human_interaction_cooldown_ms ${JSON.stringify(raw)} (expected e.g. "25m" or plain milliseconds); using default (${temporal.millisecondsToHumanReadable(DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS)})`,
                `Auto:${this.name}`
            )
            return DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS
        }
        return ms
    }

    /**
     * Parse the configured `silence_between` window ("HHmm-HHmm") into minutes-of-day bounds.
     * Returns null when unset, malformed, or degenerate (start === end -- treated as a
     * no-op), logging a warning for malformed values so existing automations are
     * unaffected (fail-open). Shared by isInSilentPeriod()/isInSilentPeriodAt() and by
     * subclasses that need raw session boundaries (e.g., weatherman day-position markers).
     *
     * @returns {{startMin: number, endMin: number}|null} Window bounds in minutes from midnight
     */
    parseSilenceWindow() {
        const silenceConfig = this.config?.silence_between
        if (!silenceConfig || typeof silenceConfig !== 'string') return null

        // Parse "HHmm-HHmm" -- e.g. "0500-0900", "2300-0600"
        const match = String(silenceConfig).match(/^(\d{4})-(\d{4})$/)
        if (!match) {
            LoggerService.warn(
                `Invalid silence_between format "${silenceConfig}", expected "HHmm-HHmm". Ignoring.`,
                `Auto:${this.name}`
            )
            return null
        }

        const toMinutes = (hhmm) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2, 4), 10)
        const startMin = toMinutes(match[1])
        const endMin   = toMinutes(match[2])

        // start === end means the window covers either all or no time -- treat as no-op.
        if (startMin === endMin) return null
        return { startMin, endMin }
    }

    /**
     * Check whether a specific moment falls within the configured silent period.
     * Generalizes isInSilentPeriod() for arbitrary dates -- used by automations that need
     * to predict upcoming suppressed ticks (e.g., weatherman day-position markers).
     * Overnight wrap-around windows ("2300-0600") are supported; malformed configs fail open.
     *
     * @param {Date} [date=new Date()] - Moment to check
     * @returns {boolean} true if the given moment is inside the silent window
     */
    isInSilentPeriodAt(date = new Date()) {
        const win = this.parseSilenceWindow()
        if (!win) return false

        const minutes = date.getHours() * 60 + date.getMinutes()
        if (win.startMin < win.endMin) {
            // Normal range: e.g., 0500-0900 -> between 5 AM and 9 AM
            return minutes >= win.startMin && minutes < win.endMin
        }
        // Overnight wrap: e.g., 2300-0600 -> from 11 PM to 6 AM next day
        return minutes >= win.startMin || minutes < win.endMin
    }

    /**
     * Check whether the current local time falls within the configured silent period.
     * The config key is `silence_between` with format `"HHmm-HHmm"` (e.g., "0500-0900"
     * or overnight "2300-0600"). Returns false when no config is set so that existing
     * automations are unaffected. Invalid formats produce a warning and fall through
     * to normal behaviour (fail-open).
     *
     * @returns {boolean} true if execution should be suppressed right now
     */
    isInSilentPeriod() {
        return this.isInSilentPeriodAt(new Date())
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