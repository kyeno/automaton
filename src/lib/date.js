/**
 * Temporal utilities for time-of-day and season detection.
 * Day periods (morning, noon, afternoon, evening, night) use fixed round-clock.
 * @module lib/date
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { parseDocument as yamlParseDocument } from 'yaml'

import I18nLoader from '../service/i18nLoader.js'
import LoggerService from '../service/loggerService.js'
import { PROJECT_ROOT } from './projectRoot.js'
import { clockWords as polishClockWords } from './polish.js'


/** Root directory containing per-locale i18n subdirectories (holds date.yaml). */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

//  Season configuration.

/** Meteorological season ranges.
 * @type {Object} */
const SEASONS = {
    spring: [2, 4],    // Mar - May
    summer: [5, 7],    // Jun - Aug
    autumn: [8, 10],   // Sep - Nov
    winter: [11, 1],   // Dec - Feb (wraps)
}

//  Named clock anchors accepted as `hour:` bounds. The hour axis runs 00:00 -> 23:59, so
//  `midnight` is its floor (0) and `noon` is 12:00; they let a rule name the boundary it means
//  instead of guessing which numeric spelling (0, '00:00', '0000') the author intended.
/** @type {Record<string, number>} */
const CLOCK_WORD_HOURS = { midnight: 0, noon: 12 }

//  Sun-event anchors accepted as `hour:` bounds -- a named sun instant shifted by a fixed offset.
//  'predusk' is sunset minus 30 minutes: the moment lamps are worth switching on, so a rule
//  can say "dusk, a little before" instead of hard-coding a clock time that drifts by hours
//  across the year. Like the sun shorthands they resolve against the solar instants from
//  lib/sun, so an unconfigured location leaves them unresolvable and the gate fails closed.
/** Offset in hours from the sun instant each anchor hangs on (negative = earlier).
 * @type {Record<string, number>} */
const SUN_OFFSET_ANCHORS = Object.freeze({ predusk: -0.5 })

//  Day-period partition (fixed round-clock boundaries)

/** Fixed day-period partition of hours 0-23 -- identical every month of the year.
 * @type {Record<string, [number, number]>} */
const DAY_PERIODS = Object.freeze({
    morning:   [5, 10],
    noon:      [11, 12],
    afternoon: [13, 17],
    evening:   [18, 23],
    night:     [0, 4],
})

//  Duration unit factors (shared by msToHumanPhrase / humanToMs)

/** Milliseconds per supported duration unit, keyed by the unit token ('ms' = milliseconds;
 * d/h/m/s are single letters).
 * @type {Record<string, number>} */
const DURATION_UNIT_MS = Object.freeze({
    ms: 1,
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
})

//  STemporal Class.

/** Provides predicate methods for checking the current. */
class STemporal {
    /** @type {Record<string, unknown>|null} Cached date.yaml bundle (null = not loaded / failed). */
    #dateBundle = null

    /** @type {string|null} Locale the cached date bundle was loaded for. */
    #dateBundleLocale = null

    //  -- Private helpers ----------------------------------------------------

