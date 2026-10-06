/**
 * Zigbee Device Offline Monitor -- spoken warning when a Zigbee device leaves the network.
 *
 * Subscribes to the `devices:removed` EventBus event (emitted by DeviceContainer when
 * the Bridge reports a `device_leave`) and speaks a localized i18n sentence, e.g.
 * "Uwaga, urządzenie X zeszło z sieci Zigbee."
 *
 * All spoken-alert policy -- master switch, ignore list, per-device cooldown, TTS
 * availability gate, sentence interpolation and jingle framing -- lives in
 * AlertMonitorBase; this class only detects the removal and names the sentence key.
 * Config keys are the `alerts.zigbee_offline_*` family of etc/automaton.yaml, read
 * per-event so `/config reload` applies changes without a restart (see
 * doc/monitors/offline-alerts.md). The pre-rename `alerts.device_offline_*` keys and
 * the pre-rename `device_offline` sentence key keep working, with a one-time
 * deprecation warning naming the new family.
 *
 * Sentences live in etc/i18n/<locale>/alerts.yaml under `zigbee_device_offline` with a
 * `{device}` placeholder. When TTS is unavailable the removal is only logged -- nothing
 * is spoken and no cooldown slot is consumed.
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
import AlertMonitorBase from './base/alertMonitorBase.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Logger tag used by every message this monitor emits. */
const LABEL = 'ZigbeeDeviceOfflineMonitor'

/** Alerts bundle key holding the sentence template. */
const SENTENCE_KEY = 'zigbee_device_offline'

/** Alerts bundle key of the pre-rename sentence, honoured as a fallback. */
const LEGACY_SENTENCE_KEY = 'device_offline'

/** Fallback sentence used when the active locale has no alerts bundle / key. */
const FALLBACK_SENTENCE = 'Attention, device {device} has left the Zigbee network.'

// ---------------------------------------------------------------------------
// SZigbeeDeviceOfflineMonitor (singleton)
// ---------------------------------------------------------------------------

/**
 * Singleton monitor speaking a warning whenever a configured device drops off the
 * Zigbee network. ES module caching guarantees single instantiation.
 */
class SZigbeeDeviceOfflineMonitor extends AlertMonitorBase {

    /** True while the devices:removed subscription is installed; keeps init() idempotent. */
    #running = false

    /** Wire the alerts: key family (with its pre-rename fallback) and the logger tag. */
    constructor() {
        super('zigbee_offline', LABEL, 'device_offline')
    }

    // -- Lifecycle ----------------------------------------------------------

    /**
     * Subscribe to device removal events. The subscription itself is always
     * installed; all behavioral gates (enabled flag, TTS availability, cooldown,
     * ignore list) are evaluated per-event against live config.
     * @async
     */
    async init() {
        if (this.#running) return   // idempotent
        this.registerUnsub(EventBus.subscribe('devices:removed', (friendlyName) => {
            this.#onDeviceRemoved(friendlyName).catch((error) => {
                LoggerService.error(`Device offline warning failed: ${error.message}`, LABEL)
            })
        }))
        this.#running = true
        LoggerService.info('Zigbee device offline monitor listening for devices:removed events', LABEL)
    }

    /**
     * Unsubscribe from the event bus and drop the cooldown record. Idempotent;
     * called during graceful shutdown.
     */
    stop() {
        super.stop()
        this.#running = false
    }

    // -- Event handling -------------------------------------------------------

    /**
     * React to a device leaving the Zigbee network by running it through the shared
     * alert policy. The legacy bundle key is passed as the fallback template, so an
     * installation whose alerts.yaml still uses `device_offline` keeps its own
     * wording; the built-in English sentence covers a bundle with neither key.
     * @param {string} friendlyName - Friendly name of the removed device
     * @async
     * @private
     */
    async #onDeviceRemoved(friendlyName) {
        const name = String(friendlyName ?? '').trim()
        if (!name) return

        this.announce(name, {
            key: SENTENCE_KEY,
            fallback: this.sentence(LEGACY_SENTENCE_KEY, name, FALLBACK_SENTENCE),
            logMessage: `Spoken warning: device "${name}" left the Zigbee network`
        })
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const ZigbeeDeviceOfflineMonitor = Object.freeze(new SZigbeeDeviceOfflineMonitor())
export default ZigbeeDeviceOfflineMonitor
