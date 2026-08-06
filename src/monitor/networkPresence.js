/**
 * Network presence detection automation.
 *  Singleton that monitors network devices using arping and publishes
 *  presence transitions via EventBus so automations can react immediately.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import CacheService from '../service/cacheService.js'
import ConfigService from '../service/configService.js'
import LoggerService from '../service/loggerService.js'
import EventBus from '../service/eventBus.js'

/**
 * Interval between presence checks in milliseconds (5 seconds).
 * @type {number}
 */
const CHECK_INTERVAL_MS = 5_000

/**
 * Hard timeout for a single arping command in milliseconds.
 * @type {number}
 */
const ARPING_TIMEOUT_MS = 5_000

/**
 * TTL for cached presence state in seconds.
 * @type {number}
 */
const CACHE_TTL_SECONDS = 60

/**
 * Arping count flag -- send exactly one packet.
 * @type {string}
 */
const ARPING_COUNT = '-c 1'

/**
 * Arping wait timeout flag -- 3 second wait.
 * @type {string}
 */
const ARPING_WAIT = '-w 3'

/**
 * Cache value representing an online device.
 * @type {number}
 */
const STATE_ONLINE = 1

/**
 * Cache value representing an offline device.
 * @type {number}
 */
const STATE_OFFLINE = 0

// ---------------------------------------------------------------------------
// SNetworkPresence (singleton)
// ---------------------------------------------------------------------------

/**
 * Monitors network devices for presence using double arping.
 *
 * Reads device definitions from a YAML config, periodically pings each IP,
 * stores the result in Redis with a short TTL, and fires EventBus events
 * only on state transitions (online <-> offline).
 *
 * @see {@link https://linux.die.net/man/8/arping}
 */
class SNetworkPresence {

    instance

    /**
     * Parsed network configuration object.
     * @type {Object}
     */
    #config = {}

    /**
     * Interval timer handle for periodic checks.
     * @type {NodeJS.Timer|null}
     */
    #timer = null

    // -- Singleton --------------------------------------------------------

    /**
     * Synchronous singleton constructor.
     *
     * @return {this}
     */
    constructor() {
        if (!SNetworkPresence.instance) SNetworkPresence.instance = this
        return SNetworkPresence.instance
    }

    // -- Lifecycle --------------------------------------------------------

