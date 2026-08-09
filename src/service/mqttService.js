/**
 * MQTT service for Zigbee2MQTT bridge communication.
 *
 * Manages broker connection with circuit-breaker auto-reconnect, semantic
 * message deduplication, and a single-dispatcher subscription registry that
 * avoids Node's MaxListenersExceededWarning.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import mqtt from 'mqtt'
import { randomBytes } from 'node:crypto'
import EventBus from './eventBus.js'
import LoggerService from './loggerService.js'
import StateService from './stateService.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of reconnection attempts before opening the circuit breaker.
 * @type {number}
 */
const MAX_RECONNECT_ATTEMPTS = 15

/**
 * Upper bound for exponential backoff delay in milliseconds.
 * Reconnect delays grow as 1s, 2s, 4s, 8s ... capped at this value.
 * @type {number}
 */
const MAX_RECONNECT_DELAY_MS = 30_000

/**
 * Base delay for exponential backoff in milliseconds.
 * @type {number}
 */
const RECONNECT_BASE_DELAY_MS = 1_000

/**
 * Deduplication window in milliseconds.
 * Semantic-duplicate messages arriving within this window are silently dropped.
 * @type {number}
 */
const DEDUPE_WINDOW_MS = 300

/**
 * Client ID prefix for MQTT connections.
 * @type {string}
 */
const CLIENT_ID_PREFIX = 'AUTOMATONv2-'

/**
 * Maximum number of commands released per batch from the outgoing queue.
 * Zigbee herdsman can handle ~3 concurrent outbound transactions reliably.
 * Batches of 2 provide a safe margin while keeping throughput reasonable.
 * @type {number}
 */
const COMMAND_BATCH_SIZE = 2

/**
 * Delay in milliseconds between consecutive batches of outgoing commands.
 * Zigbee herdsman transaction queue needs ~200-400ms per round-trip
 * (request -> acknowledgment through mesh). 300ms is a safe middle ground.
 * @type {number}
 */
const INTER_BATCH_DELAY_MS = 300

/**
 * Retry delay when the drain loop finds the client disconnected.
 * Checked every second until reconnection restores the pipeline.
 * @type {number}
 */
const DISCONNECT_RETRY_DELAY_MS = 1_000

/**
 * Maximum listeners on the underlying MqttClient event emitter.
 * Raised above Node's default (10) to accommodate our single dispatcher
 * plus internal library listeners without triggering warnings.
 * @type {number}
 */
const MAX_CLIENT_LISTENERS = 32

/**
 * Interval between MQTT heartbeat events in milliseconds.
 * Emits `mqtt:heartbeat` via EventBus for monitoring dashboards and health checks.
 * @type {number}
 */
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Semantic keys that define meaningful device state.
 * Everything else is treated as volatile metadata and excluded from
 * deduplication signatures.
 * @readonly
 * @type {Set<string>}
 */
const SEMANTIC_KEYS = Object.freeze(new Set([
    // Core actuator state
    'state', 'position', 'action', 'action_group',
    // Environmental sensors
    'temperature', 'humidity', 'illuminance', 'brightness',
    // Power metrics
    'power', 'energy', 'current', 'voltage',
    // Safety / climate
    'child_lock', 'countdown', 'fan_mode', 'mode',
    'heating_setpoint', 'cooling_setpoint',
    'occupied_heating_setpoint', 'unoccupied_heating_setpoint',
    'running_state', 'local_temperature',
    // Cover / motion events
    'cover_event',
    // Presence / air quality
    'consumer_connected', 'gas', 'co2',
    'formaldehyde', 'pm25', 'smoke', 'water_leak', 'gas_density',
    // Appliance controls
    'motor_speed', 'opening_mode', 'factory_reset',
    'indicator_mode', 'power_outage_memory',
]))

