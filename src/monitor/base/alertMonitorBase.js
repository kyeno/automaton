/**
 * AlertMonitorBase -- shared spoken-alert policy for monitor singletons.
 *
 * Every monitor that warns by speaking needs the same policy: a master switch, an
 * ignore list, a per-device cooldown, a graceful degradation when TTS is down, a
 * localized sentence with the device name interpolated, and jingle framing resolved
 * through the shared profile rules. This base owns all of it so each concrete
 * monitor only has to detect its event and name the sentence key it wants spoken.
 *
 * Configuration lives in the top-level `alerts:` section of etc/automaton.yaml and is
 * read per-event, so `/config reload` applies changes without a restart. Keys are
 * namespaced by the `keyPrefix` a subclass declares: for keyPrefix 'zigbee_offline'
 * the family is
 *   alerts.zigbee_offline_tts           master switch (default ON)
 *   alerts.zigbee_offline_cooldown_ms   per-device re-warning window ("30m", ms)
 *   alerts.zigbee_offline_ignore        array of device names never announced
 *   alerts.zigbee_offline_tts_profile   framing profile name (locale tts.yaml profiles:)
 *   alerts.zigbee_offline_tts_options   explicit framing block, wins over the profile
 * A legacy prefix may be declared for a key family that was renamed: the old keys keep
 * working and a one-time deprecation warning names the new family.
 *
 * Sentences live in etc/i18n/<locale>/alerts.yaml. A key may be a plain string, or a
 * per-device map with a `default` entry:
 *   network_device_offline:
 *     default: "Attention, {device} is offline."
 *     core-server: "Attention, the core server is offline."
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

import ConfigService from '../../service/configService.js'
import LoggerService from '../../service/loggerService.js'
import I18nLoader from '../../service/i18nLoader.js'
import TtsService from '../../service/ttsService.js'
import TtsProfiles from '../../lib/ttsProfiles.js'
import temporal from '../../lib/date.js'
import { PROJECT_ROOT } from '../../lib/projectRoot.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Name of the alerts bundle file inside each locale directory. */
const ALERTS_FILENAME = 'alerts.yaml'

/** Default per-device re-warning cooldown in milliseconds ("30m"). */
const DEFAULT_COOLDOWN_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// AlertMonitorBase (abstract base)
// ---------------------------------------------------------------------------

/**
 * Shared spoken-alert policy for monitor singletons -- extend it, declare the
 * `alerts:` key family, and call announce() from the event handler. Not a singleton:
 * subclasses instantiate it and own the EventBus subscriptions.
 */
export default class AlertMonitorBase {

    /**
     * @param {string} keyPrefix - alerts: key family this monitor reads, e.g. 'zigbee_offline'
     * @param {string} label - Logger tag used by every message this monitor emits
     * @param {string|null} [legacyKeyPrefix=null] - Renamed-away key family still honoured as fallback
     */
    constructor(keyPrefix, label, legacyKeyPrefix = null) {
        /** alerts: key family read by this monitor (suffixes appended after '_'). */
        this.keyPrefix = keyPrefix
        /** Logger tag for every message this monitor emits. */
        this.label = label
        /** Deprecated key family kept working as a fallback, or null when there is none. */
        this.legacyKeyPrefix = legacyKeyPrefix
    }

    /** Per-device last-spoken timestamps: cooldown key -> epoch ms. In-memory only -- a target that was already down before boot never emits a transition event, so nothing is lost across restarts. */
    #lastWarnedAt = new Map()

    /** Cached alerts bundle keyed by locale to avoid re-reading the file on every event. */
    #bundleCache = { locale: null, bundle: null }

    /** Unsubscribe functions of the subscriptions a subclass registered, run by stop(). */
    #unsubscribers = []

    /** Legacy key families already warned about -- the deprecation notice fires once per family. */
    #legacyWarned = new Set()

    // -- Config gates ---------------------------------------------------------

