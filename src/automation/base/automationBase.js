/**
 * Abstract base class for all automations.
 * Manages lifecycle (init, cleanup), EventBus trigger subscriptions, periodic.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
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
import DeviceStateOrigin from '../../enum/deviceStateOrigin.js'


/** Default cooldown after human interaction before automation resumes (ms). */
const DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS = 15 * 60 * 1_000

/** Default timer interval -- `0` means timer is disabled; automation is event-driven only. */
const DEFAULT_TIMER_INTERVAL_MS = 0

/** Maximum acceptable timer interval -- setInterval clamps silently above 32 bits (~24.8 days). */
const MAX_SETTABLE_INTERVAL_MS = 0x7FFFFFFF

/** Quiescence window (ms) for coalescing near-simultaneous EventBus trigger events into a single run. */
const TRIGGER_COALESCE_MS = 250

//  AutomationBase (abstract)

/** Abstract base class for all automations. */
export default class AutomationBase {

    /** When true, this automation bypasses the human-interaction cooldown check
     * @type {boolean} */
    #overrideHumanInteraction = false

    /** EventBus topics awaiting a consolidated {@link execute} run (trigger coalescing). */
    #triggerQueue = []

    /** Active setTimeout handle used to schedule a trailing-edge trigger flush. */
    #flushTimer = null

    /** True while a consolidated event-triggered {@link execute} is in flight. */
    #flushing = false

    //  -- Constructor --------------------------------------------------------

    /** Construct an automation instance.
     * @param {object} options - Constructor options
     * @param {string} options.name - Display name of the automation (used in log context)
     * @param {Record<string, unknown>} [options.config] - Parsed YAML configuration or inline config object */
    constructor({ name, config = {} }) {
        this.name = name
        this.config = config
        this._initialized = false   // guard against double init() calls
        this._timer = null          // setInterval handle
        this._unsubscribes = []     // stored unsubscribe functions for cleanup
        this.#overrideHumanInteraction = Boolean(config?.override_human_interaction)
    }

    /** Set whether this automation overrides the human-interaction cooldown.
     * @param {boolean} value - true to bypass cooldowns, false to respect them */
    setOverrideHumanInteraction(value) {
        this.#overrideHumanInteraction = Boolean(value)
    }

    /** Whether this automation overrides the human-interaction cooldown.
     * @returns {boolean} true if cooldowns are bypassed for this automation's targets */
    getOverrideHumanInteraction() {
        return this.#overrideHumanInteraction
    }

    //  -- Lifecycle ----------------------------------------------------------

    /** Initialize the automation: subscribe to EventBus triggers and start timer.
     * @async */
    async init() {
        //  Guard against double initialization -- prevents duplicate subscriptions + timers.
        if (this._initialized) {
            LoggerService.warn(
                `${this.name}.init() called more than once, subsequent call ignored`,
                `Auto:${this.name}`
            )
            return
        }
        this._initialized = true

        //  Subscribe to EventBus triggers.
        const triggers = this.getTriggerTopics()
        if (triggers && triggers.length > 0) {
            for (const topic of triggers) {
                const unsub = EventBus.subscribe(topic, () => {
                    //  Route through the coalescing queue so several hosts changing state at once.
                    this.#enqueueTrigger(topic)
                })
                if (unsub) {
                    this._unsubscribes.push(unsub)
                }
            }
            LoggerService.info(`${this.name} subscribed to triggers: [${triggers.join(', ')}]`, `Auto:${this.name}`)
        }

        //  Start periodic timer if configured.
        const intervalMs = this.getTimerIntervalMs()
        if (intervalMs != null && intervalMs > 0) {
            this.startTimer(intervalMs)
        }
    }

    //  -- Public API ---------------------------------------------------------

    /** Return a list of EventBus topics this automation wants to react to.
     * @return {string[]} Array of topic strings to subscribe to */
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

        if (Array.isArray(this.config?.triggers_video)) {
            for (const name of this.config.triggers_video) {
                topics.push(`videoPlayer:${name}`)
            }
        }

