/**
 * Event-driven numeric sensor history, independent of announcement schedules.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from './configService.js'
import DatabaseService from './databaseService.js'
import EventBus from './eventBus.js'
import temporal from '../lib/date.js'

/** Numeric measurements recorded by default; battery/link quality are intentionally excluded. */
const DEFAULT_PROPERTIES = ['temperature', 'humidity', 'pressure']
/** Numeric history lifecycle and report ingestion. */
class SSensorHistoryService {
    /** Event unsubscription handle. @type {Function|null} */
    #unsubscribe = null
    /** Periodic retention timer. @type {ReturnType<typeof setInterval>|null} */
    #timer = null

    /** Subscribe before devices start receiving reports; prune hourly even in quiet periods.
     * @returns {Promise<void>} */
    async init() {
        if (this.#unsubscribe) return
        this.#unsubscribe = EventBus.subscribe('device:stateReported', (report) => {
            const config = ConfigService.get('sensor_history', {})
            if (config.enabled === false) return
            const properties = Array.isArray(config.properties) ? config.properties : DEFAULT_PROPERTIES
            const values = {}
            for (const property of properties) {
                const value = report.state?.[property]
                if (typeof value === 'number' && Number.isFinite(value)) values[property] = value
            }
            if (Object.keys(values).length) DatabaseService.recordSensorSample({ device: report.device, timestamp: report.timestamp, values })
        })
        this.#prune()
        this.#timer = setInterval(() => this.#prune(), 3_600_000)
        this.#timer.unref?.()
    }

    /** Release subscriptions and the retention timer before the database closes.
     * @returns {void} */
    stop() {
        this.#unsubscribe?.()
        this.#unsubscribe = null
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
    }

    /** Apply live retention configuration, defaulting to seven days.
     * @private
     * @returns {void} */
    #prune() {
        const ms = temporal.parseDurationMs(ConfigService.get('sensor_history.retention', '7d'))
        DatabaseService.pruneSensorSamples(ms > 0 ? ms : 7 * 86_400_000)
    }
}

/** Shared recorder singleton. */
const SensorHistoryService = Object.freeze(new SSensorHistoryService())
export default SensorHistoryService