// ---------------------------------------------------------------------------
// SMQTTService (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * MQTT service wrapper around the `mqtt` package.
 *
 * Provides connection management with circuit-breaker reconnection,
 * semantic message deduplication, and a subscription registry that
 * supports MQTT wildcard topic patterns without exceeding Node's
 * MaxListenersExceededWarning threshold.
 * ES module caching guarantees single instantiation.
 *
 * @see {@link https://www.npmjs.com/package/mqtt}
 */
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
    /** Heartbeat interval timer */
    /** @type {NodeJS.Timeout|null} */
    #heartbeatTimer = null
    /** Outgoing command queue - FIFO array of { topic, payload, options } objects */
    #commandQueue = []
    /** Whether a drain cycle is currently in progress */
    #draining = false

    // -- Lifecycle --------------------------------------------------------

    /**
     * Initialize and connect to the MQTT broker.
     *
     * Reads `MQTT_URL` (required) and optional `MQTT_PREFIX` env vars,
     * establishes the client connection, sets up event handlers, and starts
     * the single-message dispatcher.
     *
     * @async
     */
    async init() {
        LoggerService.info('Initializing...', 'MqttService')

        this.#url = process.env['MQTT_URL']
        this.#prefix = process.env['MQTT_PREFIX'] ?? 'zigbee2mqtt'

        await this.#connect()
        this.#setupEventHandlers()
        this.#startDispatcher()
    }

    /**
     * Create a new MQTT client and wait for the `'connect'` event.
     *
     * Disables the built-in mqtt library reconnection (`reconnectPeriod: 0`)
     * because reconnect logic is handled by our circuit breaker.
     *
     * @private
     */
    async #connect() {
        return new Promise((resolve, reject) => {
            this.#client = mqtt.connect(this.#url, {
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

    // -- Heartbeat ---------------------------------------------------------

    /**
     * Start periodic heartbeat events via EventBus.
     * Emits `mqtt:heartbeat` every {@link HEARTBEAT_INTERVAL_MS} milliseconds
     * with connection status and uptime for monitoring dashboards.
     *
     * @private
     */
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

    /**
     * Stop the heartbeat interval timer.
     *
     * @private
     */
    #stopHeartbeat() {
        if (this.#heartbeatTimer !== null) {
            clearInterval(this.#heartbeatTimer)
            this.#heartbeatTimer = null
        }
    }

    // -- Reconnection (Circuit Breaker) -----------------------------------

    /**
     * Calculate exponential backoff delay for a reconnection attempt.
     *
     * @param {number} attempt - 1-based attempt number
     * @returns {number} Delay in milliseconds
     * @private
     */
    #getReconnectDelay(attempt) {
        return Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
            MAX_RECONNECT_DELAY_MS
        )
    }

    /**
     * Schedule a reconnection with exponential backoff and circuit breaker.
     * After {@link MAX_RECONNECT_ATTEMPTS} failures the circuit opens and
     * further attempts stop -- call {@link resetCircuit} to manually retry.
     *
     * @private
     */
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

        // Notify registered callbacks so devices know a reconnect is pending.
        this.#reconnectCallbacks.forEach(cb => cb())

        setTimeout(() => {
            this.#doReconnect()
        }, delay)
    }

    /**
     * Perform the actual reconnect by destroying the old client and creating a new one.
     *
     * @private
     */
    #doReconnect() {
        if (this.#circuitOpen) return

        // Stop heartbeat before tearing down the old client
        this.#stopHeartbeat()

        // Immediately mark as disconnected so the status bar updates right away
        StateService.set('mqtt.connected', false)

        // Safely destroy the old client - it may be in a corrupted state
        // after certain types of connection failures (e.g., device power loss).
        // mqtt v5.x destroy(force=true) handles listener cleanup internally,
        // so do NOT call removeAllListeners() first as it can corrupt internal state.
        if (this.#client) {
            try {
                this.#client.destroy(true)
            } catch (e) {
                LoggerService.debug(`Client cleanup during reconnect: ${e.message}`, 'MqttService')
            }
        }

        try {
            this.#client = mqtt.connect(this.#url, {
                clientId: `${CLIENT_ID_PREFIX}${randomBytes(4).toString('hex')}`,
                reconnectPeriod: 0
            })

            this.#client.on('connect', () => {
                this.#reconnectAttempts = 0
                this.#circuitOpen = false
                StateService.set('mqtt.connected', true)
                LoggerService.info('** MQTT RECONNECTED successfully', 'MqttService')
                // Restore full event handling after reconnect
                this.#setupEventHandlers()
                // Re-subscribe to all previously registered topics
                this.#resubscribeAll()
                // Restart dispatcher and heartbeat
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

    /**
     * Reset the circuit breaker so reconnection attempts resume.
     * Useful when the broker comes back online after an extended outage.
     */
    resetCircuit() {
        if (!this.#circuitOpen) return

        this.#circuitOpen = false
        this.#reconnectAttempts = 0
        LoggerService.info('MQTT circuit breaker reset, attempting reconnect...', 'MqttService')
        this.#doReconnect()
    }

    // -- Re-subscription --------------------------------------------------

    /**
     * Re-subscribe to all previously registered broker-level topics.
     * Called after each successful reconnect since the mqtt library requires
     * explicit re-subscription on every new connection.
     *
     * @private
     */
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

    // -- Callbacks --------------------------------------------------------

    /**
     * Attach lifecycle event listeners to the MQTT client after initial connect.
     *
     * Handles `close`, `error`, and `offline` events -- all delegate to the
     * circuit-breaker scheduler when the connection is lost unexpectedly.
     *
     * @private
     */
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

    // -- Message Dispatcher -----------------------------------------------

    /**
     * Start a single message dispatcher on the MQTT client.
     *
     * Instead of adding one listener per subscription (which hits Node's
     * MaxListenersExceededWarning at 10+ listeners), we add exactly ONE
     * listener and iterate the subscription registry, checking each incoming
     * topic against the subscribed pattern via MQTT wildcard matching.
     *
     * @private
     */
    #startDispatcher() {
        if (this.#client.listenerCount('message') > 0) return

        this.#client.setMaxListeners(MAX_CLIENT_LISTENERS)

        this.#client.on('message', (topic, payload) => {
            const message = payload.toString()
            const now = Date.now()

            // Build a semantic signature from the payload (ignores volatile fields).
            const sig = this.#extractSignature(message)
            const last = this.#lastSemanticByTopic.get(topic)

            if (last && last.signature === sig && now - last.timestamp < DEDUPE_WINDOW_MS) {
                return // Semantic duplicate -- skip silently
            }
            this.#lastSemanticByTopic.set(topic, { signature: sig, timestamp: now })

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

    /**
     * Extract a deduplication signature from an MQTT payload by keeping only
     * semantic state fields ({@link SEMANTIC_KEYS}) and discarding volatile metadata.
     *
     * @param {string} raw - Raw JSON payload string
     * @returns {string} Deduplication signature
     * @private
     */
    #extractSignature(raw) {
        try {
            const obj = JSON.parse(raw)
            if (typeof obj !== 'object' || obj === null) return raw

            // If this is a bridge logging wrapper, extract the inner payload string.
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
                if (SEMANTIC_KEYS.has(key)) {
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
     * @param {string} topic - MQTT topic
     * @param {string|Object} message - Message to publish
     * @param {Object} [options] - Optional MQTT publish options
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
                        this.#client.publish(entry.topic, entry.payload, entry.options)
                        // Fire onPublish hook so callers can defer side-effects
                        // (correlator registration, origin updates) to actual publish time.
                        if (typeof entry.meta?.onPublish === 'function') {
                            try {
                                entry.meta.onPublish()
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
     * @return {Function|undefined} Unsubscribe function to remove the listener, or undefined if no callback provided
     */
    subscribe(topic, callback) {
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

        const entry = { topic, callback }
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