        return topics
    }

    /** Return the interval in milliseconds for the periodic timer.
     * @return {number|null} Interval in milliseconds, or null/0 to disable */
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

    /** This automation's most recent rule matches, newest first.
     * @returns {Array<Object>} Recent matches (always empty for non-rule automations) */
    getRecentRuleMatches() {
        return []
    }

    //  -- Abstract method ----------------------------------------------------

    /** Main execution logic -- pure virtual; must be overridden by subclasses.
     * @param {{trigger: string}|null} [triggerData] - Trigger metadata (e.g., `{trigger: 'zigbee:Living Room Light'}`)
     * @throws {Error} If not overridden */
    execute(triggerData = null) {
        throw new Error('Method "execute()" must be implemented in subclasses.')
    }

    //  -- Timer management ---------------------------------------------------

    /** Start a periodic timer that calls {@link execute} at fixed intervals.
     * @param {number} intervalMs - Interval in milliseconds */
    startTimer(intervalMs) {
        const _tick = () => {
            try {
                this.execute({ trigger: 'timer' })
            } catch (error) {
                LoggerService.error(`Error executing timer for ${this.name}: ${error.message}`, `Auto:${this.name}`)
            }
        }

        //  Defensive re-entry guard: never leak a previous handle -- two live intervals for one.
        if (this._timer != null) clearInterval(this._timer)

        this._timer = setInterval(_tick, intervalMs)
        LoggerService.info(
            `${this.name} timer started with interval ${temporal.millisecondsToHumanReadable(intervalMs)}`,
            `Auto:${this.name}`
        )
    }

    /** Stop the periodic timer. */
    stopTimer() {
        if (this._timer) {
            clearInterval(this._timer)
            this._timer = null
            LoggerService.info(`${this.name} timer stopped`, `Auto:${this.name}`)
        }
    }

    /** Enqueue an EventBus-triggered run. Near-simultaneous trigger events are coalesced.
     * @private
     * @param {string} topic - The triggering EventBus topic */
    #enqueueTrigger(topic) {
        this.#triggerQueue.push(topic)
        if (this.#flushTimer != null || this.#flushing) return   // already scheduled / draining
        this.#scheduleTriggerFlush()
    }

    /** Schedule a trailing-edge flush of queued triggers after a short quiescence window.
     * @private */
    #scheduleTriggerFlush() {
        this.#flushTimer = setTimeout(() => {
            this.#flushTimer = null
            void this.#runQueuedTriggers()
        }, TRIGGER_COALESCE_MS)
        if (typeof this.#flushTimer.unref === 'function') this.#flushTimer.unref()
    }

    /** Drain the trigger queue: run one consolidated {@link execute} per batch, picking up any topics
     * @private */
    async #runQueuedTriggers() {
        this.#flushing = true
        try {
            for (;;) {
                const batch = this.#triggerQueue.splice(0)
                if (batch.length === 0) break
                await this.execute({ trigger: batch.join(',') })
            }
        } catch (error) {
            LoggerService.error(`Error executing coalesced event trigger(s) for ${this.name}: ${error.message}`, `Auto:${this.name}`)
        } finally {
            this.#flushing = false
            //  Topics may have arrived during the drain; schedule another pass if needed.
            if (this.#triggerQueue.length > 0 && this.#flushTimer == null) this.#scheduleTriggerFlush()
        }
    }

    /** Reset trigger-coalescing state (used on cleanup / re-init).
     * @private */
    #resetTriggerCoalescing() {
        if (this.#flushTimer != null) {
            clearTimeout(this.#flushTimer)
            this.#flushTimer = null
        }
        this.#triggerQueue.length = 0
        this.#flushing = false
    }

    //  -- Cleanup ------------------------------------------------------------

    /** Clean up all event subscriptions and timers. */
    cleanup() {
        this.stopTimer()
        this.#resetTriggerCoalescing()
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

    /** Return the human-interaction cooldown in milliseconds.
     * @returns {number} Cooldown in milliseconds (>= 0) */
    getHumanInteractionCooldownMs() {
        const raw = ConfigService.get('automation.human_interaction_cooldown_ms')
        if (raw == null) return DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS
        const ms = temporal.parseDurationMs(raw)
        if (ms == null || ms < 0) {
            LoggerService.warn(
                `Invalid automation.human_interaction_cooldown_ms ${JSON.stringify(raw)} (expected e.g. "25m" or plain milliseconds); using default (${temporal.millisecondsToHumanReadable(DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS)})`,
                `Auto:${this.name}`
            )
            return DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS
        }
        return ms
    }

    /** Parse the configured `silence_between` window ("HHmm-HHmm") into minutes-of-day bounds.
     * @returns {{startMin: number, endMin: number}|null} Window bounds in minutes from midnight */
    parseSilenceWindow() {
        const silenceConfig = this.config?.silence_between
        if (!silenceConfig || typeof silenceConfig !== 'string') return null

        //  Parse "HHmm-HHmm" -- e.g. "0500-0900", "2300-0600"
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

        //  start === end means the window covers either all or no time -- treat as no-op.
        if (startMin === endMin) return null
        return { startMin, endMin }
    }

    /** Check whether a specific moment falls within the configured silent period.
     * @param {Date} [date=new Date()] - Moment to check
     * @returns {boolean} true if the given moment is inside the silent window */
    isInSilentPeriodAt(date = new Date()) {
        const win = this.parseSilenceWindow()
        if (!win) return false

        const minutes = date.getHours() * 60 + date.getMinutes()
        if (win.startMin < win.endMin) {
            //  Normal range: e.g., 0500-0900 -> between 5 AM and 9 AM.
            return minutes >= win.startMin && minutes < win.endMin
        }
        //  Overnight wrap: e.g., 2300-0600 -> from 11 PM to 6 AM next day.
        return minutes >= win.startMin || minutes < win.endMin
    }

    /** Check whether the current local time falls within the configured silent period.
     * @returns {boolean} true if execution should be suppressed right now */
    isInSilentPeriod() {
        return this.isInSilentPeriodAt(new Date())
    }

    /** Check whether a device is under a human-interaction cooldown using Redis TTL.
     * @param {object} device - Device instance with getName() method
     * @param {{bypassCooldown?: boolean}} [options] - When bypassCooldown is true (forced manual
     * @returns {Promise<boolean>} true if the device should be skipped due to recent human interaction */
    async checkAndLogHumanInteraction(device, { bypassCooldown = false } = {}) {
        if (bypassCooldown) {
            this.log(`Human-interaction cooldown bypassed for ${device.getName()} (forced run)`, 'debug')
            return false
        }

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
        } catch (error) {
            //  Redis unavailable -- fall through to the local origin check below instead.
            LoggerService.warn(
                `Redis cooldown lookup failed for "${device.getName()}": ${error.message} -- falling back to live device origin`,
                `Auto:${this.name}`
            )
        }

        //  Local fallback: a fresh HUMAN origin on the device means someone just.
        if (typeof device.getStateOrigin === 'function' && typeof device.getStateLastAt === 'function') {
            if (device.getStateOrigin() === DeviceStateOrigin.HUMAN) {
                const lastAtMs = Date.parse(device.getStateLastAt() ?? '')
                const windowMs = this.getHumanInteractionCooldownMs()
                if (Number.isFinite(lastAtMs) && windowMs > 0 && Date.now() - lastAtMs < windowMs) {
                    this.log('Skipping -- recent human interaction detected via live device origin', 'debug')
                    return true
                }
            }
        }

        return false
    }

    /** Helper method to log messages associated with this automation.
     * @param {string} message - The message to log
     * @param {string} level - Log level ('info', 'debug', 'trace', 'warn', 'error') */
    log(message, level = 'info') {
        const context = `Auto:${this.name}`
        switch (level.toLowerCase()) {
            case 'trace': LoggerService.trace(message, context); break
            case 'debug': LoggerService.debug(message, context); break
            case 'warn':  LoggerService.warn(message, context); break
            case 'error': LoggerService.error(message, context); break
            default:      LoggerService.info(message, context); break
        }
    }
}