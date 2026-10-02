/**
 * Device Offline Monitor -- spoken warning when a Zigbee device leaves the network.
 *
 * Subscribes to the `devices:removed` EventBus event (emitted by DeviceContainer when
 * the Bridge reports a `device_leave`) and speaks a localized i18n sentence via the
 * shared `tts:speak` channel, e.g. "Uwaga, urządzenie X zeszło z sieci Zigbee."
 *
 * Behavior is config-driven under the top-level `alerts:` section of etc/automaton.yaml
 * (read per-event so `/config reload` changes apply without restart):
 *   - alerts.device_offline_tts        master switch (default ON)
 *   - alerts.device_offline_cooldown_ms per-device re-warning window ("30m", ms; default 30 min)
 *   - alerts.device_offline_ignore     array of device names never announced
 *
 * Sentences live in etc/i18n/<locale>/alerts.yaml under the `device_offline` key with a
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

import fs from 'node:fs'
import path from 'node:path'
import { parse as yamlParse } from 'yaml'

import ConfigService from '../service/configService.js'
import LoggerService from '../service/loggerService.js'
import EventBus from '../service/eventBus.js'
import I18nLoader from '../service/i18nLoader.js'
import TtsService from '../service/ttsService.js'
import temporal from '../lib/date.js'
import { PROJECT_ROOT } from '../lib/projectRoot.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Name of the alerts bundle file inside each locale directory. */
const ALERTS_FILENAME = 'alerts.yaml'

/** Default per-device re-warning cooldown in milliseconds ("30m"). */
const DEFAULT_COOLDOWN_MS = 30 * 60_000

/** Fallback sentence used when the active locale has no alerts bundle / key. */
const FALLBACK_SENTENCE = 'Attention, device {device} has left the Zigbee network.'

// ---------------------------------------------------------------------------
// SDeviceOfflineMonitor (singleton)
// ---------------------------------------------------------------------------

/**
 * Singleton monitor speaking a warning whenever a configured device drops off the
 * Zigbee network. ES module caching guarantees single instantiation.
 */
class SDeviceOfflineMonitor {

    /** Unsubscribe function for the devices:removed channel, or null when stopped. */
    #unsubRemoved = null

    /** Per-device last-spoken timestamps: friendly name -> epoch ms. In-memory only -- a device that was already gone before boot never emits a removal event, so nothing is lost across restarts. */
    #lastWarnedAt = new Map()

    /** Cached alerts bundle keyed by locale to avoid re-reading the file on every event. */
    #bundleCache = { locale: null, bundle: null }

    // -- Lifecycle ----------------------------------------------------------

