/**
 * Independent sensor freeze detection, recovery and grouped notifications.
 * SQLite owns durable observations; StateService exposes the current frozen list.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import ConfigService from '../service/configService.js'
import DatabaseService from '../service/databaseService.js'
import StateService from '../service/stateService.js'
import EventBus from '../service/eventBus.js'
import LoggerService from '../service/loggerService.js'
import I18nLoader from '../service/i18nLoader.js'
import TtsService from '../service/ttsService.js'
import AiAssistant from '../ai/aiAssistant.js'
import DeviceContainer from '../device/container/deviceContainer.js'
import AnnouncementPipeline from '../lib/announcementPipeline.js'
import TtsProfiles from '../lib/ttsProfiles.js'
import temporal from '../lib/date.js'
import PROJECT_ROOT from '../lib/projectRoot.js'

/** Public StateService key, also used for the SQLite runtime-state record. */
export const FROZEN_SENSOR_STATE_KEY = 'monitor:frozenSensors'
/** Independent sweep cadence; device events handle recovery between sweeps. */
const SWEEP_MS = 60_000
/** Logger and pipeline identity. */
const LABEL = 'FrozenSensorMonitor'

/** Sensor health monitoring independent of automation schedules and speech windows. */
class SFrozenSensorMonitor {
    /** Last observations and incident status, keyed by device name. @type {Map<string, object>} */
    #probes = new Map()
    /** Epoch ms of the last successful grouped speech. @type {number|null} */
    #lastSpokenAt = null
    /** Independent sweep timer. @type {ReturnType<typeof setInterval>|null} */
    #timer = null
    /** Device subscriptions, rebuilt when configuration changes. @type {Map<string, Function>} */
    #subscriptions = new Map()
    /** Whether the monitor accepts events and ticks. */
    #running = false
    /** Current sweep, shared by overlapping callers. @type {Promise<void>|null} */
    #inFlight = null
    /** Changes awaiting durable storage. */
    #dirty = false

    /** Restore durable observations and start independent monitoring. Idempotent.
     * @returns {Promise<void>} */
    async init() {
        if (this.#running) return
        this.#probes.clear()
        this.#lastSpokenAt = null
        this.#dirty = false
        const stored = await DatabaseService.getRuntimeState(FROZEN_SENSOR_STATE_KEY)
        if (stored?.version === 1 && Array.isArray(stored.probes)) {
            for (const probe of stored.probes) {
                if (typeof probe?.name !== 'string' || typeof probe.property !== 'string'
                    || !Number.isFinite(probe.value) || !Number.isFinite(probe.changedAt)
                    || (probe.detectedAt !== null && !Number.isFinite(probe.detectedAt))) continue
                this.#probes.set(probe.name, { ...probe, emailPending: probe.emailPending === true })
            }
            if (Number.isFinite(stored.lastSpokenAt)) this.#lastSpokenAt = stored.lastSpokenAt
        }
        this.#running = true
        try { await this.tick() }
        catch (error) { await this.stop(); throw error }
        this.#timer = setInterval(() => {
            this.tick().catch((error) => this.#log(error.message, 'error'))
        }, SWEEP_MS)
        this.#timer.unref?.()
        this.#log('Independent sensor health sweep started (1m)', 'info')
    }

