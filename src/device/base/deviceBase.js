/**
 * Abstract base class for all Zigbee devices.
 *
 * Provides Origin-based state provenance (`unknown` -> `automation` | `human`)
 * via {@link CommandCorrelator} causality tokens, MQTT subscription lifecycle
 * management, Redis-backed state persistence, and unified logging helpers.
 *
 * Subclasses: {@link ../type/sensor.js}, {@link ../type/mechanism.js},
 *   {@link ../type/remote.js}, {@link ../type/bridge.js}, {@link ../type/dummy.js}
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CacheService from '../../service/cacheService.js'
import EventBus from '../../service/eventBus.js'
import LoggerService from '../../service/loggerService.js'
import DeviceStateOrigin from '../../enum/deviceStateOrigin.js'
import { slugify } from '../../lib/string.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Grace period after an AI command during which unmatched MQTT messages are
 * treated as AI continuation rather than human interaction. Roller shutters
 * take ~40-60 seconds to complete full travel.
 * @type {number}
 */
const AI_GRACE_PERIOD_MS = 90_000

/**
 * How long (ms) to consider incoming MQTT messages as echoes of an AI
 * command. Zigbee2MQTT state confirmations typically arrive within 500ms-3s,
 * but can be delayed by network latency, device sleep cycles, or broker
 * reconnection. 30 seconds provides a safe margin for these edge cases.
 * @type {number}
 */
const AI_ECHO_WINDOW_MS = 30_000

/**
 * Default TTL for correlation tokens in milliseconds.
 * @type {number}
 */
const CORRELATOR_DEFAULT_TTL_MS = 30_000

/**
 * How long (seconds) automations should skip a device after detecting human
 * interaction. Matches DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS from AutomationBase
 * (15 minutes). Used when setting the Redis cooldown key so automations can
 * check remaining time via getHumanCooldownRemaining().
 * @type {number}
 */
const HUMAN_INTERACTION_COOLDOWN_SECONDS = 15 * 60

/**
 * Position tolerance threshold for matching roller shutter positions.
 * @type {number}
 */
const POSITION_MATCH_TOLERANCE = 2

/**
 * Threshold for "nearly fully open" roller shutter position comparison.
 * @type {number}
 */
const POSITION_NEARLY_OPEN_THRESHOLD = 98

/**
 * Threshold for "nearly fully closed" roller shutter position comparison.
 * @type {number}
 */
const POSITION_NEARLY_CLOSED_THRESHOLD = 2

/**
 * Minimum meaningful illuminance change (lux).
 * @type {number}
 */
const ILLUMINANCE_CHANGE_THRESHOLD = 500

/**
 * Minimum meaningful temperature change (degrees Celsius).
 * @type {number}
 */
const TEMPERATURE_CHANGE_THRESHOLD = 0.5

/**
 * Minimum meaningful humidity change (%).
 * @type {number}
 */
const HUMIDITY_CHANGE_THRESHOLD = 1

/**
 * Maximum length for truncated log summaries.
 * @type {number}
 */
const SUMMARY_TRUNCATE_LENGTH = 80

// ---------------------------------------------------------------------------
// CommandCorrelator -- causality token tracker
// ---------------------------------------------------------------------------

/**
 * Solves the AI echo vs. human interaction problem using causality tokens
 * instead of timestamp heuristics.
 *
 * How it works:
 *   1. When AI sends a command, a unique correlation token is generated and
 *      registered together with the expected resulting state and a TTL.
 *   2. When an MQTT message arrives, the correlator checks whether it matches
 *      any pending token (by expected state + within TTL). A match = AI echo.
 *   3. No match = external (human) interaction.
 *
 * This is a deterministic, single-source-of-truth approach. The origin of the
 * current state is an explicit property  --  not derived from comparing timestamps.
 */
class CommandCorrelator {

    /**
     * Pending correlation tokens.
     * @type {Map<string, {expectedState: string, expiresAt: number}>}
     */
    #pending = new Map()

    /**
     * Monotonic counter for unique token generation.
     * @type {number}
     */
    #counter = 0

    // -- Public API -------------------------------------------------------

