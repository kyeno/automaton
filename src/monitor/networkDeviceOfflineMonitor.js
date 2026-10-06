/**
 * Network Device Offline Monitor -- spoken warning when a mission-critical host dies.
 *
 * NetworkPresence already detects LAN hosts going online/offline; this monitor turns
 * the offline transitions of the hosts you cannot live without (core server, DNS,
 * WiFi router, ...) into a spoken alert, e.g. "Uwaga, serwer core jest offline."
 * Detection, dedupe and persistence stay in NetworkPresence -- this class only
 * subscribes to the `network:<name>` EventBus topic of the configured hosts and asks
 * which label the last sweep recorded.
 *
 * Announce list and per-device overrides live in the `alerts:` section of
 * etc/automaton.yaml (read per-event, so `/config reload` applies without a restart):
 *   alerts.network_offline_devices         map of device name -> overrides (allow-list)
 *   alerts.network_offline_tts             master switch (default ON)
 *   alerts.network_offline_cooldown_ms     per-host re-warning window (default "30m")
 *   alerts.network_offline_ignore          array of device names never announced
 *   alerts.network_offline_tts_profile     framing profile name (locale tts.yaml profiles:)
 *   alerts.network_offline_tts_options     explicit framing block, wins over the profile
 *   alerts.network_offline_announce_boot   announce hosts already down at startup (default ON)
 *   alerts.network_offline_announce_recovery  announce the way back (default OFF)
 * A device entry may be null (plain defaults) or an object carrying `cooldown_ms`,
 * `tts_profile` and `tts_options` for that one host. Device names refer to
 * etc/device/network.yaml -- IPs live there, never here, and a configured name that
 * is not monitored by NetworkPresence is reported once at startup.
 *
 * Sentences live in etc/i18n/<locale>/alerts.yaml under `network_device_offline` /
 * `network_device_online`, either as plain templates with a `{device}` placeholder or
 * as per-device maps with a `default` entry. See doc/monitors/offline-alerts.md.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../service/eventBus.js'
import LoggerService from '../service/loggerService.js'
import NetworkPresence from './networkPresence.js'
import AlertMonitorBase from './base/alertMonitorBase.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

/**
 * Delay before the startup sweep that announces hosts already down at boot (ms).
 * NetworkPresence starts sweeping immediately on init and a full pass over a few
 * unreachable hosts takes seconds, so this waits out the first sweep instead of
 * announcing hosts whose state is not known yet.
 */
const BOOT_SWEEP_DELAY_MS = 15_000


// ---------------------------------------------------------------------------
// SNetworkDeviceOfflineMonitor (singleton)
// ---------------------------------------------------------------------------

/**
 * Singleton monitor speaking a warning whenever a configured mission-critical host
 * drops off the LAN. ES module caching guarantees single instantiation.
 */
class SNetworkDeviceOfflineMonitor extends AlertMonitorBase {

    /** True while the subscriptions are installed; keeps init() idempotent. */
    #running = false

    /** Timer handle of the pending startup sweep, or null when not scheduled. */
    #bootTimer = null

    /** Wire the alerts: key family and the logger tag (no legacy family -- this one is new). */
    constructor() {
        super('network_offline', LABEL)
    }

    // -- Lifecycle ----------------------------------------------------------

    /**
     * Subscribe to the presence topic of every configured host. An empty announce
     * list is a valid configuration: the monitor then installs nothing and stays
     * silent. Names missing from network.yaml are reported once here, because such a
     * host can never produce a transition event.
     * @async
     */
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

    /**
     * Release the presence subscriptions, cancel a pending startup sweep and drop the
     * cooldown record. Idempotent; called during graceful shutdown.
     */
    stop() {
        if (this.#bootTimer) {
            clearTimeout(this.#bootTimer)
            this.#bootTimer = null
        }
        super.stop()
        this.#running = false
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Announce list read from live config: one entry per configured host, sorted by
     * name, each carrying its per-device overrides. Exposed (no # prefix) so tests and
     * diagnostics can see what the monitor is watching. A null/empty entry yields
     * empty overrides (plain defaults); non-object values are ignored the same way.
     * @returns {Array<{name: string, key: string, overrides: Record<string, unknown>}>} Configured hosts
     */
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

    // -- Event handling -----------------------------------------------------

    /**
     * Framing source for one host: the monitor-wide profile/options as base, with the
     * host's own overrides winning key by key.
     * @param {Record<string, unknown>} overrides - Per-device overrides from the announce list
     * @returns {{tts_profile: unknown, tts_options: unknown}} Source object for TtsProfiles.resolve()
     * @private
     */
    #framingFor(overrides) {
        const global = this.framingSource()
        return {
            tts_profile: overrides.tts_profile ?? global.tts_profile,
            tts_options: overrides.tts_options ?? global.tts_options
        }
    }

    /**
     * React to one presence transition of a configured host: announce offline
     * transitions, and -- when recovery speech is enabled -- the way back. The label
     * comes from NetworkPresence's in-memory record (the event carries none), and the
     * cooldown slot is keyed per transition direction so a flapping host cannot let a
     * recovery line swallow the next offline warning.
     * @param {{name: string, key: string, overrides: Record<string, unknown>}} device - Configured host entry
     * @async
     * @private
     */
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

    /**
     * Startup sweep: announce the configured hosts NetworkPresence has already found
     * down. A host that was offline before boot never emits a transition event, so
     * without this sweep the alert for a server that died during the night would only
     * be heard after it came back and died again. The per-host cooldown applies, so a
     * boot announcement and a later transition never double-speak.
     * @async
     * @private
     */
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

// Module-level singleton -- ES module caching guarantees single instantiation.
const NetworkDeviceOfflineMonitor = Object.freeze(new SNetworkDeviceOfflineMonitor())
export default NetworkDeviceOfflineMonitor