    /** Checks whether a given hour falls within a range.
     * @param {number} h  - The hour to check (0-23).
     * @param {number} from - Start boundary (inclusive).
     * @param {number} to   - End boundary (inclusive).
     * @returns {boolean}
     * @private */
    #inHourRange(h, from, to) {
        return from <= to
        ? h >= from && h <= to
        : h >= from || h <= to
    }

    /** Checks whether a given month falls within a range.
     * @param {number} m  - The month to check (0-11).
     * @param {number} from - Start month index (inclusive).
     * @param {number} to   - End month index (inclusive).
     * @returns {boolean}
     * @private */
    #inMonthRange(m, from, to) {
        return from <= to
        ? m >= from && m <= to
        : m >= from || m <= to
    }

    //  -- Day period predicates ----------------------------------------------

    /** Check whether a given moment falls in the morning period.
     * @param {Date} [date=new Date()] - Moment to evaluate; defaults to the current time
     * @returns {boolean} */
    isMorning(date) {
        return this.#checkPeriod('morning', date)
    }

    /** Check whether a given moment falls in the noon period.
     * @param {Date} [date=new Date()] - Moment to evaluate; defaults to the current time
     * @returns {boolean} */
    isNoon(date) {
        return this.#checkPeriod('noon', date)
    }

    /** Check whether a given moment falls in the afternoon period.
     * @param {Date} [date=new Date()] - Moment to evaluate; defaults to the current time
     * @returns {boolean} */
    isAfternoon(date) {
        return this.#checkPeriod('afternoon', date)
    }

    /** Check whether a given moment falls in the evening period.
     * @param {Date} [date=new Date()] - Moment to evaluate; defaults to the current time
     * @returns {boolean} */
    isEvening(date) {
        return this.#checkPeriod('evening', date)
    }

    /** Check whether a given moment falls in the night period.
     * @param {Date} [date=new Date()] - Moment to evaluate; defaults to the current time
     * @returns {boolean} */
    isNight(date) {
        return this.#checkPeriod('night', date)
    }

    /** Internal helper to check a specific day period at a given moment.
     * @param {'morning'|'noon'|'afternoon'|'evening'|'night'} period
     * @param {Date} [now=new Date()] - Moment to evaluate
     * @returns {boolean}
     * @private */
    #checkPeriod(period, now = new Date()) {
        const range = DAY_PERIODS[period]
        if (!range) return false
        const [from, to] = range
        return this.#inHourRange(now.getHours(), from, to)
    }

    //  -- Season predicates --------------------------------------------------

    /** Check if the current month is spring (Mar-May).
     * @returns {boolean} */
    isSpring() {
        return this.#checkSeason('spring')
    }

    /** Check if the current month is summer (Jun-Aug).
     * @returns {boolean} */
    isSummer() {
        return this.#checkSeason('summer')
    }

    /** Check if the current month is autumn (Sep-Nov).
     * @returns {boolean} */
    isAutumn() {
        return this.#checkSeason('autumn')
    }

    /** Check if the current month is winter (Dec-Feb).
     * @returns {boolean} */
    isWinter() {
        return this.#checkSeason('winter')
    }

    /** Internal helper to check a specific season.
     * @param {string} seasonName - Season key from SEASONS config
     * @returns {boolean}
     * @private */
    #checkSeason(seasonName) {
        const [from, to] = SEASONS[seasonName]
        return this.#inMonthRange(new Date().getMonth(), from, to)
    }

    //  -- Duration formatting ------------------------------------------------

    /** Format a duration in milliseconds into a compact, human-readable string.
     * @param {number} ms - Duration in milliseconds (non-negative integer)
     * @returns {string} Human-readable duration string */
    millisecondsToHumanReadable(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '0ms'
        if (ms === 0) return '0ms'

        const days = Math.floor(ms / 86_400_000)
        const hours = Math.floor((ms % 86_400_000) / 3_600_000)
        const minutes = Math.floor((ms % 3_600_000) / 60_000)
        const seconds = Math.floor((ms % 60_000) / 1_000)
        const millis = ms % 1_000

        //  If sub-second, show only milliseconds.
        if (ms < 1_000) return `${ms}ms`

        const parts = []
        if (days > 0) parts.push(`${days}d`)
        if (hours > 0) parts.push(`${hours}h`)
        if (minutes > 0) parts.push(`${minutes}min`)
        if (seconds > 0) parts.push(`${seconds}sec`)
        //  Milliseconds only shown when no larger units present and value is small.
        else if (parts.length === 0 && millis > 0) parts.push(`${millis}ms`)

        return parts.join(' ')
    }

    /** Format a duration in whole seconds into a compact, human-readable string.
     * @param {number} totalSeconds - Duration in seconds (non-negative integer)
     * @returns {string} Human-readable duration string */
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

    /** Convert milliseconds to a compact "every Xs/m/h" interval string.
     * @param {number} ms - Timer interval in milliseconds
     * @returns {string} e.g. "every 5s", "every 5m", "every 2h", or "disabled" */
    msToHuman(ms) {
        if (!ms || ms <= 0) return 'disabled'
        const secs = Math.round(ms / 1_000)
        if (secs < 60) return `every ${secs}s`
        const mins = Math.round(secs / 60)
        if (mins < 60) return `every ${mins}m`
        const hours = Math.round(mins / 60)
        return `every ${hours}h`
    }

    /** Convert milliseconds into a localized, speech-oriented duration phrase such.
     * @param {number} ms - Duration in milliseconds (positive finite value)
     * @param {{day?: string, hour?: string, minute?: string, second?: string}} [units]
     * @returns {string|null} e.g. "5 hours 30 minutes"; null for invalid input or when no */
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

        //  Sub-second values (or only a second word available).
        const secCount = Math.round(ms / DURATION_UNIT_MS.s)
        const secWord = units?.second
        if (secCount >= 1 && typeof secWord === 'string' && secWord.trim()) {
            return `${secCount} ${secWord.trim()}`
        }
        return null
    }


    /** Parse a human-readable duration string into milliseconds.
     * @param {string} text - Human-readable duration, e.g. "500ms", "1h" or "3m 45s".
     *                        Components may be space-separated; a number and its unit must
     *                        be adjacent, so "1 h" is not a duration.
     * @returns {number|null} Total milliseconds; null when the input is not a string, */
    humanToMs(text) {
        if (typeof text !== 'string') return null
        const trimmed = text.trim()
        if (!/^(\d+(?:ms|[dhms])\s*)+$/i.test(trimmed)) return null

        let total = 0
        for (const match of trimmed.matchAll(/(\d+)\s*(ms|[dhms])/gi)) {
            total += parseInt(match[1], 10) * DURATION_UNIT_MS[match[2].toLowerCase()]
            if (!Number.isSafeInteger(total)) return null
        }
        return total
    }

    /** Resolve a config duration value into milliseconds, accepting either a legacy.
     * @param {number|string|null|undefined} value - Raw config value
     * @returns {number|null} Milliseconds; null when the value is missing, not a */
    parseDurationMs(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null
        if (typeof value === 'string') return this.humanToMs(value)
        return null
    }

    //  -- Convenience --------------------------------------------------------

    /** Return a human-readable string for the time-of-day period at a given moment.
     * @param {Date} [date=new Date()] - Moment to evaluate; defaults to the current time
     * @returns {'morning'|'noon'|'afternoon'|'evening'|'night'|null} The matching period or null. */
    getCurrentTimePeriod(date = new Date()) {
        if (this.isMorning(date)) return 'morning'
        if (this.isNoon(date)) return 'noon'
        if (this.isAfternoon(date)) return 'afternoon'
        if (this.isEvening(date)) return 'evening'
        if (this.isNight(date)) return 'night'
        return null
    }

    /** Build the full 24-entry hour-to-period lookup table for {@link DAY_PERIODS}.
     * @returns {Array<string>} 24-element array; index = hour (0-23), value = period name. */
    getHourToPeriodMap() {
        const reference = new Date(2026, 8 /* September */, 15) // arbitrary date; zones are clock-based
        return Array.from({ length: 24 }, (_, h) => this.getCurrentTimePeriod(new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), h)))
    }

    /** First clock hour covered by a named day-period.
     * @param {string} period - Period name ('morning' | 'noon' | 'afternoon' | 'evening' | 'night').
     * @returns {number|null} First hour (0-23) covered by the period, or null when unknown. */
    getPeriodStartHour(period) {
        const range = typeof period === 'string' ? DAY_PERIODS[period] : undefined
        return Array.isArray(range) ? range[0] : null
    }
    //  -- Clock-bound parsing ------------------------------------------------

    /** Parse one clock-bound token into a fractional hour on the 0-24 axis.
     * @param {number|string} value - Raw clock-bound token.
     * @returns {number|null} Fractional hour (0 <= h < 24), or null when the token is */
    parseClockHour(value) {
        const text = (typeof value === 'string') ? value.trim() : null

        //  Named anchors ('midnight', 'noon') resolve straight to their position on the axis.
        if (text !== null && CLOCK_WORD_HOURS[text.toLowerCase()] !== undefined) {
            return CLOCK_WORD_HOURS[text.toLowerCase()]
        }

        if (text !== null && !/^(\d{1,2}:\d{2}(:\d{2})?|\d+(\.\d+)?)$/.test(text)) return null

        const colon = (text !== null) ? text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/) : null
        if (colon) {
            const hour = Number(colon[1])
            const minute = Number(colon[2])
            const second = colon[3] ? Number(colon[3]) : 0
            if (hour > 23 || minute > 59 || second > 59) return null
            return hour + minute / 60 + second / 3600
        }

        const numeric = (text !== null) ? Number(text) : value
        if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null

        //  Three digits or more can only be a HHMM clock time; leading zeros are kept.
        const digits = (text !== null) ? text : String(Math.trunc(numeric))
        if (/^\d+$/.test(digits) && digits.length >= 3) {
            const hour = Number(digits.slice(0, -2))
            const minute = Number(digits.slice(-2))
            if (hour > 23 || minute > 59) return null
            return hour + minute / 60
        }

        return (numeric >= 0 && numeric < 24) ? numeric : null
    }

    /** Whether a clock-bound token is written in the NATO-style HHMM spelling.
     * @param {number|string} value - Raw clock-bound token.
     * @returns {boolean} True when the token is a valid HHMM clock time (100 and up). */
    isNatoClockBound(value) {
        const text = (typeof value === 'string') ? value.trim() : null
        if (text !== null) return /^\d{3,}$/.test(text)
        return (typeof value === 'number' && Number.isFinite(value) && Math.trunc(value) >= 100)
    }

    /** Whether a clock-bound token names a fixed anchor on the hour axis ('midnight', 'noon').
     *  Such tokens need resolving before any comparison, exactly like a NATO-style bound.
     * @param {number|string} value - Raw clock-bound token.
     * @returns {boolean} True when the token is a recognised named clock anchor. */
    isClockWordBound(value) {
        const text = (typeof value === 'string') ? value.trim().toLowerCase() : null
        return (text !== null && CLOCK_WORD_HOURS[text] !== undefined)
    }

    /** Whether a clock-bound token names a sun-event anchor ('predusk') -- a solar instant
     *  shifted by a fixed offset. Such tokens need the sun context to resolve, exactly like
     *  'sunrise'/'sunset', and must never be compared as raw strings.
     * @param {number|string} value - Raw clock-bound token.
     * @returns {boolean} True when the token is a recognised sun-event offset anchor. */
    isSunAnchorBound(value) {
        const text = (typeof value === 'string') ? value.trim().toLowerCase() : null
        return (text !== null && SUN_OFFSET_ANCHORS[text] !== undefined)
    }

    /** Offset (in hours) a sun-event anchor token carries relative to the sun instant it hangs on.
     * @param {number|string} value - Raw clock-bound token.
     * @returns {number|null} Offset hours (negative = earlier), or null when the token is not a
     *          sun-event anchor. */
    sunAnchorOffsetHours(value) {
        const text = (typeof value === 'string') ? value.trim().toLowerCase() : null
        return (text !== null && SUN_OFFSET_ANCHORS[text] !== undefined) ? SUN_OFFSET_ANCHORS[text] : null
    }

    /** Render a fractional hour as a zero-padded "HH:MM" clock string.
     * @param {number} hour - Fractional hour on the 0-24 axis.
     * @returns {string} Zero-padded "HH:MM", or "invalid" for a non-finite / out-of-range hour. */
    formatClockHour(hour) {
        if (!Number.isFinite(hour) || hour < 0 || hour >= 24) return 'invalid'
        const totalMinutes = Math.min(Math.round(hour * 60), 1439)
        const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
        const m = String(totalMinutes % 60).padStart(2, '0')
        return `${h}:${m}`
    }



    /** Return a human-readable string for the current season.
     * @returns {'spring'|'summer'|'autumn'|'winter'} The matching season name. */
    getCurrentSeason() {
        if (this.isSpring()) return 'spring'
        if (this.isSummer()) return 'summer'
        if (this.isAutumn()) return 'autumn'
        return 'winter'
    }

    /** Format a date as its local calendar-day string "YYYY-MM-DD".
     * @param {Date} [date=new Date()] - Date to format
     * @returns {string} Local day in ISO-like "YYYY-MM-DD" form */
    getLocalDayString(date = new Date()) {
        const y = date.getFullYear()
        const m = String(date.getMonth() + 1).padStart(2, '0')
        const d = String(date.getDate()).padStart(2, '0')
        return `${y}-${m}-${d}`
    }

    /** Render a moment as a zero-padded 24-hour clock string ("HH:MM").
     * @param {Date} [date=new Date()] - Moment to render
     * @returns {string} Zero-padded "HH:MM" (e.g., "07:35", "23:10") */
    formatClockTime(date = new Date()) {
        const h = String(date.getHours()).padStart(2, '0')
        const m = String(date.getMinutes()).padStart(2, '0')
        return `${h}:${m}`
    }

    //  -- Date i18n ----------------------------------------------------------

    /** Load (and cache) the per-locale date bundle from `etc/i18n/{locale}/date.yaml`.
     * @returns {Record<string, unknown>|null} The parsed bundle, or null when the */
    loadDateBundle() {
        const locale = I18nLoader.getLocale()
        if (this.#dateBundle !== null && this.#dateBundleLocale === locale) return this.#dateBundle

        const filePath = path.join(I18N_ROOT, locale, 'date.yaml')
        try {
            const doc = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            this.#dateBundle = doc.contents?.toJSON() ?? null
        } catch (error) {
            LoggerService.warn(`Failed to load date bundle ${filePath}: ${error.message}`, 'DateHelper')
            this.#dateBundle = null
        }
        this.#dateBundleLocale = locale
        return this.#dateBundle
    }

    /** Resolve the localized date parts for a moment, ready for `{% %}` interpolation.
     * @param {Date} [date=new Date()] - Moment to format
     * @returns {{day_name: string, day: string, month_name: string, year: string, year_word: string}} */
    getDateParts(date = new Date()) {
        const bundle = this.loadDateBundle() ?? {}
        const dayNames = Array.isArray(bundle.day_names) ? bundle.day_names : []
        const monthNames = Array.isArray(bundle.month_names) ? bundle.month_names : []
        return {
            day_name: dayNames[date.getDay()] ?? '',
            day: String(date.getDate()),
            month_name: monthNames[date.getMonth()] ?? '',
            year: String(date.getFullYear()),
            year_word: typeof bundle.year_word === 'string' ? bundle.year_word : '',
        }
    }

    /** Localized day-period words for `{% time_of_day %}`, keyed by the five
     * @returns {Record<string, string>} Period name to localized word (empty object when unavailable). */
    getPeriodWords() {
        const bundle = this.loadDateBundle() ?? {}
        return (bundle.period_words && typeof bundle.period_words === 'object') ? bundle.period_words : {}
    }

    /** Localized spoken clock words for a moment -- the hour in words the way the language
     * names it, generated in code so a template (and the model behind it) never has to
     * inflect digits: pl_PL "06:18" is "szósta osiemnaście", not "sześć osiemnaście".
     * @param {Date} [date=new Date()] - Moment to spell
     * @returns {string|null} Spoken clock words, or null when the active locale has no
     *          generator (every caller then keeps its own digit-based wording) */
    getClockWords(date = new Date()) {
        const locale = String(I18nLoader.getLocale() ?? '').trim().toLowerCase()
        if (!locale.startsWith('pl')) return null
        return polishClockWords(date) || null
    }

    /** Localized duration-unit words for `{% next_interval %}` (day/hour/minute/
     * @returns {Record<string, string>} Unit key to localized word (empty object when unavailable). */
    getDurationUnits() {
        const bundle = this.loadDateBundle() ?? {}
        return (bundle.duration_units && typeof bundle.duration_units === 'object') ? bundle.duration_units : {}
    }
}

//  Export frozen singleton.

/** Frozen singleton instance providing temporal utilities. */
export default Object.freeze(new STemporal())
