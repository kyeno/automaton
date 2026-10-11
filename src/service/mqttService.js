/**
 * MQTT service for Zigbee2MQTT bridge communication.
 * Manages broker connection with circuit-breaker auto-reconnect, semantic.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import mqtt from 'mqtt'
import { randomBytes } from 'node:crypto'
import EventBus from './eventBus.js'
import LoggerService from './loggerService.js'
import StateService from './stateService.js'


/** Maximum number of reconnection attempts before opening the circuit breaker.
 * @type {number} */
const MAX_RECONNECT_ATTEMPTS = 15

/** Upper bound for exponential backoff delay in milliseconds.
 * @type {number} */
const MAX_RECONNECT_DELAY_MS = 30_000

/** Base delay for exponential backoff in milliseconds.
 * @type {number} */
const RECONNECT_BASE_DELAY_MS = 1_000

/** Deduplication window in milliseconds.
 * @type {number} */
const DEDUPE_WINDOW_MS = 300

/** Client ID prefix for MQTT connections.
 * @type {string} */
const CLIENT_ID_PREFIX = 'AUTOMATONv2-'

/** Maximum number of commands released per batch from the outgoing queue.
 * @type {number} */
const COMMAND_BATCH_SIZE = 2

/** Delay in milliseconds between consecutive batches of outgoing commands.
 * @type {number} */
const INTER_BATCH_DELAY_MS = 300

/** Retry delay when the drain loop finds the client disconnected.
 * @type {number} */
const DISCONNECT_RETRY_DELAY_MS = 1_000

/** Maximum listeners on the underlying MqttClient event emitter.
 * @type {number} */
const MAX_CLIENT_LISTENERS = 32

/** Interval between MQTT heartbeat events in milliseconds.
 * @type {number} */
const HEARTBEAT_INTERVAL_MS = 30_000

/** Semantic keys that define meaningful device state.
 * @readonly
 * @type {Set<string>} */
const SEMANTIC_KEYS = Object.freeze(new Set([
    //  Core actuator state.
    'state', 'position', 'action', 'action_group',
    //  Environmental sensors.
    'temperature', 'humidity', 'soil_moisture', 'illuminance', 'brightness',
    //  Power metrics.
    'power', 'energy', 'current', 'voltage',
    //  Safety / climate.
    'child_lock', 'countdown', 'fan_mode', 'mode',
    'heating_setpoint', 'cooling_setpoint',
    'occupied_heating_setpoint', 'unoccupied_heating_setpoint',
    'running_state', 'local_temperature',
    //  Cover / motion events.
    'cover_event',
    //  Presence / air quality.
    'consumer_connected', 'gas', 'co2',
    'formaldehyde', 'pm25', 'smoke', 'water_leak', 'gas_density',
    //  Appliance controls.
    'motor_speed', 'opening_mode', 'factory_reset',
    'indicator_mode', 'power_outage_memory',
]))

/** Per-channel suffixed variants of semantic fields (state_l1, brightness_left,
 * @readonly */
const CHANNEL_SIG_RE = /^(state|position|brightness)_[a-z0-9]+$/i

//  SMQTTService (module-level singleton)

/** MQTT service wrapper around the `mqtt` package.
 * @see {@link https://www.npmjs.com/package/mqtt} */
class SMQTTService {

    #client
    #url
    #prefix
    #reconnectAttempts = 0
    #subscriptions = []
    #lastSemanticByTopic = new Map()
    #reconnectCallbacks = []
    #circuitOpen = false
    #shuttingDown = false
    /** Heartbeat interval timer. */
     /** @type {NodeJS.Timeout|null} */
    #heartbeatTimer = null
    /** Outgoing command queue - FIFO array of { topic, payload, options } objects. */
    #commandQueue = []
    /** Whether a drain cycle is currently in progress. */
    #draining = false
    /** Injectable client factory (defaults to mqtt.connect); used by tests. */
    #connectFn = null