    /**
     * Read one `alerts:` value of this monitor's key family, falling back to the
     * legacy family (when declared) and warning once about the deprecated key.
     * @param {string} suffix - Key suffix within the family, e.g. 'cooldown_ms'
     * @returns {unknown} Configured value, or null when neither family carries it
     */
    configValue(suffix) {
        const key = `alerts.${this.keyPrefix}_${suffix}`
        const value = ConfigService.get(key)
        if (value !== null && value !== undefined) return value
        if (!this.legacyKeyPrefix) return null

        const legacyValue = ConfigService.get(`alerts.${this.legacyKeyPrefix}_${suffix}`)
        if (legacyValue === null || legacyValue === undefined) return null
        if (!this.#legacyWarned.has(this.legacyKeyPrefix)) {
            this.#legacyWarned.add(this.legacyKeyPrefix)
            LoggerService.warn(
                `Deprecated config key "alerts.${this.legacyKeyPrefix}_${suffix}" -- rename the "alerts.${this.legacyKeyPrefix}_" family to "alerts.${this.keyPrefix}_"`,
                this.label
            )
        }
        return legacyValue
    }

    /**
     * Master switch for this monitor's spoken warnings. Defaults to ON: only an
     * explicit false silences the monitor.
     * @returns {boolean} True when warnings may be spoken
     */
    isMasterEnabled() {
        return this.configValue('tts') !== false
    }

    /**
     * Check a device name against this monitor's ignore list (case-insensitive,
     * whitespace-tolerant).
     * @param {string} name - Device friendly name
     * @returns {boolean} True when the device must never be announced
     */
    isIgnored(name) {
        const ignoreList = this.configValue('ignore')
        if (!Array.isArray(ignoreList)) return false
        const wanted = String(name).trim().toLowerCase()
        return ignoreList.some((entry) => String(entry).trim().toLowerCase() === wanted)
    }

    /**
     * Resolve the re-warning window from a raw configured value (plain ms numbers and
     * "90s"/"15m"-style strings via the shared duration parser). Falls back to the
     * built-in default on missing/invalid values; 0 disables cooling down entirely.
     * @param {unknown} raw - Configured cooldown value; null falls back to the default
     * @returns {number} Cooldown in milliseconds (>= 0)
     */
    cooldownMs(raw = null) {
        const value = raw === null || raw === undefined ? this.configValue('cooldown_ms') : raw
        if (value === null || value === undefined) return DEFAULT_COOLDOWN_MS
        const parsed = temporal.parseDurationMs(value)
        return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COOLDOWN_MS
    }

    /**
     * Framing source for this monitor's utterances: the profile name and explicit
     * framing block configured for its key family, shaped for TtsProfiles.resolve().
     * @returns {{tts_profile: unknown, tts_options: unknown}} Source object (values may be null)
     */
    framingSource() {
        return {
            tts_profile: this.configValue('tts_profile'),
            tts_options: this.configValue('tts_options')
        }
    }

    // -- Localized sentences --------------------------------------------------

    /**
     * Load (and cache per locale) the active alerts bundle. Missing file, missing
     * locale or unreadable file yield null so every caller degrades gracefully.
     * @returns {Record<string, unknown>|null} Parsed alerts bundle
     */
    bundle() {
        let locale
        try {
            locale = I18nLoader.getLocale()
        } catch {
            locale = null   // i18n not initialized yet -- use whatever directory resolves below
        }
        if (this.#bundleCache.locale !== (locale ?? '')) {
            this.#bundleCache = { locale: locale ?? '', bundle: this.readBundle(locale) }
        }
        return this.#bundleCache.bundle
    }

    /**
     * Read one alerts bundle file for a locale; returns null when unreadable.
     * @param {string|null} locale - Locale directory name under etc/i18n/
     * @returns {Record<string, unknown>|null} Parsed bundle contents
     */
    readBundle(locale) {
        if (!locale) return null
        const filePath = path.join(I18N_ROOT, locale, ALERTS_FILENAME)
        try {
            if (!fs.existsSync(filePath)) return null
            return yamlParse(fs.readFileSync(filePath, 'utf-8'))
        } catch (error) {
            LoggerService.warn(`Failed to load ${ALERTS_FILENAME} for "${locale}": ${error.message}`, this.label)
            return null
        }
    }

