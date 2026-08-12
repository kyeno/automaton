/**
 * Bridge device type.
 *  Handles Zigbee2MQTT bridge topics (logging, health, state, events, devices).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import process from 'node:process'
import DeviceBase from '../base/deviceBase.js'
import CacheService from '../../service/cacheService.js'
import DeviceContainer from '../container/deviceContainer.js'
import LoggerService from '../../service/loggerService.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default timeout in milliseconds for waiting the device list response.
 * @type {number}
 */
const DEFAULT_DEVICE_LIST_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Bridge class
// ---------------------------------------------------------------------------

/**
 * Bridge class.
 *  Extends DeviceBase with bridge-specific message handling.
 */
export default class Bridge extends DeviceBase {

    // -- Private state ----------------------------------------------------

    /**
     * Cached device list received from zigbee2mqtt/bridge/devices.
     * @type {Array|null}
     */
    #deviceList = null

    /**
     * Promise that resolves once the device list is populated.
     * Used by DeviceContainer to wait for bridge discovery before bootstrapping devices.
     * @type {Promise<Array>|null}
     */
    #deviceListReady = null

    /**
     * Resolve function for #deviceListReady promise.
     * @type {Function|null}
     */
    #deviceListResolve = null

    // -- Constructor ------------------------------------------------------

    /**
     * Create Bridge object.
     *
     * @constructor
     * @param {string} name - Device name
     * @param {string} id - Device ID
     * @param {Object} data - Device data
     */
    constructor(name, id, data) {
        super(name, id, data)
    }

    // -- Topic subscription override --------------------------------------

    /**
     * Override: subscribe to all bridge sub-topics via MQTT wildcard.
     *
     *   zigbee2mqtt/bridge/#   --  catches /devices, /event, /health, /state, etc.
     *   zigbee2mqtt/bridge/+   --  single-level fallback (redundant but safe)
     *
     * The wildcard "#" matches any number of levels, so a single subscription
     * covers every bridge topic we care about.
     *
     * @param {string} prefix - MQTT topic prefix (e.g., "zigbee2mqtt")
     * @returns {string[]} Array of topic strings to subscribe to
     */
    getSubscribedTopics(prefix) {
        return [`${prefix}/bridge/#`]
    }

    // -- Public API for device discovery -----------------------------------

    /**
     * Request the full device list from zigbee2mqtt bridge.
     * Publishes `{ "get": "devices" }` to the request topic.
     */
    requestDeviceList() {
        const prefix = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
        const topic = `${prefix}/bridge/request/devices/set`
        this.publish(topic, JSON.stringify({ get: 'devices' }))
        this.info(`Requested device list via ${topic}`)
    }

    /**
     * Get the cached device list (populated when bridge publishes on /devices).
     * @returns {Array|null} Device array or null if not yet received.
     */
    getDevices() {
        return this.#deviceList
    }

    /**
     * Wait for the device list to be populated by the bridge response.
     * Returns a Promise that resolves with the device array once received.
     *
     * @param {number} [timeoutMs=10000] - Maximum wait time in milliseconds
     * @returns {Promise<Array>} Resolved device list
     */
    waitForDeviceList(timeoutMs = DEFAULT_DEVICE_LIST_TIMEOUT_MS) {
        // Already have it? Return immediately.
        if (this.#deviceList !== null) {
            return Promise.resolve(this.#deviceList)
        }

        // Reuse existing promise if one is already pending.
        if (!this.#deviceListReady) {
            this.#deviceListReady = new Promise((resolve) => {
                this.#deviceListResolve = resolve
            })
        }

