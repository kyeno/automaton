/**
 * Tests for the Polish language library (src/lib/polish.js) and its locale gate in
 * the date helper (temporal.getClockWords()).
 *
 * Covers: cardinal spelling 0-999 (units, the own-word teens, tens with their unit,
 * hundreds with teens and units, boundaries, unusable values), the feminine hour ordinal
 * on the spoken 12-hour clock (13-23 map to 1-11, 0 and 24 to "dwunasta"), the composed
 * clock phrase (minutes word dropped on the exact hour), and the gate in lib/date that
 * serves the generator only to locales whose language has one.
 *
 * The regression this library exists for: a TTS engine reading "06:18" says
 * "sześć osiemnaście", while Polish names the hour with the feminine ordinal agreeing
 * with *godzina* -- "szósta osiemnaście". Templates get the words pre-computed, so
 * neither the TTS engine nor a small CPU-bound model has to decline a digit string.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import I18nLoader from '../src/service/i18nLoader.js'
import temporal from '../src/lib/date.js'
import { cardinalWords, hourWords, clockWords } from '../src/lib/polish.js'

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  ✓ ${label}`)
        passed++
    } else {
        console.error(`  ✗ ${label}`)
        failed++
    }
}

function assertEqual(actual, expected, label) {
    assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

/** Fixed calendar day for deterministic clock math. */
const D = (hour, minute) => new Date(2026, 7 /* August */, 15, hour, minute, 0, 0)

// ---------------------------------------------------------------------------
// 1. cardinalWords() -- nominative cardinals 0-999
// ---------------------------------------------------------------------------
console.log('── cardinalWords() ──\n')
{
    const cases = [
        [0, 'zero'], [1, 'jeden'], [5, 'pięć'], [9, 'dziewięć'],
        [10, 'dziesięć'], [11, 'jedenaście'], [15, 'piętnaście'], [18, 'osiemnaście'], [19, 'dziewiętnaście'],
        [20, 'dwadzieścia'], [21, 'dwadzieścia jeden'], [30, 'trzydzieści'], [32, 'trzydzieści dwa'],
        [40, 'czterdzieści'], [45, 'czterdzieści pięć'], [59, 'pięćdziesiąt dziewięć'],
        [90, 'dziewięćdziesiąt'], [99, 'dziewięćdziesiąt dziewięć'],
        [100, 'sto'], [105, 'sto pięć'], [115, 'sto piętnaście'], [121, 'sto dwadzieścia jeden'],
        [200, 'dwieście'], [220, 'dwieście dwadzieścia'], [999, 'dziewięćset dziewięćdziesiąt dziewięć'],
    ]
    for (const [n, expected] of cases) assertEqual(cardinalWords(n), expected, `${n} spells as Polish words`)

    //  Unusable values spell nothing -- a template then keeps its own fallback.
    for (const bad of ['nonsense', null, undefined, -1, 1000, 1.5, NaN]) {
        assertEqual(cardinalWords(bad), '', `${String(bad)} is not a spellable number`)
    }
    assertEqual(cardinalWords('42'), 'czterdzieści dwa', 'a numeric string is spelled too')
}


// ---------------------------------------------------------------------------
// 2. hourWords() -- feminine ordinal on the spoken 12-hour clock
// ---------------------------------------------------------------------------
console.log('── hourWords() ──\n')
{
    assertEqual(hourWords(6), 'szósta', '6 is the feminine ordinal agreeing with godzina')
    assertEqual(hourWords(1), 'pierwsza', '1 is pierwsza')
    assertEqual(hourWords(12), 'dwunasta', '12 is dwunasta')
    assertEqual(hourWords(0), 'dwunasta', 'midnight is spoken as dwunasta (the period word says night)')
    assertEqual(hourWords(13), 'pierwsza', '13:00 is the first hour of the afternoon')
    assertEqual(hourWords(17), 'piąta', '17 is piąta, never siedemnasta on the spoken clock')
    assertEqual(hourWords(23), 'jedenasta', '23 is jedenasta')
    for (const bad of ['x', null, undefined, -1, 24, NaN]) {
        assertEqual(hourWords(bad), '', `${String(bad)} is not an hour`)
    }
}

// ---------------------------------------------------------------------------
// 3. clockWords() -- the composed spoken clock
// ---------------------------------------------------------------------------
console.log('── clockWords() ──\n')
{
    const cases = [
        [6, 18, 'szósta osiemnaście'],
        [5, 40, 'piąta czterdzieści'],
        [15, 31, 'trzecia trzydzieści jeden'],
        [17, 37, 'piąta trzydzieści siedem'],
        [21, 4, 'dziewiąta cztery'],
        [13, 1, 'pierwsza jeden'],
        [23, 59, 'jedenasta pięćdziesiąt dziewięć'],
        [0, 20, 'dwunasta dwadzieścia'],
        [12, 0, 'dwunasta'],
        [6, 0, 'szósta'],
    ]
    for (const [h, m, expected] of cases) {
        assertEqual(clockWords(D(h, m)), expected, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} is spoken in words`)
    }
    //  The exact hour never says "zero" minutes.
    assert(!clockWords(D(6, 0)).includes('zero'), 'an exact hour carries no minutes word')
    for (const bad of ['nope', null, undefined, new Date('nonsense')]) {
        assertEqual(clockWords(bad), '', `${String(bad)} is not a moment`)
    }

// ---------------------------------------------------------------------------
// 4. temporal.getClockWords() -- the locale gate
// ---------------------------------------------------------------------------
console.log('── temporal.getClockWords() ──\n')
{
    const locale = String(I18nLoader.getLocale() ?? '')
    const isPolish = locale.toLowerCase().startsWith('pl')
    const words = temporal.getClockWords(D(6, 18))
    if (isPolish) {
        assertEqual(words, 'szósta osiemnaście', `pl locale (${locale}) gets declined clock words, never "sześć osiemnaście"`)
        assertEqual(temporal.getClockWords(D(15, 31)), 'trzecia trzydzieści jeden', 'pl locale speaks 15:31 on the 12-hour clock')
        assertEqual(temporal.getClockWords(D(12, 0)), 'dwunasta', 'pl locale drops the minutes word on the exact hour')
    } else {
        assert(words === null, `locale ${locale} has no word generator -> null (templates keep digits)`)
    }
    assert(typeof temporal.getClockWords === 'function', 'the date helper exposes the generator gate')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)

}