    /** Unsubscribe, cancel the timer and finish pending work before SQLite closes.
     * @returns {Promise<void>} */
    async stop() {
        this.#running = false
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
        for (const unsubscribe of this.#subscriptions.values()) unsubscribe()
        this.#subscriptions.clear()
        try {
            if (this.#inFlight) await this.#inFlight
        } finally {
            await this.#persist()
            StateService.delete(FROZEN_SENSOR_STATE_KEY)
        }
    }

    /** Perform one grouped sweep; no automation time-window gate is involved.
     * @returns {Promise<void>} */
    async tick() {
        if (!this.#running) return
        if (this.#inFlight) return this.#inFlight
        this.#inFlight = this.#sweep()
        try { await this.#inFlight }
        finally { this.#inFlight = null }
    }

    /** Read current settings so /config changes apply on the next sweep.
     * @private
     * @returns {object} Monitor configuration. */
    #config() {
        return ConfigService.get('alerts.frozen_sensors') ?? {}
    }

    /** Validate dynamic device entries before subscribing or reading them.
     * @param {object} config - Monitor settings.
     * @private
     * @returns {Map<string, {property: string, unit: string}>} Watched properties. */
    #devices(config) {
        const devices = new Map()
        if (config.enabled === false || !config.devices || typeof config.devices !== 'object' || Array.isArray(config.devices)) return devices
        for (const [name, entry] of Object.entries(config.devices)) {
            if (!name.trim() || typeof entry?.property !== 'string' || !entry.property.trim()) {
                this.#log(`Invalid frozen-sensor entry for ${name}; expected {property, unit?}`, 'warn')
                continue
            }
            devices.set(name, { property: entry.property.trim(), unit: typeof entry.unit === 'string' ? entry.unit : '' })
        }
        return devices
    }

    /** Refresh subscriptions and drop state for removed or reconfigured sensors.
     * @param {Map<string, object>} devices - Current configured device entries.
     * @private
     * @returns {void} */
    #reconcile(devices) {
        for (const [name, unsubscribe] of this.#subscriptions) {
            if (!devices.has(name)) { unsubscribe(); this.#subscriptions.delete(name) }
        }
        for (const [name, probe] of this.#probes) {
            if (!devices.has(name) || devices.get(name).property !== probe.property) {
                this.#probes.delete(name)
                this.#dirty = true
            }
        }
        for (const [name] of devices) {
            if (this.#subscriptions.has(name)) continue
            this.#subscriptions.set(name, EventBus.subscribe(`zigbee:${name}`, () => {
                // Observe synchronously: a change and return during a slow AI call must not be lost.
                const entry = this.#devices(this.#config()).get(name)
                if (!this.#running || !entry) return
                this.#observe(name, entry)
                this.#publish()
                this.#persist().catch((error) => this.#log(error.message, 'error'))
            }))
        }
    }

    /** Read a finite numeric value; missing, blank and boolean readings prove nothing.
     * @param {string} name - Device friendly name.
     * @param {string} property - State property to inspect.
     * @private
     * @returns {number|null} Numeric reading or null. */
    #reading(name, property) {
        const raw = DeviceContainer.findByName(name)?.getStateLast()?.[property]
        if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return null
        const value = Number(raw)
        return Number.isFinite(value) ? value : null
    }

    /** Record a changed reading and clear its incident immediately.
     * @param {string} name - Device friendly name.
     * @param {{property: string, unit: string}} entry - Watched property and display unit.
     * @private
     * @returns {boolean} Whether a numeric reading was available. */
    #observe(name, entry) {
        const value = this.#reading(name, entry.property)
        if (value === null) return false
        const before = this.#probes.get(name)
        if (!before || before.property !== entry.property || before.value !== value || before.changedAt > Date.now()) {
            if (before?.detectedAt != null) this.#log(`Frozen sensor recovered: ${name}`, 'info')
            this.#probes.set(name, { name, ...entry, value, changedAt: Date.now(), detectedAt: null, emailPending: false })
            this.#dirty = true
        } else if (before.unit !== entry.unit) {
            before.unit = entry.unit
            this.#dirty = true
        }
        return true
    }

    /** Detect all due incidents together, then send one grouped email and one voice reminder.
     * @private
     * @returns {Promise<void>} */
    async #sweep() {
        const config = this.#config()
        const devices = this.#devices(config)
        this.#reconcile(devices)
        const unchangedFor = this.#duration(config.unchanged_for, 86_400_000)
        for (const [name, entry] of devices) {
            if (!this.#observe(name, entry)) continue
            const probe = this.#probes.get(name)
            if (probe.detectedAt === null && Date.now() - probe.changedAt >= unchangedFor) {
                probe.detectedAt = Date.now()
                probe.emailPending = true
                this.#dirty = true
                this.#log(`Frozen sensor suspected: ${name} (${probe.value}${probe.unit})`, 'warn')
            }
        }
        this.#publish()
        await this.#persist()
        if (!this.#running || config.enabled === false) return

        const pending = this.#frozen().filter((probe) => probe.emailPending)
        if (pending.length > 0) {
            // Mail never waits for AI or quiet hours. Failed/disabled delivery remains pending.
            let outcome = null
            try { outcome = await this.#announce(pending, config, false, true) }
            catch (error) { this.#log(`Initial frozen-sensor mail failed: ${error.message}`, 'warn') }
            if (outcome?.emailed) {
                for (const probe of pending) {
                    if (this.#probes.get(probe.name) === probe) probe.emailPending = false
                }
                this.#dirty = true
                await this.#persist()
            }
        }

        // Re-read after mail: a device may recover while an output call is awaited.
        const active = this.#frozen().filter((probe) => this.#reading(probe.name, probe.property) === probe.value)
        const reminderMs = this.#duration(config.reminder_interval, 900_000)
        const elapsed = this.#lastSpokenAt === null ? Infinity : Date.now() - this.#lastSpokenAt
        if (!this.#running || !active.length || config.speak === false || this.#silent(config.silence_between)
            || (!AiAssistant.isAvailable() && !TtsService.isEnabled()) || (elapsed >= 0 && elapsed < reminderMs)) return
        const outcome = await this.#announce(active, config, true, false)
        if (outcome.spoken) {
            this.#lastSpokenAt = Date.now()
            this.#dirty = true
            await this.#persist()
        }
    }

    /** Current incidents, sorted for stable grouped reports.
     * @private
     * @returns {object[]} Frozen probes. */
    #frozen() {
        return [...this.#probes.values()].filter((probe) => probe.detectedAt !== null).sort((a, b) => a.name.localeCompare(b.name))
    }

    /** Publish detached incident objects for UI and other runtime consumers.
     * @private
     * @returns {void} */
    #publish() {
        StateService.set(FROZEN_SENSOR_STATE_KEY, this.#frozen().map((probe) => ({ ...probe })))
    }

    /** Save dirty observations; failed writes are retried on the next event or sweep.
     * @private
     * @returns {Promise<void>} */
    async #persist() {
        if (!this.#dirty) return
        this.#publish()
        // Clear before awaiting so concurrent observations leave another write pending.
        this.#dirty = false
        const value = { version: 1, probes: [...this.#probes.values()], lastSpokenAt: this.#lastSpokenAt }
        if (!await DatabaseService.setRuntimeState(FROZEN_SENSOR_STATE_KEY, value)) this.#dirty = true
    }

    /** Positive duration with a safe default for invalid settings.
     * @param {unknown} raw - Configured duration.
     * @param {number} fallback - Default milliseconds.
     * @private
     * @returns {number} Positive milliseconds. */
    #duration(raw, fallback) {
        const ms = temporal.parseDurationMs(raw)
        return Number.isFinite(ms) && ms > 0 ? ms : fallback
    }

    /** Independent local quiet hours; invalid windows are logged and do not mute alerts.
     * @param {unknown} raw - HHmm-HHmm window or null.
     * @private
     * @returns {boolean} Whether speech is quiet right now. */
    #silent(raw) {
        if (!raw) return false
        const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(raw))
        if (!match || +match[1] > 23 || +match[3] > 23 || +match[2] > 59 || +match[4] > 59) {
            this.#log('Invalid frozen_sensors.silence_between; expected HHmm-HHmm', 'warn')
            return false
        }
        const start = +match[1] * 60 + +match[2]
        const end = +match[3] * 60 + +match[4]
        const now = new Date()
        const minute = now.getHours() * 60 + now.getMinutes()
        if (start === end) return false
        return start < end ? minute >= start && minute < end : minute >= start || minute < end
    }

    /** Load the active locale's dedicated sensor-health bundle, falling back to its template.
     * @private
     * @returns {object|null} Validated YAML bundle. */
    #bundle() {
        const base = path.join(PROJECT_ROOT, 'etc', 'i18n', I18nLoader.getLocale(), 'frozen-sensors.yaml')
        try {
            const doc = parseDocument(fs.readFileSync(fs.existsSync(base) ? base : `${base}.dist`, 'utf8'))
            if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '))
            return doc.toJS()
        } catch (error) {
            this.#log(`Cannot load frozen-sensor language bundle: ${error.message}`, 'warn')
            return null
        }
    }

    /** Build a grouped warning through the shared pipeline; mail is independent of speech.
     * @param {object[]} probes - Incidents to describe.
     * @param {object} config - Monitor settings.
     * @param {boolean} speak - Whether this is a speech reminder.
     * @param {boolean} email - Whether this is an initial detection email.
     * @private
     * @returns {Promise<object>} Pipeline outcome. */
    async #announce(probes, config, speak, email) {
        const units = { ...temporal.getDurationUnits() }
        delete units.day
        const duration = this.#duration(config.unchanged_for, 86_400_000)
        const tokens = {
            frozen_sensors: probes.map((probe) => `${probe.name} (${probe.property}: ${probe.value}${probe.unit})`).join(', '),
            frozen_window: temporal.msToHumanPhrase(duration, units) ?? temporal.millisecondsToHumanReadable(duration),
            frozen_count: String(probes.length),
        }
        return AnnouncementPipeline.announce({
            bundle: this.#bundle(), section: 'frozen', tokens, label: LABEL,
            useAi: speak && config.use_ai === true, speak,
            emitUi: speak, emitBridge: speak,
            email: email ? { kind: 'sensor_frozen', tokens } : null,
            ttsOptions: TtsProfiles.resolve(config, (message) => this.#log(message, 'warn')),
            onWarn: (message) => this.#log(message, 'warn'),
            log: (message, level) => this.#log(message, level),
        })
    }

    /** Route monitor messages through the shared logger.
     * @param {string} message - Message text.
     * @param {string} [level='debug'] - Logger level.
     * @private
     * @returns {void} */
    #log(message, level = 'debug') {
        LoggerService[level](message, LABEL)
    }
}

/** Module singleton, following the project's monitor lifecycle. */
const FrozenSensorMonitor = Object.freeze(new SFrozenSensorMonitor())
export default FrozenSensorMonitor