        // Set up a timeout guard.
        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Bridge device list request timed out after ' + timeoutMs + 'ms')), timeoutMs)
        })

        return Promise.race([this.#deviceListReady, timeout])
    }

    // -- Private helpers --------------------------------------------------

    /**
     * Resolve the #deviceListReady promise with the current device list.
     * Called internally when /devices message arrives.
     *
     * @private
     */
    #notifyDeviceListReady() {
        if (this.#deviceListResolve && this.#deviceList !== null) {
            this.#deviceListResolve(this.#deviceList)
            this.#deviceListResolve = null
            this.#deviceListReady = null
        }
    }

    /**
     * Extract the bridge sub-path from a topic.
     *  e.g. "zigbee2mqtt/bridge/logging" -> "logging"
     *       "zigbee2mqtt/bridge/devices" -> "devices"
     *
     * @param {string} topic - Full MQTT topic
     * @returns {string|null} Bridge sub-path or null
     * @private
     */
    #extractBridgePath(topic) {
        const parts = topic.split('/')
        return parts.length >= 3 ? parts[2] : null
    }

    // -- Overrides --------------------------------------------------------

    /**
     * Override default MQTT message handling to route bridge sub-topics.
     *
     * @param {Object} data - Event data containing topic and message
     */
    handleMqttMessage(data) {
        const bridgePath = this.#extractBridgePath(data.topic)
        if (!bridgePath) {
            this.log(`Unknown bridge topic: ${data.topic}`)
            return
        }

        switch (bridgePath) {
            case 'logging':
                // Bridge logging is just Zigbee2MQTT echoing published messages.
                break
            case 'health':
                this.#handleBridgeHealth(data.message)
                break
            case 'state':
                this.#handleBridgeState(data.message)
                break
            case 'event':
                this.#handleBridgeEvent(data.message)
                break
            case 'devices':
                this.#handleDeviceList(data.message)
                break
            case 'extensions':
            case 'converters':
            case 'info':
            case 'groups':
            case 'definitions':
                this.log(`Bridge ${bridgePath} topic received - ignoring`)
                break
            default:
                this.log(`Unhandled bridge sub-topic: ${bridgePath}`)
                this.log(`  Message: ${data.message}`)
                break
        }
    }

    // -- Bridge sub-topic handlers ----------------------------------------

    /**
     * Handle zigbee2mqtt/bridge/health messages.
     * Stores the health payload directly in Redis under the "zigbee_health" key.
     *
     * @param {string} message - Raw JSON health message
     * @private
     */
    async #handleBridgeHealth(message) {
        try {
            const health = JSON.parse(message)
            await CacheService.set('zigbee_health', health)
            this.info('Bridge health stored in Redis')
        } catch (e) {
            this.log(`Failed to parse bridge/health message: ${e.message}`)
        }
    }

    /**
     * Handle zigbee2mqtt/bridge/state messages.
     * If the payload is not {"state":"online"}, the bridge is considered offline
     * and the process terminates gracefully.
     *
     * @param {string} message - Raw JSON state message
     * @private
     */
    #handleBridgeState(message) {
        try {
            const parsed = JSON.parse(message)
            if (parsed?.state !== 'online') {
                LoggerService.error('Zigbee2MQTT bridge is offline', 'Bridge')
                process.kill(process.pid, 'SIGTERM')
            }
            this.info('Zigbee2MQTT bridge is online')
        } catch (e) {
            this.log(`Failed to parse bridge/state message: ${e.message}`)
        }
    }

    /**
     * Handle zigbee2mqtt/bridge/event messages.
     * Processes bridge events such as device_announce, device_remove, etc.
     *
     * @param {string} message - Raw JSON event message
     * @private
     */
    #handleBridgeEvent(message) {
        try {
            const parsed = JSON.parse(message)
            const eventType = parsed?.type
            const eventData = parsed?.data

            switch (eventType) {
                case 'device_announce':
                    this.#handleDeviceAnnounce(eventData)
                    break
                case 'device_leave':
                    this.#handleDeviceLeave(eventData)
                    break
                default:
                    this.log(`Bridge event "${eventType}" received - ignoring`)
                    break
            }
        } catch (e) {
            this.log(`Failed to parse bridge/event message: ${e.message}`)
        }
    }

    /**
     * Handle zigbee2mqtt/bridge/devices  --  the full device list response.
     * Parses the array of devices and stores it internally. Notifies any
     * waiters (DeviceContainer during init) that the list is ready.
     *
     * @param {string} message - Raw JSON device list (array)
     * @private
     */
    #handleDeviceList(message) {
        try {
            const devices = JSON.parse(message)
            if (!Array.isArray(devices)) {
                this.log('Unexpected /devices payload format (expected array)')
                return
            }
            this.#deviceList = devices
            this.info(`Received device list: ${devices.length} device(s)`)
            this.#notifyDeviceListReady()
        } catch (e) {
            this.log(`Failed to parse bridge/devices message: ${e.message}`)
        }
    }

    /**
     * Handle device_announce events.
     * Logs when a previously unknown Zigbee device attempts to join the network.
     * Triggers dynamic device addition via DeviceContainer.
     *
     * @param {Object} data - Event data with friendly_name and ieee_address
     * @private
     */
    #handleDeviceAnnounce(data) {
        const friendlyName = data?.friendly_name
        const ieeeAddress = data?.ieee_address

        if (friendlyName) {
            const existing = DeviceContainer.findByName(friendlyName)
            if (existing) {
                this.info(`Device announced: ${friendlyName} (${ieeeAddress}) - already registered`)
            } else {
                // Dynamic discovery  --  add the device at runtime.
                this.info(`New device detected: ${friendlyName} (${ieeeAddress})  --  adding dynamically`)
                try {
                    DeviceContainer.addDevice(friendlyName, ieeeAddress || `0x${Date.now().toString(16)}`, {})
                } catch (err) {
                    LoggerService.error(`Dynamic add failed for "${friendlyName}": ${err.message}`, 'Bridge')
                }
            }
        } else {
            this.log(`Device announced: ${ieeeAddress}`)
        }
    }

    /**
     * Handle device_leave events.
     * Logs when a device leaves the Zigbee network and removes it from the container.
     *
     * @param {Object} data - Event data with friendly_name and ieee_address
     * @private
     */
    #handleDeviceLeave(data) {
        const friendlyName = data?.friendly_name
        const ieeeAddress = data?.ieee_address

        if (friendlyName) {
            this.warn(`Device left network: ${friendlyName} (${ieeeAddress})`)
            try {
                DeviceContainer.removeDevice(friendlyName)
            } catch (err) {
                LoggerService.error(`Dynamic remove failed for "${friendlyName}": ${err.message}`, 'Bridge')
            }
        } else {
            this.warn(`Device left network: ${ieeeAddress}`)
        }
    }

    // -- Logging helpers --------------------------------------------------

    /**
     * Log a warning-level message with uppercase BRIDGE context.
     *
     * @param {string} message - Message to log
     */
    warn(message) {
        LoggerService.warn(message, `${this.getLogPrefix()}:${this.getName().toUpperCase()}`)
    }

    /**
     * Override logging to use uppercase "BRIDGE" in log context.
     *
     * @param {string} message - Message to log
     */
    log(message) {
        LoggerService.debug(message, `${this.getLogPrefix()}:${this.getName().toUpperCase()}`)
    }

    /**
     * Log an info-level message with uppercase BRIDGE context.
     *
     * @param {string} message - Message to log
     */
    info(message) {
        LoggerService.info(message, `${this.getLogPrefix()}:${this.getName().toUpperCase()}`)
    }
}