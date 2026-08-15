/**
 * Temporal utilities for time-of-day and season detection.
 *
 * Day-period boundaries (morning, noon, afternoon, evening, night) are
 * computed from average sunrise / sunset times for Central Europe (CET),
 * divided into four equal quarters of daylight. Evening is extended past
 * sunset by 2 h to account for twilight; night then spans until next sunrise.
 * Every hour 0-23 maps to exactly one period -- no gaps, no overlaps.
 *
 * The module exports a frozen singleton carrying:
 * - **Day-period predicates**: `isMorning()`, `isNoon()`, `isAfternoon()`,
 *   `isEvening()`, `isNight()`
 * - **Season predicates**: `isSpring()`, `isSummer()`, `isAutumn()`, `isWinter()`
 * - **Duration formatters**: `millisecondsToHumanReadable()`,
 *   `secondsToHumanReadable()`, `msToHuman()`
 * - **Convenience**: `getCurrentTimePeriod()`
 *
 * @module lib/date
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

// ---------------------------------------------------------------------------
// Season configuration
// ---------------------------------------------------------------------------

/**
 * Meteorological season ranges.
 *
 * Each entry maps a season name to `[fromMonth, toMonth]`
 * using zero-based month indices (January = 0).
 *
 * @type {Object}
 */
const SEASONS = {
    spring: [2, 4],    // Mar - May
    summer: [5, 7],    // Jun - Aug
    autumn: [8, 10],   // Sep - Nov
    winter: [11, 1],   // Dec - Feb (wraps)
}

// ---------------------------------------------------------------------------
// Monthly sunrise / sunset (average hours, Central Europe)
// ---------------------------------------------------------------------------

/**
 * Average sunrise and sunset hours per month for Central Europe.
 *
 * Indexed by month (0 = January). Values are whole-hour approximations
 * based on long-term averages for ~52degN latitude (Central Europe).
 *
 * Daylight is divided into four equal quarters to derive the boundaries
 * for morning, noon, afternoon, and evening. Night spans sunset -> sunrise.
 *
 * | Month   | Sunrise | Sunset | Daylight | Quarter |
 * |---------|---------|--------|----------|---------|
 * | January |    8:00 |  16:00 |    8 h   |   2 h   |
 * | February|    7:00 |  17:00 |   10 h   |   2.5 h |
 * | March   |    6:00 |  18:00 |   12 h   |   3 h   |
 * | April   |    6:00 |  19:00 |   13 h   |   3.25h |
 * | May     |    5:00 |  21:00 |   16 h   |   4 h   |
 * | June    |    5:00 |  21:00 |   16 h   |   4 h   |
 * | July    |    5:00 |  21:00 |   16 h   |   4 h   |
 * | August  |    5:00 |  20:00 |   15 h   |   3.75h |
 * | September|   6:00 |  19:00 |   13 h   |   3.25h |
 * | October |    7:00 |  17:00 |   10 h   |   2.5 h |
 * | November|    7:00 |  16:00 |    9 h   |   2.25h |
 * | December|    8:00 |  16:00 |    8 h   |   2 h   |
 *
 * @type {Array}
 */
const SUN_TIMES = [
    [8, 16],   // January
    [7, 17],   // February
    [6, 18],   // March
    [6, 19],   // April
    [5, 21],   // May
    [5, 21],   // June
    [5, 21],   // July
    [5, 20],   // August
    [6, 19],   // September
    [7, 17],   // October
    [7, 16],   // November
    [8, 16],   // December
]

/**
 * Hours to extend evening past sunset before night begins.
 * Accounts for twilight/dusk period when it's still partially light.
 */
const EVENING_EXTENSION_HOURS = 2

// ---------------------------------------------------------------------------
// STemporal Class
// ---------------------------------------------------------------------------

/**
 * Provides predicate methods for checking the current
 * time-of-day period and season.
 *
 * Day-period boundaries adapt to the current month based on
 * average sunrise / sunset for Central Europe.
 *
 * Methods are generated at class-definition time from the
 * {@link SEASONS} configuration and {@link SUN_TIMES} data.
 * @ignore
 */
class STemporal {

    // -- Private helpers ----------------------------------------------------