    /**
     * Subscribe to device removal events. The subscription itself is always installed;
     * all behavioral gates (enabled flag, TTS availability, cooldown, ignore list) are
     * evaluated per-event against live config.
     * @async
     */
    async init() {
        if (this.#unsubRemoved) return   // idempotent
        this.#unsubRemoved = EventBus.subscribe('devices:removed', (friendlyName) => {
            this.#onDeviceRemoved(friendlyName).catch((error) => {
                LoggerService.error(`Device offline warning failed: ${error.message}`, 'DeviceOfflineMonitor')
            })
        })
        LoggerService.info('Device offline monitor listening for devices:removed events', 'DeviceOfflineMonitor')
    }

    /**
     * Unsubscribe from the event bus. Idempotent; called during graceful shutdown.
     */
    stop() {
        if (typeof this.#unsubRemoved === 'function') {
            this.#unsubRemoved()
            this.#unsubRemoved = null
        }
        this.#lastWarnedAt.clear()
        LoggerService.debug('Device offline monitor stopped', 'DeviceOfflineMonitor')
    }

    // -- Event handling -------------------------------------------------------

    /**
     * React to a device leaving the Zigbee network: apply config gates (enabled flag,
     * ignore list, per-device cooldown), then speak the localized warning sentence.
     * @param {string} friendlyName - Friendly name of the removed device
     * @async
     * @private
     */
    async #onDeviceRemoved(friendlyName) {
        const name = String(friendlyName ?? '').trim()
        if (!name) return

        if (ConfigService.get('alerts.device_offline_tts') === false) {
            LoggerService.debug(`Device "${name}" left the network (warnings disabled)`, 'DeviceOfflineMonitor')
            return
        }

        const ignoreList = ConfigService.get('alerts.device_offline_ignore')
        if (Array.isArray(ignoreList) && ignoreList.some((entry) => String(entry).trim().toLowerCase() === name.toLowerCase())) {
            LoggerService.debug(`Device "${name}" left the network (ignored by config)`, 'DeviceOfflineMonitor')
            return
        }

        if (!TtsService.isEnabled()) {
            LoggerService.debug(`Device "${name}" left the network but TTS is unavailable -- not speaking`, 'DeviceOfflineMonitor')
            return
        }

        // Per-device cooldown so a flapping radio does not re-announce every few minutes.
        const cooldownMs = this.#resolveCooldownMs()
        const now = Date.now()
        const lastWarnedAt = this.#lastWarnedAt.get(name)
        if (cooldownMs > 0 && lastWarnedAt !== undefined && now - lastWarnedAt < cooldownMs) {
            LoggerService.debug(
                `Device "${name}" offline again ${now - lastWarnedAt}ms ago -- within cooldown, staying quiet`,
                'DeviceOfflineMonitor'
            )
            return
        }

        const sentence = this.#buildSentence(name)
        this.#lastWarnedAt.set(name, now)
        EventBus.emit('tts:speak', { text: sentence })
        LoggerService.info(`Spoken warning: device "${name}" left the Zigbee network`, 'DeviceOfflineMonitor')
    }

    /**
     * Resolve the per-device cooldown from live config via the shared duration parser
     * (accepts plain ms numbers and "90s"/"15m"-style strings). Falls back to the
     * built-in default on missing/invalid values; 0 disables cooling down entirely.
     * @returns {number} Cooldown in milliseconds (>= 0)
     * @private
     */
    #resolveCooldownMs() {
        const raw = ConfigService.get('alerts.device_offline_cooldown_ms')
        if (raw === null || raw === undefined) return DEFAULT_COOLDOWN_MS
        const parsed = temporal.parseDurationMs(raw)
        return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COOLDOWN_MS
    }

    /**
     * Build the localized warning sentence for a removed device by interpolating the
     * `{device}` placeholder of the active locale's alerts bundle.
     * @param {string} name - Device friendly name
     * @returns {string} Ready-to-speak sentence
     * @private
     */
    #buildSentence(name) {
        const template = this.#loadTemplate()
        return String(template).replace(/\{device\}/g, name)
    }

    /**
     * Load (and cache per locale) the `device_offline` sentence from
     * etc/i18n/<locale>/alerts.yaml. Missing file or key falls back to a built-in
     * English sentence so the feature degrades gracefully on fresh installs.
     * @returns {string} Sentence template containing a `{device}` placeholder
     * @private
     */
    #loadTemplate() {
        let locale
        try {
            locale = I18nLoader.getLocale()
        } catch {
            locale = null   // i18n not initialized yet -- use whatever directory resolves below
        }
        if (!locale || !this.#bundleCache.locale || this.#bundleCache.locale !== locale) {
            this.#bundleCache = { locale: locale ?? '', bundle: this.#readBundle(locale) }
        }
        return this.#bundleCache.bundle?.device_offline || FALLBACK_SENTENCE
    }

    /**
     * Read one alerts bundle file for a locale; returns null when unreadable.
     * @param {string|null} locale - Locale directory name under etc/i18n/
     * @returns {Record<string, unknown>|null} Parsed bundle contents
     * @private
     */
    #readBundle(locale) {
        if (!locale) return null
        const filePath = path.join(I18N_ROOT, locale, ALERTS_FILENAME)
        try {
            if (!fs.existsSync(filePath)) return null
            return yamlParse(fs.readFileSync(filePath, 'utf-8'))
        } catch (error) {
            LoggerService.warn(`Failed to load ${ALERTS_FILENAME} for "${locale}": ${error.message}`, 'DeviceOfflineMonitor')
            return null
        }
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const DeviceOfflineMonitor = Object.freeze(new SDeviceOfflineMonitor())
export default DeviceOfflineMonitor