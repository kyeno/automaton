/**
 * Durable local daylight evidence collection, independent of weather speech.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from './configService.js'
import DatabaseService from './databaseService.js'

/** Local observation collection; predictions never become human labels. */
class SDaylightService {
    /** Read the explicit installation configuration.
     * @returns {object} Live daylight configuration. */
    config() {
        return ConfigService.get('daylight', {})
    }

    /** Capture immutable context so future feature extraction can reproduce geometry.
     * @returns {object} Versioned context, including absent coordinates. */
    context() {
        return {
            schema: 1,
            latitude: ConfigService.get('locale.geo_latitude', null),
            longitude: ConfigService.get('locale.geo_longitude', null),
            sensors: this.config().sensors ?? [],
        }
    }

    /** Compare one installation without invalidating east evidence when west is added.
     * @param {object} context - Historical location and sensor snapshot.
     * @param {object} sensor - Currently configured sensor.
     * @returns {boolean} Whether the sensor's installation and location match. */
    matchesSensor(context, sensor) {
        const current = this.context()
        return context.latitude === current.latitude && context.longitude === current.longitude
            && JSON.stringify(context.sensors.find(s => s.id === sensor.id)) === JSON.stringify(sensor)
    }

    /** Current sky estimate contract for consumers; collection alone cannot classify.
     * @param {number} [at=Date.now()] - Evaluation instant.
     * @returns {object} Unknown until a fitted, validated model is implemented. */
    estimate(at = Date.now()) {
        return { state: 'unknown', timestamp: at, evidenceAgeMs: null, reason: 'model_not_fitted', modelVersion: null }
    }

    /** Archive only actual configured property reports, including invalid values.
     * @param {object} report - Received device report.
     * @returns {void} */
    record(report) {
        if (this.config().recording_enabled !== true || !Number.isFinite(report.timestamp)) return
        const context = this.context()
        for (const sensor of context.sensors) {
            if (sensor.device !== report.device || !Object.hasOwn(report.state ?? {}, sensor.property)) continue
            const value = report.state[sensor.property]
            DatabaseService.recordDaylightEvent('sample', {
                timestamp: report.timestamp, enteredAt: Date.now(), context, sensorId: sensor.id,
                value: typeof value === 'number' && Number.isFinite(value) ? value : null,
                quality: typeof value !== 'number' || !Number.isFinite(value) || value < 0 ? 'invalid'
                    : Number.isFinite(sensor.max_lux) && value >= sensor.max_lux ? 'clipped' : 'usable',
            })
        }
    }

    /** Replay the small human-label audit trail, excluding undone observations.
     * @returns {object[]|null} Active observations, or null if unavailable. */
    observations() {
        const events = DatabaseService.daylightLabels()
        if (events === null) return null
        const undone = new Set(events.filter(e => e.kind === 'undo').map(e => e.observationId))
        return events.filter(e => e.kind === 'observation' && !undone.has(e.id))
    }

    /** Save a point-in-time label with its own durable evidence snapshot.
     * Same-label repeats within five minutes are ignored; different labels remain distinct.
     * @param {string} label - Human sky observation.
     * @param {number} [at=Date.now()] - Observation instant in epoch milliseconds.
     * @returns {string} Short truthful acknowledgment. */
    observe(label, at = Date.now()) {
        if (this.config().recording_enabled !== true) return 'Daylight recording is disabled (daylight.recording_enabled).'
        const observations = this.observations()
        if (observations === null) return 'Not saved: daylight database unavailable.'
        const context = this.context()
        const latest = observations.at(-1)
        if (latest?.label === label && at >= latest.timestamp && at - latest.timestamp < 300000
            && JSON.stringify(latest.context) === JSON.stringify(context)) return `Already saved: ${label}.`
        const evidence = DatabaseService.daylightSamples(at - 900000, at)
        if (evidence === null) return 'Not saved: daylight evidence could not be read.'
        const sensors = context.sensors.map(sensor => {
            const samples = evidence.filter(e => e.sensorId === sensor.id && this.matchesSensor(e.context, sensor))
            const latest = samples.at(-1)
            const maxAge = Number.isFinite(sensor.max_age_seconds) && sensor.max_age_seconds > 0 ? sensor.max_age_seconds * 1000 : 300000
            return { id: sensor.id, samples, ageMs: latest ? at - latest.timestamp : null,
                usable: Boolean(latest && latest.quality === 'usable' && at - latest.timestamp <= maxAge) }
        })
        const id = DatabaseService.recordDaylightEvent('observation', {
            timestamp: at, enteredAt: Date.now(), label, source: 'human', context,
            featureVersion: null, windowMs: 900000, sensors,
        })
        if (id === null) return 'Not saved: daylight database write failed.'
        return `Saved: ${label}.${sensors.some(s => s.usable) ? '' : ' No usable fresh sensor data.'}`
    }

    /** Undo the most recent active observation while retaining the audit trail.
     * @returns {string} Result. */
    undo() {
        const observations = this.observations()
        if (observations === null) return 'Daylight database unavailable.'
        const latest = observations.at(-1)
        if (!latest) return 'No observation to undo.'
        return DatabaseService.recordDaylightEvent('undo', { observationId: latest.id, enteredAt: Date.now() }) === null
            ? 'Undo failed: database write failed.' : `Undone: ${latest.label}.`
    }

    /** Report collection state without implying an untrained prediction.
     * @returns {string} Compact diagnostics. */
    status() {
        const observations = this.observations()
        const samples = DatabaseService.daylightSamples(Date.now() - 900000, Date.now())
        return `Recording: ${this.config().recording_enabled === true ? 'enabled' : 'disabled'}. Weatherman sky: ${this.config().announcements_enabled === true ? 'enabled' : 'disabled'}. Observations: ${observations?.length ?? 'unavailable'}. Estimate: unknown (model not fitted).\n`
            + (this.context().sensors.map(s => {
                const latest = samples?.filter(e => e.sensorId === s.id && this.matchesSensor(e.context, s)).at(-1)
                return `${s.id}: ${latest ? `${latest.value} lux, ${Math.round((Date.now() - latest.timestamp) / 1000)}s old, ${latest.quality}` : 'no reports in last 15 minutes'}`
            }).join('\n') || 'No daylight sensors configured.')
    }
}

/** Shared calibration collector. */
const DaylightService = Object.freeze(new SDaylightService())
export default DaylightService