    /**
     * Register a new outgoing AI command.
     *
     * @param {string} expectedState - The state we expect the device to report (ON, OFF, OPEN, CLOSE, STOP)
     * @param {number} [ttlMs=CORRELATOR_DEFAULT_TTL_MS] - Time-to-live for the correlation window
     * @returns {string} A unique correlation token
     */
    register(expectedState, ttlMs = CORRELATOR_DEFAULT_TTL_MS) {
        const token = `cmd-${Date.now()}-${++this.#counter}`
        this.#pending.set(token, {
            expectedState: String(expectedState).toUpperCase(),
            expiresAt: Date.now() + ttlMs
        })
        return token
    }

    /**
     * Check whether an incoming MQTT message matches a pending AI command.
     * Consumes (removes) the matching token so it cannot match again.
     *
     * @param {Object} payload - Parsed MQTT message payload
     * @returns {boolean} true if this message is an AI echo
     */
    matchEcho(payload) {
        this.#expireStale()

        if (this.#pending.size === 0) return false

        const reportedState = payload.state ?? null
        const reportedPosition = payload.position ?? null

        for (const [token, entry] of this.#pending) {
            if (this.#statesMatch(entry.expectedState, reportedState, reportedPosition)) {
                this.#pending.delete(token)
                return true
            }
        }
        return false
    }

    /**
     * Has any pending AI command?
     * @returns {boolean}
     */
    hasPending() {
        return this.#pending.size > 0
    }

    // -- Private helpers --------------------------------------------------

    /**
     * Remove expired entries from the pending tokens map.
     * @private
     */
    #expireStale() {
        const now = Date.now()
        for (const [token, entry] of this.#pending) {
            if (now > entry.expiresAt) {
                this.#pending.delete(token)
            }
        }
    }

    /**
     * Check if reported values match the expected commanded state.
     * Handles:
     *   - Direct string state matches (ON, OFF, OPEN, CLOSE, STOP)
     *   - Position-based threshold matches (OPEN>=90, CLOSE<=10, STOP=any)
     *   - Exact position targets like "POS:12" with tolerance
     *
     * @param {string} expectedState - Expected state string
     * @param {string|null} reportedState - Reported state field
     * @param {number|null} reportedPosition - Reported position value
     * @returns {boolean}
     * @private
     */
    #statesMatch(expectedState, reportedState, reportedPosition) {
        const reportedUpper = reportedState !== null ? String(reportedState).toUpperCase() : null

        // Direct string match on state field
        if (reportedUpper === expectedState) {
            return true
        }

        // Semantic aliases for roller shutters: zigbee2mqtt reports ON/OFF instead of OPEN/CLOSE.
        //   CLOSE command -> device echoes {state: 'OFF'}
        //   OPEN command  -> device echoes {state: 'ON'}
        if (expectedState === 'CLOSE' && reportedUpper === 'OFF') return true
        if (expectedState === 'OPEN' && reportedUpper === 'ON') return true

        // Exact position target: "POS:N"  --  match against reported position with tolerance.
        if (expectedState.startsWith('POS:') && typeof reportedPosition === 'number' && !isNaN(reportedPosition)) {
            const targetPos = parseInt(expectedState.substring(4), 10)
            if (!isNaN(targetPos) && Math.abs(reportedPosition - targetPos) <= POSITION_MATCH_TOLERANCE) {
                return true
            }
        }

        // Position-based threshold match for roller shutters.
        // OPEN matches when device reports high position (>=90).
        // CLOSE matches when device reports low position (<=10).
        // STOP must NOT match just because a position field exists -- that would
        // cause a STOP token to consume ANY movement report (e.g., CLOSE at pos=58),
        // misclassifying human-initiated echoes as AI commands. STOP only matches
        // when the device explicitly reports state='STOP'.
        if (typeof reportedPosition === 'number' && !isNaN(reportedPosition)) {
            if (expectedState === 'OPEN' && reportedPosition >= 90) return true
            if (expectedState === 'CLOSE' && reportedPosition <= 10) return true
        }

        return false
    }
}

// ---------------------------------------------------------------------------
// DeviceBase (abstract)
// ---------------------------------------------------------------------------

/**
 * Device defaults. All device types extend this class.
 */
export default class DeviceBase {

    // -- Private state ----------------------------------------------------

