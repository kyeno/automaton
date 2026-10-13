/**
 * Polish language helpers -- number and clock words.
 *
 * The speech templates need the clock in WORDS ("szósta osiemnaście"), and a small model
 * asked to inflect digits into Polish words is exactly the workload a CPU-bound model pays
 * for. The forms below are generated from Polish numeral tables instead: cardinal numbers,
 * the feminine hour ordinal (an hour is *godzina* -- feminine), and the composed clock
 * phrase. Automations reach it through temporal.getClockWords(), which serves it only to
 * locales whose language has a generator, so every other locale keeps its own wording.
 *
 * @module lib/polish
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

//  -- Numeral tables (0-999, enough for minutes, durations, degrees, percentages) ---------

/** Nominative cardinal units 0-9.
 * @type {string[]} */
const ONES = ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć']

/** Nominative teens 10-19 -- their own words, not tens + units.
 * @type {string[]} */
const TEENS = ['dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście']

/** Nominative tens 10-90 (index = tens digit).
 * @type {string[]} */
const TENS = ['', 'dziesięć', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt', 'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt']

/** Nominative hundreds 100-900 (index = hundreds digit).
 * @type {string[]} */
const HUNDREDS = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset', 'sześćset', 'siedemset', 'osiemset', 'dziewięćset']

//  -- Hour ordinals -----------------------------------------------------------------------

/** Feminine hour ordinals 1-12 -- they agree with *godzina*, which is how Polish names an
 * hour ("szósta osiemnaście", not "sześć osiemnaście").
 * @type {string[]} */
const HOUR_ORDINALS = ['', 'pierwsza', 'druga', 'trzecia', 'czwarta', 'piąta', 'szósta', 'siódma', 'ósma', 'dziewiąta', 'dziesiąta', 'jedenasta', 'dwunasta']


/** Validate a whole number for the word tables: numeric, integral, and in range. Strings
 * are accepted ("42"), everything unusable (null, booleans, NaN, fractions, empty text,
 * out-of-range) yields null so a caller keeps its own fallback.
 * @param {number|string} value - Candidate value
 * @param {number} min - Lower bound, inclusive
 * @param {number} max - Upper bound, inclusive
 * @returns {number|null} The validated integer, or null */
function wholeNumber(value, min, max) {
    if (value === null || value === undefined || typeof value === 'boolean') return null
    if (typeof value === 'string' && value.trim() === '') return null
    const n = Number(value)
    if (!Number.isInteger(n) || n < min || n > max) return null
    return n
}

/** Spell a number as Polish cardinal words.
 * @param {number|string} number - Whole number in 0-999
 * @returns {string} Polish words ('czterdzieści pięć'), '' when the value is unusable */
export function cardinalWords(number) {
    const n = wholeNumber(number, 0, 999)
    if (n === null) return ''
    if (n < 10) return ONES[n]
    if (n < 20) return TEENS[n - 10]

    const parts = []
    if (n >= 100) parts.push(HUNDREDS[Math.floor(n / 100)])
    const rest = n % 100
    if (rest >= 10 && rest < 20) {
        //  10-19 are single words of their own, never a ten plus a unit.
        parts.push(TEENS[rest - 10])
    } else {
        if (rest >= 20) parts.push(TENS[Math.floor(rest / 10)])
        const unit = rest % 10
        if (unit > 0) parts.push(ONES[unit])
    }
    return parts.filter(Boolean).join(' ')
}

/** Name an hour the way Polish says it: the feminine ordinal agreeing with *godzina*, on the
 * spoken 12-hour clock (the day-period word carries the AM/PM, so 17 is "piąta" and 0 is
 * "dwunasta").
 * @param {number|string} hour - Hour in 0-23 (13-23 map to 1-11)
 * @returns {string} Feminine ordinal ('piąta'), '' when the value is unusable */
export function hourWords(hour) {
    const h = wholeNumber(hour, 0, 23)
    if (h === null) return ''
    return HOUR_ORDINALS[((h + 11) % 12) + 1] || ''
}

/** Spell a moment as the Polish spoken clock: hour ordinal plus cardinal minutes, with no
 * minutes word on the exact hour ("szósta osiemnaście", "szósta").
 * @param {Date} date - Moment to spell
 * @returns {string} Spoken clock words, '' when the moment is unusable */
export function clockWords(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
    const hour = hourWords(date.getHours())
    if (!hour) return ''
    const minutes = date.getMinutes()
    return minutes > 0 ? `${hour} ${cardinalWords(minutes)}` : hour
}
