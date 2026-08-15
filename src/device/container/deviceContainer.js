/**
 * Device container (singleton).
 *  Device repository and autoloader -- Bridge-first discovery.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'

import { parseDocument as yamlParseDocument } from 'yaml'
import { slugify } from '../../lib/string.js'
import DummyDevice from '../type/dummy.js'
import Bridge from '../type/bridge.js'
import MqttService from '../../service/mqttService.js'
import EventBus from '../../service/eventBus.js'
import Autoloader from '../../lib/autoloader.js'
import LoggerService from '../../service/loggerService.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path to the device type implementations directory.
 * @type {string}
 */
const TYPE_DIR = './src/device/type'

/**
 * Path to the Zigbee device configuration file.
 * Maps friendly names to semantic type categories.
 * @type {string}
 */
const DEVICES_CONFIG_PATH = './etc/device/zigbee.yaml'

/**
 * Timeout in milliseconds for waiting the device list from the Zigbee2MQTT bridge.
 * @type {number}
 */
const BRIDGE_DEVICE_LIST_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// SDeviceContainer (singleton)
// ---------------------------------------------------------------------------

/**
 * Device repository and autoloader.
 *
 * Discovers Zigbee devices through the Bridge, resolves their type class
 * (instance override -> config category -> DummyDevice fallback), instantiates
 * them, wires MQTT communication, and initializes cached state.
 */
class SDeviceContainer {

    instance

    #devices = {}
    #typeModules = {}
    #typeModulesByCategory = {}
    #deviceTypeMap = {}

    // -- Singleton ----------------------------------------------------

    /**
     * Synchronous singleton constructor.
     *
     * @return {this}
     */
    constructor() {
        if (!SDeviceContainer.instance) SDeviceContainer.instance = this
        return SDeviceContainer.instance
    }

    // -- Lifecycle ----------------------------------------------------

    /**
     * Initialize the container: load types, create Bridge, discover devices,
     * instantiate them, wire MQTT, and initialize cached state.
     *
     * @async
     */
    async init() {
        // 1. Load available device type implementations
        await this.#loadTypeModules()

        // 2. Load device type mappings from config (our semantic categories)
        this.#loadDeviceTypeConfig()

        // 3. Create Bridge first -- it is the source of truth for device list
        const bridge = new Bridge('bridge', 'bridge', { friendly_name: 'bridge' })
        this.#devices['bridge'] = bridge

        // Wire MQTT into Bridge so it can subscribe & receive messages
        bridge.setMqttService(MqttService)

        // 4. Request device list from zigbee2mqtt bridge
        bridge.requestDeviceList()

        // 5. Wait for bridge to receive and parse the device list
        LoggerService.info('Waiting for device list from Zigbee2MQTT bridge...', 'DeviceContainer')
        let deviceList
        try {
            deviceList = await bridge.waitForDeviceList(BRIDGE_DEVICE_LIST_TIMEOUT_MS)
            LoggerService.info(`Bridge responded with ${deviceList.length} device(s)`, 'DeviceContainer')
        } catch (err) {
            LoggerService.error(`Failed to get device list from bridge: ${err.message}`, 'DeviceContainer')
            throw err
        }

        // Filter out the bridge itself (ieee_address starts with "0x00124b..." or type === "Coordinator").
        // The coordinator/bridge entry should not be instantiated as a regular device.
        const z2mDevices = deviceList.filter(d => d.type !== 'Coordinator')

        // 6. Instantiate devices from Bridge's response
        this.#devices = { ...this.#instantiateFromBridge(z2mDevices) }
        // Re-add bridge back (it was removed during instantiation since it's not in z2mDevices,
        // but we keep it explicitly).
        this.#devices['bridge'] = bridge

        LoggerService.info(`${Object.keys(this.#devices).length} devices instantiated`, 'DeviceContainer')

        // 7. Wire up MQTT communication for all devices
        this.#setupDeviceCommunication()

        // 8. Initialize each device (load state from Redis, etc.)
        await this.#initDevices()

        // Notify listeners that all devices are ready (used by DeviceWindow to subscribe)
        EventBus.emit('devices:ready')
    }

    // -- Type resolution ----------------------------------------------