    /** Device display name (e.g., `"Living Room Light"`) */
    #name = ''
    /** Zigbee2MQTT device ID or friendly-name slug */
    #id = ''
    /** Raw device configuration data from zigbee.yaml */
    #data = {}
    /** Last known state payload from MQTT (e.g., `{state: 'ON', position: 45}`) */
    #stateLast = {}
    /** Provenance of current state: `unknown`, `automation`, or `human` */
    #stateOrigin = DeviceStateOrigin.UNKNOWN
    /** ISO-8601 timestamp of last state change, or `null` on first boot */
    #stateLastAt = null
    /** Tracks in-flight AI commands for echo classification */
    #correlator = new CommandCorrelator()
    /** Epoch ms when the last AI command was sent (for grace-period checks) */
    #lastAiCommandAt = 0
    /** Redis cache key: `"zigbeedevice:<slug>:<id>"` */
    #cacheKey = ''
    /** Reference to shared {@link ../../service/mqttService.js} singleton */
    #mqttService = null
    /** Array of unsubscribe functions returned by MqttService.subscribe() */
    #subscriptions = []
    /** Set of already-subscribed topic strings (prevents double-subscription) */
    #subscribedTopics = new Set()
    /** Custom event listeners map (eventType -> callback[]) */
    #eventListeners = new Map()

    // -- Constructor ------------------------------------------------------

    /**
     * Construct a device instance.
     *
     * @param {string} name - Device display name from zigbee.yaml config
     * @param {string} id - Zigbee2MQTT friendly-name or device ID
     * @param {Record<string, unknown>} [data] - Raw device configuration object
     */
    constructor(name, id, data) {
        if (this.constructor === DeviceBase) {
            throw new Error('Abstract classes cannot be instantiated.')
        }

        this.#name = name
        this.#id = id
        this.#data = data
        this.#cacheKey = this.#generateCacheKey(name, id)
    }

    // -- Lifecycle --------------------------------------------------------

    /**
     * Async initialization called after construction.
     * Loads cached state from Redis into local variables.
     * Subclasses may override to add their own init logic.
     */
    async init() {
        const cached = await this.getCachedState()
        if (cached) {
            this.#stateLast = cached.stateLast ?? {}
            this.#stateLastAt = cached.stateLastAt ?? null
            this.#stateOrigin = cached.stateOrigin ?? DeviceStateOrigin.UNKNOWN
            LoggerService.debug(
                `Restored state from cache (origin=${this.#stateOrigin})`,
                `${this.getLogPrefix()}:${this.#name}`
            )
        }

        // The correlator is intentionally NOT restored. It tracks in-flight
        // commands only. After a restart, all previous commands are considered
        // completed and their echoes are no longer relevant.
        this.#correlator = new CommandCorrelator()
    }

    // -- Identity accessors -----------------------------------------------

    /**
     * Get device name.
     * @returns {string}
     */
    getName() {
        return this.#name
    }

    /**
     * Get device ID.
     * @returns {string}
     */
    getId() {
        return this.#id
    }

    // -- Cache accessors --------------------------------------------------