    //  -- Lifecycle --------------------------------------------------------

    /** Initialize and connect to the MQTT broker.
     * @param {Object} [options] - Optional initialization overrides
     * @param {Function} [options.connectFn] - Client factory with the same signature as
     * @async */
    async init(options = {}) {
        LoggerService.info('Initializing...', 'MqttService')

        this.#url = process.env['MQTT_URL']
        this.#prefix = process.env['MQTT_PREFIX'] ?? 'zigbee2mqtt'
        this.#connectFn = typeof options?.connectFn === 'function' ? options.connectFn : null

        await this.#connect()
        this.#setupEventHandlers()
        this.#startDispatcher()
    }

    /** Create a new MQTT client and wait for the `'connect'` event.
     * @private */
    async #connect() {
        return new Promise((resolve, reject) => {
            this.#client = (this.#connectFn || mqtt.connect)(this.#url, {
                clientId: `${CLIENT_ID_PREFIX}${randomBytes(4).toString('hex')}`,
                reconnectPeriod: 0
            })

            this.#client.on('connect', () => {
                this.#reconnectAttempts = 0
                this.#circuitOpen = false
                StateService.set('mqtt.connected', true)
                LoggerService.info('Connected to broker', 'MqttService')
                this.#startHeartbeat()
                resolve()
            })

            this.#client.on('error', (error) => {
                LoggerService.error(`Connection error: ${error.message}`, 'MqttService')
                reject(error)
            })
        })
    }


    /** Start periodic heartbeat events via EventBus.
     * @private */
    #startHeartbeat() {
        this.#stopHeartbeat()
        this.#heartbeatTimer = setInterval(() => {
            if (this.#client?.connected) {
                EventBus.emit('mqtt:heartbeat', { connected: true })
            } else {
                EventBus.emit('mqtt:heartbeat', { connected: false })
            }
        }, HEARTBEAT_INTERVAL_MS)
    }

    /** Stop the heartbeat interval timer.
     * @private */
    #stopHeartbeat() {
        if (this.#heartbeatTimer !== null) {
            clearInterval(this.#heartbeatTimer)
            this.#heartbeatTimer = null
        }
    }

    //  -- Reconnection (Circuit Breaker) -----------------------------------

    /** Calculate exponential backoff delay for a reconnection attempt.
     * @param {number} attempt - 1-based attempt number
     * @returns {number} Delay in milliseconds
     * @private */
    #getReconnectDelay(attempt) {
        return Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
            MAX_RECONNECT_DELAY_MS
        )
    }

    /** Schedule a reconnection with exponential backoff and circuit breaker.
     * @private */
    #scheduleReconnect() {
        if (this.#circuitOpen) return

        this.#reconnectAttempts++
        const attempt = this.#reconnectAttempts
        const delay = this.#getReconnectDelay(attempt)

        if (attempt > MAX_RECONNECT_ATTEMPTS) {
            this.#circuitOpen = true
            LoggerService.error(
                `MQTT circuit breaker open after ${attempt} failed attempts. ` +
                `Call resetCircuit() to manually retry.`,
                'MqttService'
            )
            return
        }

        LoggerService.error(
            `>> MQTT reconnect attempt #${attempt} scheduled (next in ${delay}ms)...`,
            'MqttService'
        )

        //  Notify registered callbacks so devices know a reconnect is pending.
        this.#reconnectCallbacks.forEach(cb => cb())

        setTimeout(() => {
            this.#doReconnect()
        }, delay)
    }

    /** Perform the actual reconnect by destroying the old client and creating a new one.
     * @private */
    #doReconnect() {
        if (this.#circuitOpen) return

        //  Stop heartbeat before tearing down the old client.
        this.#stopHeartbeat()

        //  Immediately mark as disconnected so the status bar updates right away.
        StateService.set('mqtt.connected', false)

        //  Safely destroy the old client - it may be in a corrupted state.
        if (this.#client && typeof this.#client.destroy === 'function') {
            try {
                this.#client.destroy(true)
            } catch (e) {
                LoggerService.debug(`Client cleanup during reconnect: ${e.message}`, 'MqttService')
            }
        }

        try {
            this.#client = (this.#connectFn || mqtt.connect)(this.#url, {
                clientId: `${CLIENT_ID_PREFIX}${randomBytes(4).toString('hex')}`,
                reconnectPeriod: 0
            })

            this.#client.on('connect', () => {
                this.#reconnectAttempts = 0
                this.#circuitOpen = false
                StateService.set('mqtt.connected', true)
                LoggerService.info('** MQTT RECONNECTED successfully', 'MqttService')
                //  Restore full event handling after reconnect.
                this.#setupEventHandlers()
                //  Re-subscribe to all previously registered topics.
                this.#resubscribeAll()
                //  Restart dispatcher and heartbeat.
                this.#startDispatcher()
                this.#startHeartbeat()
            })

            this.#client.on('error', (error) => {
                LoggerService.error(`!! MQTT reconnect FAILED: ${error.message}`, 'MqttService')
                this.#scheduleReconnect()
            })

            this.#client.on('close', () => {
                if (this.#shuttingDown) return
                StateService.set('mqtt.connected', false)
                LoggerService.error('*** MQTT DISCONNECTED - connection lost, scheduling reconnect...', 'MqttService')
                this.#scheduleReconnect()
            })
        } catch (e) {
            LoggerService.error(`Failed to create new MQTT client during reconnect: ${e.message}`, 'MqttService')
            this.#scheduleReconnect()
        }
    }

    /** Reset the circuit breaker so reconnection attempts resume. */
    resetCircuit() {
        if (!this.#circuitOpen) return

        this.#circuitOpen = false
        this.#reconnectAttempts = 0
        LoggerService.info('MQTT circuit breaker reset, attempting reconnect...', 'MqttService')
        this.#doReconnect()
    }

    //  -- Re-subscription --------------------------------------------------

    /** Re-subscribe to all previously registered broker-level topics.
     * @private */
    #resubscribeAll() {
        const seen = new Set()
        for (const sub of this.#subscriptions) {
            if (seen.has(sub.topic)) continue
            seen.add(sub.topic)
            this.#client.subscribe(sub.topic, (error) => {
                if (error) {
                    LoggerService.error(`Re-subscribe failed for "${sub.topic}": ${error.message}`, 'MqttService')
                } else {
                    LoggerService.debug(`Re-subscribed to "${sub.topic}"`, 'MqttService')
                }
            })
        }
    }

    //  -- Callbacks --------------------------------------------------------

    /** Attach lifecycle event listeners to the MQTT client after initial connect.
     * @private */
    #setupEventHandlers() {
        this.#client.on('close', () => {
            if (this.#shuttingDown) return
            StateService.set('mqtt.connected', false)
            LoggerService.error('*** MQTT DISCONNECTED - connection lost, scheduling reconnect...', 'MqttService')
            this.#scheduleReconnect()
        })

        this.#client.on('error', (error) => {
            LoggerService.error(`MQTT error: ${error.message}`, 'MqttService')
            if (!this.#client.connected) {
                StateService.set('mqtt.connected', false)
                this.#scheduleReconnect()
            }
        })

        this.#client.on('offline', () => {
            StateService.set('mqtt.connected', false)
            LoggerService.error('** MQTT client went OFFLINE', 'MqttService')
        })
    }


    /** Start a single message dispatcher on the MQTT client.
     * @private */
    #startDispatcher() {
        if (this.#client.listenerCount('message') > 0) return

        this.#client.setMaxListeners(MAX_CLIENT_LISTENERS)

        this.#client.on('message', (topic, payload) => {
            const message = payload.toString()
            const now = Date.now()

            //  Semantic deduplication is skipped when at least one matching subscriber opted out.
            if (!this.#hasNoDedupeSubscriber(topic)) {
                //  Build a semantic signature from the payload (ignores volatile fields).
                const sig = this.#extractSignature(message)
                const last = this.#lastSemanticByTopic.get(topic)

                if (last && last.signature === sig && now - last.timestamp < DEDUPE_WINDOW_MS) {
                    return // Semantic duplicate -- skip silently
                }
                this.#lastSemanticByTopic.set(topic, { signature: sig, timestamp: now })
            }

            for (const sub of this.#subscriptions) {
                if (this.#topicMatches(sub.topic, topic)) {
                    try {
                        sub.callback(topic, message)
                    } catch (e) {
                        LoggerService.error(
                            `Subscription callback threw for topic "${topic}": ${e.message}`,
                            'MqttService'
                        )
                    }
                }
            }
        })
    }

    /** Whether any registered subscription that matches an incoming topic has opted out of semantic.
     * @param {string} topic - The exact received MQTT topic
     * @returns {boolean} true only when at least one matching subscriber disabled dedupe
     * @private */
    #hasNoDedupeSubscriber(topic) {
        for (const sub of this.#subscriptions) {
            if (sub.dedupe === false && this.#topicMatches(sub.topic, topic)) return true
        }
        return false
    }

    /** Extract a deduplication signature from an MQTT payload by keeping only.
     * @param {string} raw - Raw JSON payload string
     * @returns {string} Deduplication signature
     * @private */
    #extractSignature(raw) {
        try {
            const obj = JSON.parse(raw)
            if (typeof obj !== 'object' || obj === null) return raw

            //  If this is a bridge logging wrapper, extract the inner payload string.
            if ('level' in obj && 'message' in obj) {
                const m = obj.message
                if (typeof m === 'string' && m.includes('payload ')) {
                    const idx = m.indexOf("payload '", m.indexOf('topic'))
                    if (idx !== -1) {
                        const endIdx = m.indexOf("'", idx + 9)
                        if (endIdx !== -1) {
                            const innerRaw = m.substring(idx + 9, endIdx)
                            return this.#extractSignature(innerRaw.replace(/\\'/g, "'"))
                        }
                    }
                }
                return raw // Fallback for non-standard log format
            }

            const sig = {}
            for (const [key, value] of Object.entries(obj)) {
                if (SEMANTIC_KEYS.has(key) || CHANNEL_SIG_RE.test(key)) {
                    sig[key] = value
                }
            }
            return JSON.stringify(sig)
        } catch {
            // Not valid JSON -- use raw string as-is.
            return raw
        }
    }

    /**
     * Check whether an incoming topic matches a subscription pattern.
     * Supports exact match, `#` multi-level wildcard, and `+` single-level wildcard.
     *
     * @param {string} pattern - Subscribed topic pattern (e.g., "zigbee2mqtt/bridge/#")
     * @param {string} received - Actual topic of incoming message
     * @returns {boolean}
     * @private
     */
    #topicMatches(pattern, received) {
        // Exact match -- fast path
        if (pattern === received) return true

        // No wildcard -- no match
        if (!pattern.includes('#') && !pattern.includes('+')) return false

        const patternParts = pattern.split('/')
        const receivedParts = received.split('/')

        let p = 0, r = 0
        while (p < patternParts.length && r < receivedParts.length) {
            if (patternParts[p] === '#') {
                // # matches zero or more remaining levels
                return true
            }
            if (patternParts[p] === '+') {
                // + matches exactly one level
                p++
                r++
                continue
            }
            if (patternParts[p] !== receivedParts[r]) {
                return false
            }
            p++
            r++
        }

        // Both must be fully consumed (or pattern ends with # which already returned).
        return p === patternParts.length && r === receivedParts.length
    }

    // -- Public API -------------------------------------------------------

    /**
     * Register a callback invoked whenever the MQTT client reconnects.
     * Used by DeviceContainer to trigger idempotent re-subscription of device topics.
     *
     * @param {Function} callback - Reconnect handler
     */
    onReconnect(callback) {
        if (typeof callback === 'function' && !this.#reconnectCallbacks.includes(callback)) {
            this.#reconnectCallbacks.push(callback)
        }
    }

    /**
     * Get the MQTT topic prefix (e.g., "zigbee2mqtt").
     *
     * @return {string} prefix
     */
    getPrefix() {
        return this.#prefix
    }

    /**
     * Enqueue a message for publication to an MQTT topic.
     *
     * Instead of publishing immediately, the message is pushed to an internal
     * FIFO queue. A drain loop releases commands in batches of {@link COMMAND_BATCH_SIZE}
     * with {@link INTER_BATCH_DELAY_MS} delay between batches to prevent flooding
     * zigbee-herdsman's transaction queue (~3 concurrent outbound transactions max).
     *
     * This provides global rate limiting across all command sources:
     * automations, interactions, AI assistant, and remote device mappings all share
     * the same queue regardless of origin.
     *
     * If the broker is disconnected when the drain runs, it will retry every
     * {@link DISCONNECT_RETRY_DELAY_MS} until reconnection restores the pipeline.
     *
     * Callers may attach non-MQTT metadata under `options.meta`. The one
     * recognized key is `onPublish` -- a zero-argument callback invoked exactly
     * once at the moment the queued message is actually handed to the underlying
     * client (i.e., after any reconnect wait), so deferred side-effects such as
     * correlator registration or origin stamping run precisely when the command
     * leaves the process. `meta` itself is never forwarded to mqtt.js; unknown
     * meta keys are ignored.
     *
     * @param {string} topic - MQTT topic
     * @param {string|Object} message - Message to publish
     * @param {Object} [options] - Optional MQTT publish options
     * @param {Object} [options.meta] - Non-MQTT caller metadata (see above)
     * @param {Function} [options.meta.onPublish] - Invoked once on actual publish
     */
    publish(topic, message, options = {}) {
        if (this.#shuttingDown) return

        const payload = typeof message === 'object'
            ? JSON.stringify(message)
            : String(message)

        this.#commandQueue.push({ topic, payload, options })
        this.#drainQueue()
    }

    // -- Command Queue Drain -----------------------------------------------

    /**
     * Async drain loop that releases queued commands in controlled batches.
     *
     * Only one drain cycle runs at a time (#draining guard prevents concurrency).
     * Each iteration takes up to COMMAND_BATCH_SIZE items from the front of the
     * queue and publishes them. If more items remain, waits INTER_BATCH_DELAY_MS
     * before the next batch. If disconnected, retries after DISCONNECT_RETRY_DELAY_MS.
     *
     * @private
     */
    async #drainQueue() {
        // Prevent concurrent drain cycles
        if (this.#draining) return
        this.#draining = true

        try {
            while (this.#commandQueue.length > 0 && !this.#shuttingDown) {
                // Wait for connection if currently disconnected
                if (!this.#client?.connected) {
                    LoggerService.debug(
                        `Command queue paused: MQTT disconnected (${this.#commandQueue.length} pending)`,
                        'MqttService'
                    )
                    await new Promise(resolve => setTimeout(resolve, DISCONNECT_RETRY_DELAY_MS))
                    continue
                }

                // Release a batch of commands
                const batch = this.#commandQueue.splice(0, COMMAND_BATCH_SIZE)
                for (const entry of batch) {
                    try {
                        // Caller metadata (options.meta) is not an MQTT option -- strip it
                        // before handing options to the underlying client.
                        const { meta, ...mqttOptions } = entry.options ?? {}
                        this.#client.publish(entry.topic, entry.payload, mqttOptions)
                        // Fire onPublish hook so callers can defer side-effects
                        // (correlator registration, origin updates) to actual publish time.
                        // DeviceBase stores the hook under options.meta; entry.meta is kept
                        // as a defensive fallback for direct queue consumers.
                        const onPublish = meta?.onPublish ?? entry.meta?.onPublish
                        if (typeof onPublish === 'function') {
                            try {
                                onPublish()
                            } catch (e) {
                                LoggerService.error(
                                    `onPublish callback threw: ${e.message}`,
                                    'MqttService'
                                )
                            }
                        }
                    } catch (e) {
                        LoggerService.error(
                            `Failed to publish to "${entry.topic}": ${e.message}`,
                            'MqttService'
                        )
                    }
                }

                // If more items remain, wait before releasing the next batch
                if (this.#commandQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, INTER_BATCH_DELAY_MS))
                }
            }
        } finally {
            this.#draining = false
        }
    }

    /**
     * Subscribe to a specific topic (supports MQTT wildcards: # and +).
     *
     * Uses an internal subscription registry so device callbacks don't pile up
     * as individual listeners on MqttClient (avoids MaxListenersExceededWarning).
     * Incoming messages are matched against the pattern via proper MQTT wildcard logic.
     *
     * @param {string} topic - MQTT topic pattern (e.g., "zigbee2mqtt/bridge/#")
     * @param {Function} [callback] - Optional callback invoked on each matching message
     * @param {Object} [options] - Subscription options
     * @param {boolean} [options.dedupe=true] - When false, messages for topics matched by THIS subscriber bypass the 300ms semantic-deduplication window. Intended for non-idempotent channels such as AI chat input, where distinct prompts can share an identical (empty) semantic signature and must never be dropped as duplicates. Defaults to true -- every existing caller is unaffected.
     * @return {Function|undefined} Unsubscribe function to remove the listener, or undefined if no callback provided
     */
    subscribe(topic, callback, options = {}) {
        if (!this.#client || !this.#client.connected) {
            LoggerService.warn(
                `Cannot subscribe to "${topic}": MQTT client not connected`,
                'MqttService'
            )
            return
        }

        // Tell the broker we want messages for this topic.
        this.#client.subscribe(topic, (error) => {
            if (error) {
                LoggerService.error(`Cannot subscribe to "${topic}": ${error.message}`, 'MqttService')
                return
            }
            LoggerService.debug(`Broker subscribed to "${topic}"`, 'MqttService')
        })

        if (!callback) return

        // Dedupe defaults to ON so pre-existing callers keep byte-for-byte behavior; only an explicit
        // { dedupe:false } opts this subscription out of the duplicate window (see #hasNoDedupeSubscriber).
        const dedupe = !(options && options.dedupe === false)
        const entry = { topic, callback, dedupe }
        this.#subscriptions.push(entry)

        // Return unsubscribe function to prevent memory leaks.
        return () => {
            const idx = this.#subscriptions.indexOf(entry)
            if (idx !== -1) {
                this.#subscriptions.splice(idx, 1)
            }
            try {
                this.#client.unsubscribe(topic, () => {
                    LoggerService.info(`Unsubscribed from "${topic}"`, 'MqttService')
                })
            } catch (e) {
                LoggerService.warn(`Failed to unsubscribe from "${topic}": ${e.message}`, 'MqttService')
            }
        }
    }

    /**
     * Check if the MQTT client is connected.
     *
     * @return {boolean} connected
     */
    isConnected() {
        return this.#client?.connected ?? false
    }

    /**
     * Gracefully disconnect from the MQTT broker.
     *
     * @async
     */
    async disconnect() {
        if (this.#client) {
            return new Promise((resolve) => {
                try {
                    this.#shuttingDown = true
                    this.#reconnectCallbacks = []
                    this.#stopHeartbeat()
                    LoggerService.warn('MQTT connection ended', 'MqttService')
                    this.#client.end(false, () => {
                        LoggerService.info('MQTT disconnected gracefully', 'MqttService')
                        resolve()
                    })
                } catch (e) {
                    LoggerService.error(`MQTT disconnect error: ${e.message}`, 'MqttService')
                    resolve()
                }
            })
        }
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const MQTTService = Object.freeze(new SMQTTService())
export default MQTTService