    /**
     * Pre-load all device type modules from the type directory.
     *
     * @async
     * @private
     */
    async #loadTypeModules() {
        try {
            const autoloader = new Autoloader()
            const typeModules = await autoloader.preloadPath(TYPE_DIR)

            // Store type modules by category key (mechanism, sensor, remote, etc.)
            this.#typeModulesByCategory = typeModules
            // Keep merged map for backward compatibility
            this.#typeModules = { ...typeModules }
            LoggerService.info(`${Object.keys(typeModules).length} type(s) loaded`, 'DeviceContainer')
        } catch (error) {
            LoggerService.error(`Error loading device types: ${error}`, 'DeviceContainer')
        }
    }

    /**
     * Load device type mappings from etc/device/zigbee.yaml.
     * Builds an inverted map: friendly_name -> type category (mechanism, sensor, remote, etc.)
     *
     * @private
     */
    #loadDeviceTypeConfig() {
        if (!fs.existsSync(DEVICES_CONFIG_PATH)) {
            LoggerService.warn(`Device config not found: ${DEVICES_CONFIG_PATH}`, 'DeviceContainer')
            return
        }

        try {
            const config = yamlParseDocument(
                fs.readFileSync(DEVICES_CONFIG_PATH, 'utf8')
            ).contents?.toJSON()

            if (!config) {
                LoggerService.warn('Device config is empty', 'DeviceContainer')
                return
            }

            // Build inverted map: friendly_name -> type category
            for (const [typeCategory, names] of Object.entries(config)) {
                if (Array.isArray(names)) {
                    for (const friendlyName of names) {
                        this.#deviceTypeMap[friendlyName] = typeCategory
                    }
                }
            }

            LoggerService.info(
                `${Object.keys(this.#deviceTypeMap).length} device type mappings loaded from config`,
                'DeviceContainer'
            )
        } catch (error) {
            LoggerService.error(`Error loading device config: ${error}`, 'DeviceContainer')
        }
    }

    /**
     * Resolve the appropriate class for a device by its friendly name.
     * Resolution order:
     *   1. Type category from devices/zigbee.yaml config (mechanism, sensor, remote, etc.)
     *   2. DummyDevice (fallback with warning)
     *
     * @param {string} name - Device friendly name
     * @returns {Class} Device class
     * @private
     */
    #resolveDeviceType(name) {
        // Try type category mapping from devices.yml config
        const typeCategory = this.#deviceTypeMap[name]

        if (typeCategory) {
            const typeModule = this.#typeModulesByCategory[typeCategory]

            if (typeModule) {
                LoggerService.debug(`Resolved "${name}" -> type:${typeCategory}`, 'DeviceContainer')
                return typeModule.default || typeModule
            }
        }

        // Fallback to DummyDevice with warning
        const slugifiedName = slugify(name)
        LoggerService.warn(
            `No type found for "${name}" (slug: "${slugifiedName}") - using DummyDevice`,
            'DeviceContainer'
        )

        return DummyDevice
    }

    // -- Device instantiation -----------------------------------------

    /**
     * Create Device instances from Bridge's device list response.
     * Each entry has: ieee_address, friendly_name, type, supported, etc.
     *
     * @param {Array} deviceList - Array of device objects from zigbee2mqtt bridge
     * @returns {Object} Map of device name -> Device instance
     * @private
     */
    #instantiateFromBridge(deviceList) {
        const devices = {}

        for (const definition of deviceList) {
            const name = definition.friendly_name
            const deviceId = definition.ieee_address

            // Skip unsupported devices
            if (!definition.supported) {
                LoggerService.warn(`Skipping unsupported device: ${name} (${deviceId})`, 'DeviceContainer')
                continue
            }

            const DeviceClass = this.#resolveDeviceType(name)
            const deviceData = { ...definition, id: deviceId }

            devices[name] = new DeviceClass(name, deviceId, deviceData)
        }

        return devices
    }

    // -- Communication setup ------------------------------------------

    /**
     * Wire MQTT service into every device, then register reconnect handler.
     *
     * @private
     */
    #setupDeviceCommunication() {
        for (const device of Object.values(this.#devices)) {
            device.setMqttService(MqttService)
        }
        // Register reconnect callback so devices re-subscribe idempotently after broker reconnects.
        MqttService.onReconnect(() => this.reconnectAll())
    }

    /**
     * Wire MQTT into a single device (for dynamic runtime addition).
     *
     * @param {Device} device - Device instance to wire
     * @private
     */
    #wireDeviceMqtt(device) {
        device.setMqttService(MqttService)
    }

    // -- Device initialization ----------------------------------------

    /**
     * Call async init on each device so they can load cached state from Redis.
     *
     * @async
     * @private
     */
    async #initDevices() {
        const inits = Object.values(this.#devices).map(async (device) => {
            try {
                await device.init()
            } catch (err) {
                LoggerService.error(`Failed to init device "${device.getName()}": ${err.message}`, 'DeviceContainer')
            }
        })
        await Promise.all(inits)
    }

    // -- Public API ---------------------------------------------------

    /**
     * Find a device by its friendly name.
     *
     * @param {string} name - Device friendly name
     * @returns {Device|null}
     */
    findByName(name) {
        return this.#devices[name] ?? null
    }

    /**
     * Find a device by its internal ID.
     *
     * @param {string} id - Device IEEE address or internal identifier
     * @returns {Device|null}
     */
    findByID(id) {
        return Object.values(this.#devices).find(d => d.getId() === id) ?? null
    }

    /**
     * Trigger an event on a device.
     *
     * @param {string} deviceName - Device friendly name
     * @param {string} eventType - Event type to emit
     * @param {Object} [data={}] - Payload to attach to the event
     * @returns {boolean} True if device was found and event emitted
     */
    triggerEvent(deviceName, eventType, data = {}) {
        const device = this.findByName(deviceName)
        if (device) {
            device.emit(eventType, data)
            return true
        }
        return false
    }

    /**
     * Send a command from one device to another.
     *
     * @param {string} fromDeviceName - Source device friendly name
     * @param {string} toDeviceName - Target device friendly name
     * @param {string} command - Command identifier
     * @param {Object} [data={}] - Command payload
     * @returns {boolean} True if both devices exist and command was sent
     */
    sendCommand(fromDeviceName, toDeviceName, command, data = {}) {
        const fromDevice = this.findByName(fromDeviceName)
        const toDevice = this.findByName(toDeviceName)

        if (fromDevice && toDevice) {
            toDevice.emit('command', { from: fromDeviceName, command, data })
            return true
        }
        return false
    }

    /**
     * Get all registered devices.
     *
     * @param {{includeBridge?: boolean}} [options={}] - Filtering options.
     * @param {boolean} [options.includeBridge=true] - When false, omit the Zigbee2MQTT bridge/coordinator entry.
     * @returns {Object} Map of device name -> Device instance
     */
    getAll({ includeBridge = true } = {}) {
        if (includeBridge) return this.#devices
        const result = {}
        for (const [name, device] of Object.entries(this.#devices)) {
            if (device instanceof Bridge) continue
            result[name] = device
        }
        return result
    }

    // -- Dynamic device management ------------------------------------

    /**
     * Add a new device at runtime (triggered by Bridge on device_announce).
     * Resolves type, creates instance, wires MQTT, and initializes it.
     *
     * @param {string} friendlyName - Device friendly name
     * @param {string} ieeeAddr - IEEE address (device ID)
     * @param {Object} [data={}] - Additional device data
     * @returns {Device|null} The created device or null if already exists
     */
    addDevice(friendlyName, ieeeAddr, data = {}) {
        // Already registered? Skip.
        if (this.#devices[friendlyName]) {
            LoggerService.info(`Device "${friendlyName}" already registered, skipping`, 'DeviceContainer')
            return null
        }

        const DeviceClass = this.#resolveDeviceType(friendlyName)
        const deviceData = { ...data, id: ieeeAddr, ieee_address: ieeeAddr, friendly_name: friendlyName }
        const device = new DeviceClass(friendlyName, ieeeAddr, deviceData)

        this.#wireDeviceMqtt(device)

        // Init asynchronously (don't await -- fire-and-forget for dynamic adds).
        device.init().catch(err => {
            LoggerService.error(`Failed to init dynamically added device "${friendlyName}": ${err.message}`, 'DeviceContainer')
        })

        this.#devices[friendlyName] = device
        LoggerService.info(`Dynamically added device: ${friendlyName} (${ieeeAddr})`, 'DeviceContainer')

        // Notify listeners so UI can re-subscribe to the new device's channels
        EventBus.emit('devices:ready', friendlyName)
        return device
    }

    /**
     * Remove a device at runtime (triggered by Bridge on device_leave).
     * Cleans up subscriptions and removes from registry.
     *
     * @param {string} friendlyName - Device friendly name
     * @returns {boolean} True if device was removed
     */
    removeDevice(friendlyName) {
        const device = this.#devices[friendlyName]
        if (!device) {
            LoggerService.warn(`Cannot remove unknown device: ${friendlyName}`, 'DeviceContainer')
            return false
        }

        try {
            device.cleanup?.()
        } catch (err) {
            LoggerService.error(`Error cleaning up "${friendlyName}" during removal: ${err.message}`, 'DeviceContainer')
        }

        delete this.#devices[friendlyName]
        LoggerService.info(`Removed device: ${friendlyName}`, 'DeviceContainer')
        return true
    }

    // -- Lifecycle helpers --------------------------------------------

    /**
     * Clean up all device MQTT subscriptions during graceful shutdown.
     * Called from main.js before MqttService.disconnect().
     */
    cleanupDevices() {
        LoggerService.info('Cleaning up device subscriptions...', 'DeviceContainer')
        const cleanups = Object.values(this.#devices).map((device) => {
            try {
                device.cleanup?.()
            } catch (err) {
                LoggerService.error(`Error cleaning up "${device.getName()}": ${err.message}`, 'DeviceContainer')
            }
        })
        return Promise.all(cleanups)
    }

    /**
     * Trigger idempotent re-subscription on all devices after MQTT reconnect.
     */
    reconnectAll() {
        for (const device of Object.values(this.#devices)) {
            try {
                device.reconnect?.()
            } catch (err) {
                LoggerService.error(`Reconnect failed for "${device.getName()}": ${err.message}`, 'DeviceContainer')
            }
        }
        LoggerService.info('All devices reconnected', 'DeviceContainer')
    }
}

// Singletonize and export to Node.js.
const DeviceContainer = new SDeviceContainer()
Object.freeze(DeviceContainer)
export default DeviceContainer