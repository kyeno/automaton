/**
 * Network Device Offline Monitor -- spoken warning when a mission-critical host dies.
 * NetworkPresence already detects LAN hosts going online/offline; this monitor turns.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../service/eventBus.js'
import LoggerService from '../service/loggerService.js'
import NetworkPresence from './networkPresence.js'
import AlertMonitorBase from './base/alertMonitorBase.js'


/** Logger tag used by every message this monitor emits. */
const LABEL = 'NetworkDeviceOfflineMonitor'

/** Alerts bundle key of the offline sentence. */
const OFFLINE_KEY = 'network_device_offline'

/** Alerts bundle key of the recovery sentence. */
const ONLINE_KEY = 'network_device_online'

/** Fallback sentence when the active locale has no offline key. */
const FALLBACK_OFFLINE = 'Attention, {device} is offline.'

/** Fallback sentence when the active locale has no recovery key. */
const FALLBACK_ONLINE = '{device} is back online.'

/** Delay before the startup sweep that announces hosts already down at boot (ms). */
const BOOT_SWEEP_DELAY_MS = 15_000


//  SNetworkDeviceOfflineMonitor (singleton)

/** Singleton monitor speaking a warning whenever a configured mission-critical host. */
class SNetworkDeviceOfflineMonitor extends AlertMonitorBase {

    /** True while the subscriptions are installed; keeps init() idempotent. */
    #running = false

    /** Timer handle of the pending startup sweep, or null when not scheduled. */
    #bootTimer = null

    /** Wire the alerts: key family and the logger tag (no legacy family -- this one is new). */
    constructor() {
        super('network_offline', LABEL)
    }

    //  -- Lifecycle ----------------------------------------------------------

    /** Subscribe to the presence topic of every configured host. An empty announce
     * @async */
    async init() {
        if (this.#running) return   // idempotent
        this.#running = true

        const devices = this.configuredDevices()
        if (devices.length === 0) {
            LoggerService.info(
                'Network offline monitor has no hosts configured (alerts.network_offline_devices) -- staying silent',
                LABEL
            )
            return
        }

        const monitored = new Set(NetworkPresence.getDeviceNames().map((name) => name.toLowerCase()))
        for (const device of devices) {
            if (!monitored.has(device.key)) {
                LoggerService.warn(
                    `Network offline monitor: "${device.name}" is not monitored by network.yaml -- it will never be announced`,
                    LABEL
                )
            }
            this.registerUnsub(EventBus.subscribe(`network:${device.name}`, () => {
                this.#onPresence(device).catch((error) => {
                    LoggerService.error(`Network offline warning failed: ${error.message}`, LABEL)
                })
            }))
        }

        if (this.configValue('announce_boot') !== false) {
            this.#bootTimer = setTimeout(() => {
                this.#bootSweep().catch((error) => {
                    LoggerService.error(`Network offline boot sweep failed: ${error.message}`, LABEL)
                })
            }, BOOT_SWEEP_DELAY_MS)
        }

        LoggerService.info(
            `Network offline monitor watching ${devices.length} host(s): ${devices.map((d) => d.name).join(', ')}`,
            LABEL
        )
    }

    /** Release the presence subscriptions, cancel a pending startup sweep and drop. */
    stop() {
        if (this.#bootTimer) {
            clearTimeout(this.#bootTimer)
            this.#bootTimer = null
        }
        super.stop()
        this.#running = false
    }

    //  -- Public API ---------------------------------------------------------

    /** Announce list read from live config: one entry per configured host, sorted by
     * @returns {Array<{name: string, key: string, overrides: Record<string, unknown>}>} Configured hosts */
    configuredDevices() {
        const raw = this.configValue('devices')
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []

        const out = []
        for (const [name, overridesRaw] of Object.entries(raw)) {
            const trimmed = String(name).trim()
            if (!trimmed) continue
            const overrides = (overridesRaw && typeof overridesRaw === 'object' && !Array.isArray(overridesRaw))
                ? overridesRaw
                : {}
            out.push({ name: trimmed, key: trimmed.toLowerCase(), overrides })
        }
        return out.sort((a, b) => a.name.localeCompare(b.name))
    }

    //  -- Event handling -----------------------------------------------------

    /** Framing source for one host: the monitor-wide profile/options as base.
     * @param {Record<string, unknown>} overrides - Per-device overrides from the announce list
     * @returns {{tts_profile: unknown, tts_options: unknown}} Source object for TtsProfiles.resolve()
     * @private */
    #framingFor(overrides) {
        const global = this.framingSource()
        return {
            tts_profile: overrides.tts_profile ?? global.tts_profile,
            tts_options: overrides.tts_options ?? global.tts_options
        }
    }

    /** React to one presence transition of a configured host: announce offline.
     * @param {{name: string, key: string, overrides: Record<string, unknown>}} device - Configured host entry
     * @async
     * @private */
    async #onPresence(device) {
        const label = NetworkPresence.getLastLabel(device.name)

        if (label === 'offline') {
            this.announce(device.name, {
                key: OFFLINE_KEY,
                fallback: FALLBACK_OFFLINE,
                source: this.#framingFor(device.overrides),
                cooldownMs: device.overrides.cooldown_ms,
                cooldownKey: `${device.name}|offline`,
                logMessage: `Spoken warning: host "${device.name}" is offline`
            })
            return
        }

        if (label === 'online' && this.configValue('announce_recovery') === true) {
            this.announce(device.name, {
                key: ONLINE_KEY,
                fallback: FALLBACK_ONLINE,
                source: this.#framingFor(device.overrides),
                cooldownMs: device.overrides.cooldown_ms,
                cooldownKey: `${device.name}|online`,
                logMessage: `Spoken notice: host "${device.name}" is back online`
            })
        }
    }

    /** Startup sweep: announce the configured hosts NetworkPresence has already found.
     * @async
     * @private */
    async #bootSweep() {
        this.#bootTimer = null
        const down = this.configuredDevices().filter((device) => NetworkPresence.getLastLabel(device.name) === 'offline')
        if (down.length === 0) return
        LoggerService.info(`Boot sweep: ${down.length} configured host(s) already offline -- announcing`, LABEL)
        for (const device of down) {
            await this.#onPresence(device)
        }
    }
}

//  Module-level singleton -- ES module caching guarantees single instantiation.
const NetworkDeviceOfflineMonitor = Object.freeze(new SNetworkDeviceOfflineMonitor())
export default NetworkDeviceOfflineMonitor

