/**
 * Solar event helpers backed by the sunrise-sunset-js library.
 * Wraps the NREL-based solar-position math so rule automations can reference real.
 * @module lib/sun
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

import { getSunTimes } from 'sunrise-sunset-js'

import ConfigService from '../service/configService.js'
import LoggerService from '../service/loggerService.js'
import temporal from './date.js'

/** Solar-event provider singleton. */
class SSolar {
    /** Memoization slot for the most recent computation: `{key, sundawn, sundusk, sunrise, sunset}`.
     * @type {{key: string, sundawn: Date|null, sundusk: Date|null, sunrise: Date|null, sunset: Date|null}|null} */
    #cache = null

    /** Read and sanity-check the configured observer coordinates.
     * @private
     * @returns {{latitude: number, longitude: number}|null} Coordinates, or null when absent/invalid/out of range. */
    #getCoordinates() {
        const latitude = Number(ConfigService.get('locale.geo_latitude'))
        const longitude = Number(ConfigService.get('locale.geo_longitude'))
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
        if (latitude < -90 || latitude > 90) return null
        if (longitude < -180 || longitude > 180) return null
        return { latitude, longitude }
    }

    /** Resolve the dawn/dusk instants for a moment's calendar day at the configured location.
     * @param {Date} [date=new Date()] - Moment whose calendar day to evaluate.
     * @returns {{sundawn: Date|null, sundusk: Date|null}} Dawn and dusk instants (or nulls). */
    getSunTimes(date = new Date()) {
        const entry = this.#resolveDay(date)
        return { sundawn: entry.sundawn, sundusk: entry.sundusk }
    }

    /** Resolve the raw sunrise/sunset instants for a moment's calendar day at the configured location.
     * @param {Date} [date=new Date()] - Moment whose calendar day to evaluate.
     * @returns {{sunrise: Date|null, sunset: Date|null}} Sunrise and sunset instants (or nulls). */
    getSunriseSunset(date = new Date()) {
        const entry = this.#resolveDay(date)
        return { sunrise: entry.sunrise, sunset: entry.sunset }
    }

    /** Compute (or return the memoized) solar instants for one calendar day.
     * @private
     * @param {Date} date - Moment whose calendar day to evaluate.
     * @returns {{sundawn: Date|null, sundusk: Date|null, sunrise: Date|null, sunset: Date|null}} Solar instants (nulls where undefined). */
    #resolveDay(date) {
        const coords = this.#getCoordinates()
        if (coords === null) return { sundawn: null, sundusk: null, sunrise: null, sunset: null }

        const cacheKey = `${temporal.getLocalDayString(date)}:${coords.latitude}:${coords.longitude}`
        if (this.#cache !== null && this.#cache.key === cacheKey) return this.#cache

        let result = { sundawn: null, sundusk: null, sunrise: null, sunset: null }
        try {
            const times = getSunTimes(coords.latitude, coords.longitude, date)
            const sunrise = times?.sunrise ?? null
            const sunset = times?.sunset ?? null
            result = {
                sundawn: times?.twilight?.civilDawn ?? sunrise,
                sundusk: times?.twilight?.civilDusk ?? sunset,
                sunrise,
                sunset,
            }
        } catch (error) {
            LoggerService.warn(`Failed to compute sun times for ${coords.latitude},${coords.longitude}: ${error.message}`, 'Solar')
        }
        this.#cache = { key: cacheKey, ...result }
        return result
    }
}

//  Export frozen singleton.

/** Frozen singleton providing solar-event lookups for rule automations. */
export default Object.freeze(new SSolar())