    /**
     * Generate a unique cache key for this device.
     * Uses slugify for consistent naming and prefixes with "zigbeedevice".
     *
     * @param {string} name - Device name
     * @param {string} id - Device ID
     * @returns {string} Cache key
     * @private
     */
    #generateCacheKey(name, id) {
        return `zigbeedevice:${slugify(name)}:${id}`
    }

    /**
     * Get the cache key for this device.
     * @returns {string}
     */
    getCacheKey() {
        return this.#cacheKey
    }

    /**
     * Retrieve persisted device state from Redis cache.
     *
     * @returns {Promise<{stateLast: Record<string,unknown>, stateLastAt: string|null, stateOrigin: string}|undefined>}
     */
    async getCachedState() {
        return await CacheService.get(this.#cacheKey)
    }

    /**
     * Persist device state to Redis cache.
     *
     * @param {Record<string, unknown>} state - Latest MQTT payload or computed state object
     * @param {object} [options] - Optional overrides
     * @param {string} [options.stateLastAt] - Explicit ISO-8601 timestamp (defaults to `now`)
     * @param {'unknown'|'automation'|'human'} [options.origin] - Explicit provenance override
     * @returns {Promise<boolean>} `true` on success
     */
    async setCachedState(state, options = {}) {
        this.#stateLast = state
        this.#stateLastAt = options.stateLastAt || new Date().toISOString()

        if (options.origin) {
            this.#stateOrigin = options.origin
        }

        const payload = {
            stateLast: this.#stateLast,
            stateLastAt: this.#stateLastAt,
            stateOrigin: this.#stateOrigin
        }
        return await CacheService.set(this.#cacheKey, payload)
    }

    // -- State tracking accessors -----------------------------------------

    /**
     * Retrieve the most recent MQTT payload for this device.
     *
     * @returns {Record<string, unknown>} Last known state object
     */
    getStateLast() {
        return this.#stateLast
    }

    /**
     * Get the timestamp of the last state change (by anyone).
     * @returns {string|null} ISO timestamp or null if unknown
     */
    getStateLastAt() {
        return this.#stateLastAt
    }

    /**
     * Get the origin of the current state.
     * Returns 'unknown', 'automation', or 'human'.
     *
     * This is the single source of truth for determining who caused the
     * current device state. Unlike the old timestamp-comparison approach,
     * this is explicit, deterministic, and survives restarts.
     *
     * @returns {string} One of DeviceStateOrigin.UNKNOWN, .AUTOMATION, .HUMAN
     */
    getStateOrigin() {
        return this.#stateOrigin
    }

    // -- Event emission ---------------------------------------------------

    /**
     * Emit an event with optional data.
     *
     * @param {string} eventType - The type of event to emit
     * @param {Object} [data={}] - Optional data to pass with the event
     */
    emit(eventType, data = {}) {
        if (eventType === 'mqttMessage') {
            this.handleMqttMessage(data)
        }

        const listeners = this.#eventListeners.get(eventType)
        if (listeners) {
            listeners.forEach(callback => callback(data))
        }
    }

    // -- MQTT message handling --------------------------------------------

    /**
     * Handle incoming MQTT messages.
     *
     * Uses the CommandCorrelator to determine whether this message is an
     * echo of an AI command or a genuine human-initiated state change.
     *
     * Classification logic:
     *   1. correlator.matchEcho(payload) -> true  = AI echo (consume token, preserve origin)
     *   2. correlator.matchEcho(payload) -> false + no state change = periodic report (ignore for origin)
     *   3. correlator.matchEcho(payload) -> false + state changed:
     *      a. within grace period AND has pending tokens = AI continuation (preserve origin)
     *      b. otherwise (outside grace OR no pending tokens) = human interaction (set cooldown)
     *
     * The key insight: once all correlator tokens are consumed (echoes matched),
     * any new state change is genuine human interaction even if still inside the
     * grace-period window. This prevents automation from overriding manual remote/button presses.
     *
     * @param {Object} data - Event data containing topic and message
     */
    handleMqttMessage(data) {
        let parsed
        try {
            parsed = JSON.parse(data.message)
        } catch {
            LoggerService.debug(`Malformed JSON payload: ${data.message}`, `${this.getLogPrefix()}:${this.#name}`)
            parsed = data.message
        }

        const isAiEcho = this.#correlator.matchEcho(parsed)

        if (isAiEcho) {
            // AI echo: update the state payload but preserve origin = 'automation'.
            // Do NOT update stateLastAt -- the timestamp was already set when the
            // AI command was sent (in receiveCommand).
            this.#stateLast = parsed
            this.setCachedState(parsed, {
                stateLastAt: this.#stateLastAt,
                origin: DeviceStateOrigin.AUTOMATION
            }).catch(err => {
                this.log(`Failed to cache state: ${err.message}`)
            })
        } else {
            const hadStateChange = this.#didStateChange(parsed)

            if (hadStateChange) {
                const withinGrace = Date.now() - this.#lastAiCommandAt < AI_GRACE_PERIOD_MS
                // Grace period only protects unmatched pending tokens. Once all correlator
                // tokens are consumed (echoes matched), any new state change is genuine human
                // interaction even if we're still inside the 90s window. This prevents the
                // automation from overriding manual remote/button presses during the echo tail.
                const hasPendingTokens = this.#correlator.hasPending()

                if (!withinGrace || (!hasPendingTokens && this.#stateOrigin !== DeviceStateOrigin.AUTOMATION)) {
                    // Outside grace period - genuine human interaction.
                    this.#stateOrigin = DeviceStateOrigin.HUMAN
                    LoggerService.debug(
                        `Origin -> human (${!withinGrace ? 'outside grace' : 'no pending tokens'}${!withinGrace && !hasPendingTokens ? ', outside grace + no pending tokens' : ''})`,
                        `${this.getLogPrefix()}:${this.#name}`
                    )
                    this.setCachedState(parsed, {
                        origin: DeviceStateOrigin.HUMAN
                    }).catch(err => {
                        this.log(`Failed to cache state: ${err.message}`)
                    })
                    try {
                        CacheService.setHumanCooldown(slugify(this.#name), HUMAN_INTERACTION_COOLDOWN_SECONDS).catch(() => {})
                    } catch (_) {}

                    this.#stateLast = parsed
                } else {
                    // Within grace period AND unmatched pending token exists - AI continuation.
                    LoggerService.debug(
                        `Origin preserved=${this.#stateOrigin} (grace period continuation with pending token)`,
                        `${this.getLogPrefix()}:${this.#name}`
                    )
                    this.#stateLast = parsed
                    this.setCachedState(parsed, {
                        stateLastAt: this.#stateLastAt,
                        origin: this.#stateOrigin
                    }).catch(err => {
                        this.log(`Failed to cache state: ${err.message}`)
                    })
                }
            } else {
                // Periodic report / no meaningful change -- just update cached payload
                // without touching origin. This prevents zigbee2mqtt's periodic
                // state advertisements from being misclassified as human input.
                this.#stateLast = parsed
                this.setCachedState(parsed, {
                    stateLastAt: this.#stateLastAt,
                    origin: this.#stateOrigin
                }).catch(err => {
                    this.log(`Failed to cache state: ${err.message}`)
                })
            }
        }

        const summary = this.#extractMessageSummary(data.message)
        if (summary.startsWith('Temperature:') || summary.startsWith('Illuminance:') || summary.startsWith('Humidity:')) {
            LoggerService.info(summary, `${this.getLogPrefix()}:${this.#name}`)
        } else {
            this.log(summary)
        }

        EventBus.publish(`zigbee:${this.#name}`)
    }

    /**
     * Receive a command from another device (e.g., a Remote) or from automation.
     * This is the unified interface for device-to-device communication
     * via DeviceContainer, replacing direct MQTT publishing.
     * Subclasses may override for custom behavior.
     *
     * The origin and correlator token are deferred until MqttService actually
     * publishes the message (via an onPublish callback). This eliminates the race
     * condition where a pending correlator token survives longer than the queue
     * latency window and misclassifies a human-initiated echo as our own AI command.
     *
     *   - fromAutomation === true   -> origin = 'automation' (called from Automation classes)
     *   - fromAutomation !== true   -> origin = 'human'      (called from Remote / human-triggered)
     *
     * Supports both simple string commands ("ON", "OFF", "OPEN", "CLOSE") and
     * structured JSON payloads ({position: 12}, {state: 'OPEN'}, etc.).
     *
     * Before publishing to zigbee2mqtt, the command is compared against the cached
     * device state. If the device is already in (or very close to) the requested
     * state, the MQTT publish is suppressed to avoid unnecessary traffic and
     * redundant physical actuation.
     *
     * @param {string|Object} command - Command to send. Either a state string
     *   ("ON", "OFF", "TOGGLE", "OPEN", "CLOSE", "STOP") or a payload object
     *   like {position: 12} or {state: 'OPEN'}.
     * @param {boolean} [fromAutomation=false] - True if called from automation, false for human-triggered.
     */
    receiveCommand(command, fromAutomation = false) {
        let finalPayload
        let description

        // Build payload -- no extra fields merged, just the command itself.
        if (typeof command === 'object' && command !== null) {
            finalPayload = { ...command }
            if ('state' in command) {
                description = command.state
            } else if ('position' in command) {
                description = `POS:${command.position}`
            } else {
                description = JSON.stringify(command)
            }
        } else {
            finalPayload = { state: command }
            description = String(command).toUpperCase()
        }

        LoggerService.info(`Received command: ${description}`, `${this.getLogPrefix()}:${this.#name}`)

        // --- Suppress redundant commands ---
        if (this.#isCommandRedundant(finalPayload, description)) {
            LoggerService.info(
                `Command "${description}" suppressed: device already at target state`,
                `${this.getLogPrefix()}:${this.#name}`
            )
            const origin = fromAutomation ? DeviceStateOrigin.AUTOMATION : DeviceStateOrigin.HUMAN
            this.#stateOrigin = origin
            this.#stateLastAt = new Date().toISOString()
            this.setCachedState(this.#stateLast, {
                stateLastAt: this.#stateLastAt,
                origin: origin
            }).catch(err => {
                this.log(`Failed to cache state: ${err.message}`)
            })
            return
        }

        if (!this.#mqttService) {
            this.log('MqttService not available')
            return
        }

        const prefix = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
        const topic = `${prefix}/${this.#name}/set`
        const self = this
        const isFromAutomation = fromAutomation

        // Activate grace period IMMEDIATELY so incoming MQTT echoes during the
        // queue latency window are protected even if the correlator hasn't been
        // registered yet or the echo's state label doesn't match exactly.
        if (isFromAutomation) {
            self.#lastAiCommandAt = Date.now()
        }

        // Defer correlator registration and origin assignment until the message
        // is actually published by MqttService. This prevents a stale pending token
        // from surviving past our queue delay and misclassifying human-initiated
        // echoes as automation commands (the root cause of the "automation fights me" bug).
        const _onPublish = () => {
            const now = new Date().toISOString()
            self.#stateLastAt = now

            if (isFromAutomation) {
                // Automation command - register correlator token so incoming MQTT
                // echoes can be matched and classified as automation rather than human input.
                self.#lastAiCommandAt = Date.now()
                self.#correlator.register(description, AI_ECHO_WINDOW_MS)
                self.#stateOrigin = DeviceStateOrigin.AUTOMATION
            } else {
                // Human-triggered command - do NOT register a correlator token.
                // Echo from zigbee2mqtt will be recognized as human input.
                self.#stateOrigin = DeviceStateOrigin.HUMAN
            }

            self.setCachedState(self.#stateLast, {
                stateLastAt: now,
                origin: self.#stateOrigin
            }).catch(err => {
                self.log(`Failed to cache state: ${err.message}`)
            })
        }

        this.#mqttService.publish(topic, JSON.stringify(finalPayload), { meta: { onPublish: _onPublish } })
        LoggerService.info(
            `Command "${description}" sent to topic ${topic}`,
            `${this.getLogPrefix()}:${this.#name}`
        )
    }

    // -- MQTT subscription management -------------------------------------

    /**
     * Set MQTT service for this device to use for subscriptions and publishing.
     * Triggers initial topic subscription if the broker is connected.
     *
     * @param {Object} mqttService - The MQTT service instance
     */
    setMqttService(mqttService) {
        this.#mqttService = mqttService
        this.#subscribeToTopics()
    }

    /**
     * Publish a message to an arbitrary MQTT topic.
     *
     * @protected
     * @param {string} topic - MQTT topic to publish to
     * @param {string} payload - Message payload (already stringified)
     */
    publish(topic, payload) {
        if (!this.#mqttService) {
            LoggerService.warn(`Cannot publish to "${topic}": MqttService not available`, `${this.getLogPrefix()}:${this.#name}`)
            return
        }
        this.#mqttService.publish(topic, payload)
    }

    /**
     * Return the list of MQTT topics this device should subscribe to.
     * Subclasses may override to add or change topics.
     *
     * Default: subscribes to <prefix>/<name> -- state updates reported by
     * zigbee2mqtt for this specific device. The /set topic is NOT included
     * since it carries our own outgoing command echoes.
     *
     * @param {string} prefix - MQTT topic prefix (e.g., "zigbee2mqtt")
     * @returns {string[]} Array of topic strings to subscribe to
     */
    getSubscribedTopics(prefix) {
        return [`${prefix}/${this.getName()}`]
    }

    /**
     * Idempotent re-subscription called after MQTT reconnect.
     * The Set-based guard prevents double-subscribing to already-active topics.
     */
    reconnect() {
        this.#subscribeToTopics()
    }

    /**
     * Clean up all MQTT subscriptions for this device.
     * Called during graceful shutdown to free broker resources.
     */
    cleanup() {
        for (const unsub of this.#subscriptions) {
            try {
                unsub()
            } catch (e) {
                this.error(`Error during subscription cleanup: ${e.message}`)
            }
        }
        this.#subscriptions = []
        this.#subscribedTopics.clear()
        LoggerService.debug('All subscriptions cleaned up', `${this.getLogPrefix()}:${this.#name}`)
    }

    // -- Private helpers --------------------------------------------------

    /**
     * Subscribe to all topics returned by getSubscribedTopics().
     * Uses a Set to prevent double-subscription on reconnect.
     * @private
     */
    #subscribeToTopics() {
        if (!this.#mqttService || !this.#mqttService.isConnected()) {
            LoggerService.debug('MQTT not ready yet, skipping subscription', `${this.getLogPrefix()}:${this.#name}`)
            return
        }

        const prefix = this.#mqttService.getPrefix()
        const topics = this.getSubscribedTopics(prefix)

        for (const topic of topics) {
            if (!this.#subscribedTopics.has(topic)) {
                const unsubscribe = this.#mqttService.subscribe(
                    topic,
                    (t, payload) => this.handleMqttMessage({ topic: t, message: payload })
                )
                if (unsubscribe) {
                    this.#subscriptions.push(unsubscribe)
                    this.#subscribedTopics.add(topic)
                    LoggerService.info(`Subscribed to "${topic}"`, `${this.getLogPrefix()}:${this.#name}`)
                }
            }
        }
    }

    /**
     * Detect whether an incoming MQTT payload represents a genuine state change
     * compared to the last known cached state.
     *
     * Compares only meaningful fields: state, position, temperature, illuminance, humidity.
     * If none of these changed meaningfully, it's treated as a periodic report rather than
     * a human interaction.
     *
     * @param {Object} newPayload - Parsed MQTT message payload
     * @returns {boolean} true if the payload represents a meaningful state change
     * @private
     */
    #didStateChange(newPayload) {
        if (typeof newPayload !== 'object' || newPayload === null) return true

        const old = this.#stateLast
        // Cold start or empty baseline: treat incoming data as calibration, not a
        // state change. Prevents zigbee2mqtt's initial calibration reports from being
        // misclassified as human interactions after a restart or Redis wipe.
        if (!old || typeof old !== 'object' || Object.keys(old).length === 0) {
            return false
        }

        // Compare state field (ON/OFF/OPEN/CLOSE/STOP)
        if ('state' in newPayload && 'state' in old) {
            if (String(newPayload.state) !== String(old.state)) return true
        } else if ('state' in newPayload || 'state' in old) {
            return true
        }

        // Compare position field with tolerance for roller shutters
        if ('position' in newPayload && 'position' in old) {
            const newPos = Number(newPayload.position)
            const oldPos = Number(old.position)
            if (!isNaN(newPos) && !isNaN(oldPos) && Math.abs(newPos - oldPos) > POSITION_MATCH_TOLERANCE) return true
        } else if ('position' in newPayload || 'position' in old) {
            return true
        }

        // Compare illuminance with threshold
        if ('illuminance' in newPayload && 'illuminance' in old) {
            const diff = Math.abs(Number(newPayload.illuminance) - Number(old.illuminance))
            if (diff > ILLUMINANCE_CHANGE_THRESHOLD) return true
        } else if ('illuminance' in newPayload || 'illuminance' in old) {
            return true
        }

        // Compare temperature with threshold
        if ('temperature' in newPayload && 'temperature' in old) {
            const diff = Math.abs(Number(newPayload.temperature) - Number(old.temperature))
            if (diff > TEMPERATURE_CHANGE_THRESHOLD) return true
        } else if ('temperature' in newPayload || 'temperature' in old) {
            return true
        }

        // Compare humidity with threshold
        if ('humidity' in newPayload && 'humidity' in old) {
            const diff = Math.abs(Number(newPayload.humidity) - Number(old.humidity))
            if (diff > HUMIDITY_CHANGE_THRESHOLD) return true
        } else if ('humidity' in newPayload || 'humidity' in old) {
            return true
        }

        return false
    }

    /**
     * Determine whether an outgoing command would be redundant given the cached state.
     *
     * Expands semantic commands into their expected state values and compares
     * against `#stateLast` with appropriate tolerances:
     *
     *   - `{state: 'ON'}`      -> suppressed if cached state === 'ON'
     *   - `{state: 'OFF'}`     -> suppressed if cached state === 'OFF'
     *   - `{state: 'OPEN'}`    -> suppressed if cached position >= 98
     *   - `{state: 'CLOSE'}`   -> suppressed if cached position <= 2
     *   - `{position: 12}`     -> suppressed if cached position within +2 of target
     *   - Plain strings like "ON", "OFF" are expanded to `{state: 'ON'}` etc.
     *
     * Commands that cannot be meaningfully compared (e.g., TOGGLE, STOP with no
     * cached state) are NEVER suppressed -- they always pass through.
     *
     * @param {Object} finalPayload - The resolved payload object ({state: ...} or {position: ...})
     * @param {string} description - Human-readable description (e.g., "POS:12", "OPEN")
     * @returns {boolean} true if the command is redundant and should be suppressed
     * @private
     */
    #isCommandRedundant(finalPayload, description) {
        const cached = this.#stateLast

        // No cached state -> we can't compare, so always send.
        if (!cached || typeof cached !== 'object' || Object.keys(cached).length === 0) {
            return false
        }

        const descUpper = String(description).toUpperCase()

        // --- Position-based commands ---
        if ('position' in finalPayload && typeof finalPayload.position === 'number') {
            const targetPos = finalPayload.position
            const cachedPos = cached.position

            if (typeof cachedPos === 'number' && !isNaN(cachedPos)) {
                return Math.abs(cachedPos - targetPos) <= POSITION_MATCH_TOLERANCE
            }
            return false
        }

        // --- State-based commands ---
        if ('state' in finalPayload) {
            const cmdState = String(finalPayload.state).toUpperCase()

            // TOGGLE has no deterministic target -- always send.
            if (cmdState === 'TOGGLE') return false

            // Direct state comparison for ON/OFF devices (lights, switches).
            if (cmdState === 'ON' || cmdState === 'OFF') {
                const cachedState = typeof cached.state === 'string' ? cached.state.toUpperCase() : null
                return cachedState === cmdState
            }

            // Roller shutter semantic commands: compare against cached position.
            const cachedPos = cached.position
            if (typeof cachedPos === 'number' && !isNaN(cachedPos)) {
                if (cmdState === 'OPEN' && cachedPos >= POSITION_NEARLY_OPEN_THRESHOLD) return true
                if (cmdState === 'CLOSE' && cachedPos <= POSITION_NEARLY_CLOSED_THRESHOLD) return true
            }

            // Fallback: when no reliable position data is available, use cached state field.
            // BUT when position IS available, it is authoritative -- do NOT trust state
            // for roller shutters because zigbee2mqtt may report state=OPEN while position=45.
            if ((cachedPos === undefined || typeof cachedPos !== 'number') && (cmdState === 'OPEN' || cmdState === 'CLOSE')) {
                const cachedState = typeof cached.state === 'string' ? cached.state.toUpperCase() : null
                if (cachedState && cachedState === cmdState) return true
            }
        }

        return false
    }

    /**
     * Extract a meaningful summary from a JSON payload.
     * Prioritizes the "state" field (ON/OFF/etc.), falls back to a truncated raw payload.
     *
     * @param {string} message - Raw message string
     * @returns {string} Human-readable summary
     * @private
     */
    #extractMessageSummary(message) {
        try {
            const parsed = JSON.parse(message)
            if (parsed && typeof parsed === 'object') {
                if ('illuminance' in parsed) {
                    return `Illuminance: ${parsed.illuminance}`
                }
                if ('temperature' in parsed) {
                    let summary = `Temperature: ${parsed.temperature}`
                    if ('humidity' in parsed) {
                        summary += `, Humidity: ${parsed.humidity}`
                    }
                    return summary
                }
                if ('state' in parsed) {
                    return `State: ${parsed.state}`
                }
                if ('action' in parsed) {
                    return `Action: ${parsed.action}`
                }
                const truncated = JSON.stringify(parsed)
                return truncated.length > SUMMARY_TRUNCATE_LENGTH ? truncated.substring(0, SUMMARY_TRUNCATE_LENGTH) + '...' : truncated
            }
        } catch {
            return message.length > SUMMARY_TRUNCATE_LENGTH ? message.substring(0, SUMMARY_TRUNCATE_LENGTH) + '...' : message
        }
        return String(message)
    }

    // -- Logging helpers --------------------------------------------------

    /**
     * Return the label used in log prefixes.
     * Subclasses override to return their type name (e.g. "Sensor", "Mechanism", "Remote").
     * Defaults to "Device" for unknown or generic types.
     * @returns {string} Log prefix label
     */
    getLogPrefix() {
        return 'Device'
    }

    /**
     * Unified logging helper with device prefix. Default level is debug.
     * Subclasses (e.g. Sensor) may override this method to use info level.
     *
     * @param {string} message - Message to log
     */
    log(message) {
        LoggerService.debug(message, `${this.getLogPrefix()}:${this.#name}`)
    }

    /**
     * Log a warning message with device prefix.
     *
     * @param {string} message - Message to log
     */
    warn(message) {
        LoggerService.warn(message, `${this.getLogPrefix()}:${this.#name}`)
    }

    /**
     * Log an error message with device prefix.
     *
     * @param {string} message - Message to log
     */
    error(message) {
        LoggerService.error(message, `${this.getLogPrefix()}:${this.#name}`)
    }
}