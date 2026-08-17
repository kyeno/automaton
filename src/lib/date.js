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
 *   `secondsToHumanReadable()`, `msToHuman()`, `msToHumanPhrase()`
 * - **Duration parsing**: `humanToMs()`, `parseDurationMs()`
 * - **Convenience**: `getCurrentTimePeriod()`, `getCurrentSeason()`,
 *   `getLocalDayString()`
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
// Duration unit factors (shared by msToHumanPhrase / humanToMs)
// ---------------------------------------------------------------------------

/**
 * Milliseconds per supported duration unit, keyed by the single-letter token
 * used in human-readable strings ("1h", "3m 45s"). The bundle-key mapping
 * (day/hour/minute/second -> d/h/m/s) is kept at call sites so i18n bundles
 * can name their own words freely.
 *
 * @type {Record<string, number>}
 */
const DURATION_UNIT_MS = Object.freeze({
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
})

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
 * All predicates are defined explicitly below so they show up in IDE
 * autocompletion, survive minification, and get individual pages in the
 * generated API docs. Each one delegates to the private #checkPeriod() or
 * #checkSeason() helper which reads the {@link SEASONS} configuration and
 * {@link SUN_TIMES} data.
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

    /**
     * Convert milliseconds into a localized, speech-oriented duration phrase such as
     * "2 hours" or "1 godzin 30 minut". Unlike {@link msToHuman}, this method is meant for
     * spoken / LLM-facing output: unit words are supplied by the caller (typically an i18n
     * bundle), so this module stays language-agnostic and grammatical agreement for specific
     * counts (e.g., Polish case endings) is left to downstream consumers such as the small
     * model that rewrites the final sentence.
     *
     * The largest adjacent unit pair whose bigger count is at least 1 wins
     * (day+hour -> hour+minute -> minute+second). The smaller part is appended only when it
     * makes up a significant remainder (>= max(half a small unit, 10% of the big unit)), so
     * clean values stay single-unit ("1 hours") while e.g. 90 s reads "1 minutes 30 seconds"
     * instead of a misleading rounded "2 minutes". Sub-second values fall back to a rounded
     * second count; null is returned when nothing resolves.
     *
     * @param {number} ms - Duration in milliseconds (positive finite value)
     * @param {{day?: string, hour?: string, minute?: string, second?: string}} [units]
     *   Localized unit words keyed by canonical English singular names, e.g.
     *   `{ day: 'dni', hour: 'godzin' }`. Missing/empty words skip that unit.
     * @returns {string|null} e.g. "5 hours 30 minutes"; null for invalid input or when no
     *   usable unit word can express the duration.
     */
    msToHumanPhrase(ms, units = {}) {
        if (!Number.isFinite(ms) || !(ms > 0)) return null

        const pairs = [
            ['day', 'hour', 'd', 'h'],
            ['hour', 'minute', 'h', 'm'],
            ['minute', 'second', 'm', 's'],
        ]
        for (const [bigKey, smallKey, bigLetter, smallLetter] of pairs) {
            const bigMs = DURATION_UNIT_MS[bigLetter]
            const bigCount = Math.floor(ms / bigMs)
            if (bigCount < 1) continue
            const bigWord = units?.[bigKey]
            if (typeof bigWord !== 'string' || !bigWord.trim()) continue

            let phrase = `${bigCount} ${bigWord.trim()}`
            const smallMs = DURATION_UNIT_MS[smallLetter]
            const remainder = ms - bigCount * bigMs
            if (remainder >= Math.max(smallMs / 2, bigMs * 0.1)) {
                const smallWord = units?.[smallKey]
                if (typeof smallWord === 'string' && smallWord.trim()) {
                    const smallCount = Math.round(remainder / smallMs)
                    if (smallCount >= 1) phrase += ` ${smallCount} ${smallWord.trim()}`
                }
            }
            return phrase
        }

        // Sub-second values (or only a second word available).
        const secCount = Math.round(ms / DURATION_UNIT_MS.s)
        const secWord = units?.second
        if (secCount >= 1 && typeof secWord === 'string' && secWord.trim()) {
            return `${secCount} ${secWord.trim()}`
        }
        return null
    }


    /**
     * Parse a human-readable duration string into milliseconds -- the inverse of the
     * compact formatters above, intended for config files (`timer_interval: "3m 45s"`).
     *
     * Grammar: one or more whitespace-separated "<integer><unit>" tokens where the unit
     * is `d` (days), `h` (hours), `m` (minutes) or `s` (seconds); case-insensitive.
     * Examples: `"90s"`, `"3m 45s"`, `"1h"`, `"2d 4h"`. Bare numbers are rejected on
     * purpose so that units stay explicit and unambiguous.
     *
     * @param {string} text - Human-readable duration, e.g. "1h" or "3m 45s"
     * @returns {number|null} Total milliseconds; null when the input is not a string,
     *   is empty/malformed, or overflows Number.MAX_SAFE_INTEGER. Callers responsible
     *   for timers should additionally enforce their own upper bound (see AutomationBase).
     */
    humanToMs(text) {
        if (typeof text !== 'string') return null
        const trimmed = text.trim()
        if (!/^(\d+[dhms]\s*)+$/i.test(trimmed)) return null

        let total = 0
        for (const match of trimmed.matchAll(/(\d+)\s*([dhms])/gi)) {
            total += parseInt(match[1], 10) * DURATION_UNIT_MS[match[2].toLowerCase()]
            if (!Number.isSafeInteger(total)) return null
        }
        return total
    }

    /**
     * Resolve a config duration value into milliseconds, accepting either a legacy
     * plain number (already milliseconds) or a human-readable string parsed via
     * humanToMs(). Pure helper for polymorphic config keys such as
     * `timer_interval` and `human_interaction_cooldown_ms`; callers are responsible
     * for validating bounds and applying their own fallbacks on null.
     *
     * @param {number|string|null|undefined} value - Raw config value
     * @returns {number|null} Milliseconds; null when the value is missing, not a
     *   finite number / well-formed duration string, or overflows safe integers.
     */
    parseDurationMs(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null
        if (typeof value === 'string') return this.humanToMs(value)
        return null
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

    /**
     * Return a human-readable string for the current season.
     * Every month maps to exactly one meteorological season, so this always resolves.
     * @returns {'spring'|'summer'|'autumn'|'winter'} The matching season name.
     */
    getCurrentSeason() {
        if (this.isSpring()) return 'spring'
        if (this.isSummer()) return 'summer'
        if (this.isAutumn()) return 'autumn'
        return 'winter'
    }

    /**
     * Format a date as its local calendar-day string "YYYY-MM-DD".
     * Uses local time components (not UTC) so day boundaries follow the system timezone;
     * used e.g. by automation daily "once" markers.
     * @param {Date} [date=new Date()] - Date to format
     * @returns {string} Local day in ISO-like "YYYY-MM-DD" form
     */
    getLocalDayString(date = new Date()) {
        const y = date.getFullYear()
        const m = String(date.getMonth() + 1).padStart(2, '0')
        const d = String(date.getDate()).padStart(2, '0')
        return `${y}-${m}-${d}`
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