    /**
     * Build the ready-to-speak sentence for one device. A bundle key may be a plain
     * string template or a per-device map with a `default` entry (device names match
     * case-insensitively); the `{device}` placeholder is interpolated. Falls back to
     * the caller's built-in template, and to naming the device alone when neither
     * exists -- a bare device name is a worse sentence than none at all.
     * @param {string} key - Key within the alerts bundle, e.g. 'zigbee_device_offline'
     * @param {string} name - Device friendly name interpolated into the template
     * @param {string|null} [fallback=null] - Built-in template used when the bundle lacks the key
     * @returns {string} Ready-to-speak sentence
     */
    sentence(key, name, fallback = null) {
        const entry = this.bundle()?.[key]
        let template = null
        if (typeof entry === 'string') {
            template = entry
        } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const wanted = String(name).trim().toLowerCase()
            const perDevice = Object.keys(entry).find((device) => device.toLowerCase() === wanted)
            template = perDevice ? entry[perDevice] : entry.default
        }
        if (typeof template !== 'string' || !template.trim()) {
            template = typeof fallback === 'string' && fallback.trim() ? fallback : null
        }
        if (template === null) return String(name)
        return template.replace(/\{device\}/g, String(name))
    }

    // -- Speaking -------------------------------------------------------------

    /**
     * Apply the full alert policy to one event and speak when every gate passes:
     * master switch, ignore list, TTS availability, then the per-device cooldown.
     * The cooldown slot is consumed only by a successful warning, so an attempt
     * blocked by unavailable TTS leaves the device announceable the moment speech
     * recovers. Framing comes from the caller's source (defaults to this monitor's
     * own `alerts:` family) resolved through the shared profile rules.
     * @param {string} name - Device friendly name interpolated into the sentence
     * @param {Object} options - Alert parameters
     * @param {string} options.key - Alerts bundle key of the sentence template
     * @param {string} [options.fallback] - Built-in template when the bundle lacks the key
     * @param {Record<string, unknown>|null} [options.source] - Framing source; defaults to framingSource()
     * @param {number|null} [options.cooldownMs] - Per-device cooldown override
     * @param {string|null} [options.cooldownKey] - Cooldown slot name; defaults to the device name
     * @param {string|null} [options.logMessage] - Info log line on success
     * @returns {boolean} True when the warning was spoken
     */
    announce(name, options = {}) {
        const {
            key,
            fallback = null,
            source = null,
            cooldownMs = null,
            cooldownKey = null,
            logMessage = null
        } = options

        const target = String(name ?? '').trim()
        if (!target) return false

        if (!this.isMasterEnabled()) {
            LoggerService.debug(`"${target}" alert skipped -- master switch off`, this.label)
            return false
        }
        if (this.isIgnored(target)) {
            LoggerService.debug(`"${target}" alert skipped -- ignored by config`, this.label)
            return false
        }
        if (!TtsService.isEnabled()) {
            LoggerService.debug(`"${target}" alert skipped -- TTS unavailable, not speaking`, this.label)
            return false
        }

        const windowMs = this.cooldownMs(cooldownMs)
        const slot = cooldownKey ?? target
        const now = Date.now()
        const lastWarnedAt = this.#lastWarnedAt.get(slot)
        if (windowMs > 0 && lastWarnedAt !== undefined && now - lastWarnedAt < windowMs) {
            LoggerService.debug(
                `"${target}" alert suppressed -- ${now - lastWarnedAt}ms since the last one (cooldown ${windowMs}ms)`,
                this.label
            )
            return false
        }

        const text = this.sentence(key, target, fallback)
        const framing = TtsProfiles.resolve(
            source ?? this.framingSource(),
            (message) => LoggerService.warn(message, this.label)
        )

        this.#lastWarnedAt.set(slot, now)
        TtsProfiles.speak(text, framing)
        LoggerService.info(logMessage ?? `Spoken alert: ${text}`, this.label)
        return true
    }

    // -- Subscriptions --------------------------------------------------------

    /**
     * Register an EventBus unsubscribe function so stop() can release every
     * subscription a subclass installed.
     * @param {Function} unsubscribe - Value returned by EventBus.subscribe()
     */
    registerUnsub(unsubscribe) {
        if (typeof unsubscribe === 'function') this.#unsubscribers.push(unsubscribe)
    }

    /**
     * Release all registered subscriptions and clear the cooldown record.
     * Idempotent; called during graceful shutdown.
     */
    stop() {
        for (const unsubscribe of this.#unsubscribers) {
            try {
                unsubscribe()
            } catch (error) {
                LoggerService.debug(`Unsubscribe failed: ${error.message}`, this.label)
            }
        }
        this.#unsubscribers = []
        this.#lastWarnedAt.clear()
        LoggerService.debug(`${this.label} stopped`, this.label)
    }
}