    /**
     * Derives period boundaries from sunrise and sunset by dividing
     * daylight into four equal quarters.
     * Evening is extended past sunset by {@link EVENING_EXTENSION_HOURS}
     * to account for twilight; night starts after the extension.
     *
     * The five periods form a continuous partition of hours 0-23:
     * each period's `from` equals the previous period's `to + 1`, so no
     * hour falls through a gap or matches two periods.
     *
     * @param {number} sunrise - Sunrise hour (0-23).
     * @param {number} sunset  - Sunset hour (0-23), must be > sunrise.
     * @returns {Object} Period map with morning, noon, afternoon, evening, night ranges
     * @private
     */
    #computePeriods(sunrise, sunset) {
        const daylight = sunset - sunrise
        const q = daylight / 4
        const nightStart = (sunset + EVENING_EXTENSION_HOURS) % 24

        // Continuous ranges -- no gaps between consecutive periods.
        // Each period's "from" equals the previous period's "to" + 1,
        // ensuring every hour 0-23 maps to exactly one period.
        const morningEnd = Math.round(sunrise + q)
        const noonEnd = Math.round(sunrise + 2 * q)
        const afternoonEnd = Math.round(sunrise + 3 * q)

        return {
            morning:   [sunrise, morningEnd],
            noon:      [morningEnd + 1, noonEnd],
            afternoon: [noonEnd + 1, afternoonEnd],
            evening:   [afternoonEnd + 1, nightStart - 1],
            night:     [nightStart, sunrise - 1],
        }
    }

    /**
     * Checks whether a given hour falls within a range,
     * handling midnight-wrapping ranges (e.g. night: 21 -> 4).
     *
     * @param {number} h  - The hour to check (0-23).
     * @param {number} from - Start boundary (inclusive).
     * @param {number} to   - End boundary (inclusive).
     * @returns {boolean}
     * @private
     */
    #inHourRange(h, from, to) {
        return from <= to
        ? h >= from && h <= to
        : h >= from || h <= to
    }

    /**
     * Checks whether a given month falls within a range,
     * handling year-wrapping ranges (e.g. winter: 11 -> 1).
     *
     * @param {number} m  - The month to check (0-11).
     * @param {number} from - Start month index (inclusive).
     * @param {number} to   - End month index (inclusive).
     * @returns {boolean}
     * @private
     */
    #inMonthRange(m, from, to) {
        return from <= to
        ? m >= from && m <= to
        : m >= from || m <= to
    }

    // -- Day period predicates ----------------------------------------------

    /**
     * Check if the current hour is morning.
     * @returns {boolean}
     */
    isMorning() {
        return this.#checkPeriod('morning')
    }

    /**
     * Check if the current hour is noon.
     * @returns {boolean}
     */
    isNoon() {
        return this.#checkPeriod('noon')
    }

    /**
     * Check if the current hour is afternoon.
     * @returns {boolean}
     */
    isAfternoon() {
        return this.#checkPeriod('afternoon')
    }

    /**
     * Check if the current hour is evening.
     * @returns {boolean}
     */
    isEvening() {
        return this.#checkPeriod('evening')
    }

    /**
     * Check if the current hour is night.
     * @returns {boolean}
     */
    isNight() {
        return this.#checkPeriod('night')
    }

    /**
     * Internal helper to check a specific day period.
     *
     * @param {'morning'|'noon'|'afternoon'|'evening'|'night'} period
     * @returns {boolean}
     * @private
     */
    #checkPeriod(period) {
        const now = new Date()
        const h = now.getHours()
        const m = now.getMonth()
        const [sunrise, sunset] = SUN_TIMES[m]
        const periods = this.#computePeriods(sunrise, sunset)
        const [from, to] = periods[period]
        return this.#inHourRange(h, from, to)
    }

    // -- Season predicates --------------------------------------------------

    /**
     * Check if the current month is spring (Mar-May).
     * @returns {boolean}
     */
    isSpring() {
        return this.#checkSeason('spring')
    }

    /**
     * Check if the current month is summer (Jun-Aug).
     * @returns {boolean}
     */
    isSummer() {
        return this.#checkSeason('summer')
    }

    /**
     * Check if the current month is autumn (Sep-Nov).
     * @returns {boolean}
     */
    isAutumn() {
        return this.#checkSeason('autumn')
    }

    /**
     * Check if the current month is winter (Dec-Feb).
     * @returns {boolean}
     */
    isWinter() {
        return this.#checkSeason('winter')
    }

    /**
     * Internal helper to check a specific season.
     *
     * @param {string} seasonName - Season key from SEASONS config
     * @returns {boolean}
     * @private
     */
    #checkSeason(seasonName) {
        const [from, to] = SEASONS[seasonName]
        return this.#inMonthRange(new Date().getMonth(), from, to)
    }

    // -- Duration formatting ------------------------------------------------

    /**
     * Format a duration in milliseconds into a compact, human-readable string.
     * Used for logging timer intervals, debounce windows, reconnect delays, etc.
     * Only non-zero units are shown. Seconds are always included as the smallest unit.
     *
     * Examples: "300ms", "1sec 200ms", "45sec", "2min 30sec", "1h 5min", "3d 12h"
     *
     * @param {number} ms - Duration in milliseconds (non-negative integer)
     * @returns {string} Human-readable duration string
     */
    millisecondsToHumanReadable(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '0ms'
        if (ms === 0) return '0ms'

        const days = Math.floor(ms / 86_400_000)
        const hours = Math.floor((ms % 86_400_000) / 3_600_000)
        const minutes = Math.floor((ms % 3_600_000) / 60_000)
        const seconds = Math.floor((ms % 60_000) / 1_000)
        const millis = ms % 1_000

        // If sub-second, show only milliseconds
        if (ms < 1_000) return `${ms}ms`

        const parts = []
        if (days > 0) parts.push(`${days}d`)
        if (hours > 0) parts.push(`${hours}h`)
        if (minutes > 0) parts.push(`${minutes}min`)
        if (seconds > 0) parts.push(`${seconds}sec`)
        // Milliseconds only shown when no larger units present and value is small
        else if (parts.length === 0 && millis > 0) parts.push(`${millis}ms`)

        return parts.join(' ')
    }

    /**
     * Format a duration in whole seconds into a compact, human-readable string.
     * Used for countdowns and cooldown-remaining displays.
     * Only non-zero units are shown; seconds always included as the smallest unit.
     *
     * Examples: "30sec", "12min 34sec", "1h 5min 12sec"
     *
     * @param {number} totalSeconds - Duration in seconds (non-negative integer)
     * @returns {string} Human-readable duration string
     */
    secondsToHumanReadable(totalSeconds) {
        if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0sec'
        if (totalSeconds === 0) return '0sec'

        const hours = Math.floor(totalSeconds / 3600)
        const minutes = Math.floor((totalSeconds % 3600) / 60)
        const seconds = totalSeconds % 60
        const parts = []
        if (hours > 0) parts.push(`${hours}h`)
        if (minutes > 0) parts.push(`${minutes}min`)
        parts.push(`${seconds}sec`)
        return parts.join(' ')
    }

    /**
     * Convert milliseconds to a compact "every Xs/m/h" interval string.
     * Returns 'disabled' for zero/negative/missing values.
     * Used by UI commands to display timer intervals.
     *
     * @param {number} ms - Timer interval in milliseconds
     * @returns {string} e.g. "every 5s", "every 5m", "every 2h", or "disabled"
     */
    msToHuman(ms) {
        if (!ms || ms <= 0) return 'disabled'
        const secs = Math.round(ms / 1_000)
        if (secs < 60) return `every ${secs}s`
        const mins = Math.round(secs / 60)
        if (mins < 60) return `every ${mins}m`
        const hours = Math.round(mins / 60)
        return `every ${hours}h`
    }

    // -- Convenience --------------------------------------------------------

    /**
     * Return a human-readable string for the current time-of-day period.
     * Checks each period predicate and returns the first one that matches.
     *
     * @returns {'morning'|'noon'|'afternoon'|'evening'|'night'|null} The matching period or null.
     */
    getCurrentTimePeriod() {
        if (this.isMorning()) return 'morning'
        if (this.isNoon()) return 'noon'
        if (this.isAfternoon()) return 'afternoon'
        if (this.isEvening()) return 'evening'
        if (this.isNight()) return 'night'
        return null
    }
}

// ---------------------------------------------------------------------------
// Export frozen singleton
// ---------------------------------------------------------------------------

/**
 * Frozen singleton instance providing temporal utilities.
 *
 * All day-period and season predicates use the current system clock;
 * duration formatters accept numeric arguments.
 */
export default Object.freeze(new STemporal())
