/**
 * Solar event helpers backed by the sunrise-sunset-js library.
 *
 * Wraps the NREL-based solar-position math so rule automations can reference real
 * dawn/dusk instants ("sundawn"/"sundusk") without each one re-implementing the
 * astronomy. Dawn/dusk are the civil-twilight boundaries (sun 6 degrees below the horizon
 * -- the point at which the outside is bright enough to work by), falling back to the
 * geometric sunrise/sunset on the polar days where civil twilight is undefined; daylight
 * gating wants civil twilight, not geometric sunrise, which runs up to ~25 minutes later
 * at mid-northern latitudes and far longer through the deep-twilight winter months.
 * Observer coordinates are read from the main configuration's
 * `locale.geo_latitude` / `locale.geo_longitude`; results are memoized per local calendar day +
 * coordinate pair so repeated ticks across many automations stay cheap. The module
 * degrades gracefully -- missing/invalid coordinates or polar no-rise/no-set days
 * yield nulls (never throw) so callers fail closed rather than crash a tick.
 *
 * @module lib/sun
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

import { getSunTimes } from 'sunrise-sunset-js'

import ConfigService from '../service/configService.js'
import LoggerService from '../service/loggerService.js'
import temporal from './date.js'

/**
 * Solar-event provider singleton.
 *
 * Reads observer coordinates lazily from the main config and resolves today's
 * dawn/dusk instants through sunrise-sunset-js, caching per day+location.
 */
class SSolar {
    /**
     * Memoization slot for the most recent computation: `{key, sundawn, sundusk}`.
     * Keyed by local calendar day + coordinate pair; replaced whenever either changes.
     * @type {{key: string, sundawn: Date|null, sundusk: Date|null}|null}
     */
    #cache = null

    /**
     * Read and sanity-check the configured observer coordinates.
     * @private
     * @returns {{latitude: number, longitude: number}|null} Coordinates, or null when absent/invalid/out of range.
     */
    #getCoordinates() {
        const latitude = Number(ConfigService.get('locale.geo_latitude'))
        const longitude = Number(ConfigService.get('locale.geo_longitude'))
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
        if (latitude < -90 || latitude > 90) return null
        if (longitude < -180 || longitude > 180) return null
        return { latitude, longitude }
    }

    /**
     * Resolve the dawn/dusk instants for a moment's calendar day at the configured location.
     *
     * Dawn/dusk are civil-twilight boundaries (start/end of civil twilight), each falling
     * back to the geometric sunrise/sunset when civil twilight is undefined that day.
     * Returns absolute-instant `Date` objects (compare via `.getTime()` against `new Date()`);
     * each is null when the sun does not rise/set that day (polar conditions). Memoized per
     * local-day + coordinate pair. Never throws -- unconfigured/invalid geo yields both-null.
     *
     * @param {Date} [date=new Date()] - Moment whose calendar day to evaluate.
     * @returns {{sundawn: Date|null, sundusk: Date|null}} Dawn and dusk instants (or nulls).
     */
    getSunTimes(date = new Date()) {
        const coords = this.#getCoordinates()
        if (coords === null) return { sundawn: null, sundusk: null }

        const cacheKey = `${temporal.getLocalDayString(date)}:${coords.latitude}:${coords.longitude}`
        if (this.#cache !== null && this.#cache.key === cacheKey) return this.#cache

        let result = { sundawn: null, sundusk: null }
        try {
            const times = getSunTimes(coords.latitude, coords.longitude, date)
            result = {
                sundawn: times?.twilight?.civilDawn ?? times?.sunrise ?? null,
                sundusk: times?.twilight?.civilDusk ?? times?.sunset ?? null,
            }
        } catch (error) {
            LoggerService.warn(`Failed to compute sun times for ${coords.latitude},${coords.longitude}: ${error.message}`, 'Solar')
        }
        this.#cache = { key: cacheKey, ...result }
        return result
    }
}

// ---------------------------------------------------------------------------
// Export frozen singleton
// ---------------------------------------------------------------------------

/**
 * Frozen singleton providing solar-event lookups for rule automations.
 */
export default Object.freeze(new SSolar())