    /**
     * Initialize the network presence monitoring.
     *  Reads configuration and starts the monitoring timer.
     *
     * @async
     */
    async init() {
        try {
            const networkConfig = ConfigService.section('network')
            if (!networkConfig) {
                LoggerService.warn(
                    'Network configuration section not available (network.yaml not loaded)',
                    'NetworkPresence'
                )
                return
            }

            this.#config = networkConfig.toJSON()

            this.#timer = setInterval(() => {
                void this.#checkDevices().catch(err => {
                    LoggerService.error(`Device check cycle failed: ${err.message}`, 'NetworkPresence')
                })
            }, CHECK_INTERVAL_MS)

            LoggerService.info('Network presence monitoring started', 'NetworkPresence')
        } catch (error) {
            LoggerService.error(`Failed to initialize network presence monitoring: ${error.message}`, 'NetworkPresence')
        }
    }

    /**
     * Stop the network presence monitoring.
     */
    stop() {
        if (this.#timer) {
            clearInterval(this.#timer)
            this.#timer = null
        }
        LoggerService.info('Network presence monitoring stopped', 'NetworkPresence')
    }

    // -- Public API -------------------------------------------------------

    /**
     * Get current device presence state from cache.
     *
     * @param {string} category - Category of the device
     * @param {string} deviceName - Name of the device
     * @returns {Promise<number|null>} 1 if present, 0 if not present, null if not found
     */
    async getDeviceState(category, deviceName) {
        const cacheKey = `network:${category}:${deviceName}`
        const state = await CacheService.get(cacheKey)
        return state ?? null
    }

    /**
     * Check if a device is online by its name (defaults to 'computers' category).
     * This serves as the primary "by name" getter for boolean presence.
     *
     * @param {string} name - Name of the device
     * @param {string} [category='computers'] - Category of the device
     * @returns {Promise<boolean>} true if online, false otherwise
     */
    async isOnline(name, category = 'computers') {
        const state = await this.getDeviceState(category, name)
        return state === STATE_ONLINE
    }

    /**
     * Get raw presence state by name from cache (defaults to 'computers' category).
     * Returns numerical state: 1 (online), 0 (offline), or null (unknown).
     *
     * @param {string} name - Name of the device
     * @param {string} [category='computers'] - Category of the device
     * @returns {Promise<number|null>} 1 if present, 0 if not present, null if not found
     */
    async getStateByName(name, category = 'computers') {
        return this.getDeviceState(category, name)
    }

    // -- Private helpers --------------------------------------------------

    /**
     * Check all devices in the configuration for presence.
     * Iterates through categories and dispatches each IP check.
     *
     * @private
     */
    async #checkDevices() {
        try {
            for (const [category, devices] of Object.entries(this.#config)) {
                if (typeof devices !== 'object' || devices === null) continue
                if (Array.isArray(devices)) continue

                for (const [deviceName, ipAddress] of Object.entries(devices)) {
                    if (typeof ipAddress === 'string' && ipAddress.trim() !== '') {
                        await this.#checkDevice(category, deviceName, ipAddress)
                    }
                }
            }
        } catch (error) {
            LoggerService.error(`Error during device check: ${error.message}`, 'NetworkPresence')
        }
    }

    /**
     * Check a single device for presence using arping.
     * Only logs and publishes when the presence state changes.
     *
     * Uses double arping to reduce false negatives caused by ARP cache
     * suppression or rate-limited responses from modern OS stacks.
     *
     * @param {string} category - Category of the device (e.g., computers, routers)
     * @param {string} deviceName - Name of the device
     * @param {string} ipAddress - IP address of the device
     * @private
     */
    async #checkDevice(category, deviceName, ipAddress) {
        const cacheKey = `network:${category}:${deviceName}`
        const oldState = await CacheService.get(cacheKey)

        try {
            // First arping attempt -- may fail due to ARP cache suppression.
            await execPromise(`arping ${ARPING_COUNT} ${ARPING_WAIT} ${ipAddress}`, { timeout: ARPING_TIMEOUT_MS })
            await this.#markDevice(cacheKey, deviceName, ipAddress, STATE_ONLINE, oldState)
        } catch {
            // Retry once -- second chance for devices that dropped the first packet.
            try {
                await execPromise(`arping ${ARPING_COUNT} ${ARPING_WAIT} ${ipAddress}`, { timeout: ARPING_TIMEOUT_MS })
                await this.#markDevice(cacheKey, deviceName, ipAddress, STATE_ONLINE, oldState)
            } catch {
                // Device did not respond after two attempts.
                await this.#markDevice(cacheKey, deviceName, ipAddress, STATE_OFFLINE, oldState)
            }
        }
    }

    /**
     * Mark a device as online/offline in cache and publish transition event if changed.
     *
     * @param {string} cacheKey - Redis cache key
     * @param {string} deviceName - Human-readable device name
     * @param {string} ipAddress - IP address of the device
     * @param {number} newState - {@link STATE_ONLINE} or {@link STATE_OFFLINE}
     * @param {number|undefined} oldState - Previously cached state
     * @private
     */
    async #markDevice(cacheKey, deviceName, ipAddress, newState, oldState) {
        await CacheService.set(cacheKey, newState, CACHE_TTL_SECONDS)

        if (oldState !== newState) {
            const statusLabel = newState === STATE_ONLINE ? 'is online' : 'went offline'
            LoggerService.info(
                `Device ${deviceName} (${ipAddress}) ${statusLabel}`,
                'NetworkPresence'
            )
            EventBus.publish(`network:${deviceName}`)
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Promise-based wrapper around child_process.exec for arping commands.
 * @type {Function}
 */
const execPromise = promisify(exec)

// Singletonize and export to Node.js.
const NetworkPresence = new SNetworkPresence()
Object.freeze(NetworkPresence)
export default NetworkPresence