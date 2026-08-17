/**
 * Terminal wrap utility tests.
 * Regression coverage for wrapAnsi hard-breaking: any single unbroken token
 * longer than the wrap width used to spin forever in the splice-back loop,
 * freezing the whole UI (e.g., long TTS input or log lines with huge tokens).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { wrapAnsi, visibleLen } from '../src/lib/terminal.js'

let passed = 0
let failed = 0

function assertEqual(actual, expected, label) {
    if (actual === expected) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
        failed++
    }
}

/** Sum of visible characters across all wrapped lines. */
function totalVisible(lines) {
    let sum = 0
    for (const line of lines) sum += visibleLen(line)
    return sum
}

// -- Hard-break termination ------------------------------------------------------

console.log('\n\u2500\u2500 Hard-break termination \u2500\u2500\n')

{
    const r = wrapAnsi('A'.repeat(90), 80)
    assertEqual(r.length, 2, 'word just over width breaks into exactly two lines')
    assertEqual(visibleLen(r[0]), 80, 'first segment fills the width with no blank lead-in')
    assertEqual(visibleLen(r[1]), 10, 'remainder carries the tail characters')
}

{
    const t0 = Date.now()
    const r = wrapAnsi('B'.repeat(5000), 80)
    const ms = Date.now() - t0
    assertEqual(ms < 2000, true, `huge single word wraps quickly (${ms}ms)`)
    assertEqual(r.length, Math.ceil(5000 / 80), 'segment count matches ceil(len/width)')
    assertEqual(totalVisible(r), 5000, 'no characters lost across hard breaks')
    assertEqual(Math.max(...r.map(l => visibleLen(l))) <= 80, true, 'no wrapped line exceeds the width budget')
}

// -- Boundary and mixed content ----------------------------------------------------

console.log('\n\u2500\u2500 Boundary and mixed content \u2500\u2500\n')

{
    const exact = wrapAnsi('C'.repeat(80), 80)
    assertEqual(exact.length, 1, 'word exactly at width stays a single line')

    const near = wrapAnsi('D'.repeat(79) + ' E', 80)
    assertEqual(near.length, 2, 'full line plus one more character wraps to two lines')
    assertEqual(visibleLen(near[0]), 79, 'first line holds the full-width run')
    assertEqual(visibleLen(near[1]), 1, 'overflowing character lands alone on line two')

    const r = wrapAnsi(`hello ${'A'.repeat(90)}`, 80)
    assertEqual(r.length, 3, 'short word then giant word produces three lines')
    assertEqual(visibleLen(r[0]), 5, 'first line holds only the short word')
    assertEqual(visibleLen(r[1]), 80, 'giant word hard-breaks at the width boundary')
    assertEqual(visibleLen(r[2]), 10, 'tail of the giant word ends up on its own line')
}

// -- Regression guards ---------------------------------------------------------------

console.log('\n\u2500\u2500 Regression guards \u2500\u2500\n')

{
    assertEqual(
        JSON.stringify(wrapAnsi('hello world this is a test', 10)),
        JSON.stringify(['hello', 'world this', 'is a test']),
        'plain prose wrapping unchanged'
    )

    // ANSI-prefixed over-long word: codes must not break termination or count against width
    const input = '\x1b[1m' + 'F'.repeat(165)
    const t0 = Date.now()
    const r = wrapAnsi(input, 80)
    const ms = Date.now() - t0
    assertEqual(ms < 2000, true, `ANSI-prefixed long word wraps quickly (${ms}ms)`)
    assertEqual(totalVisible(r), 165, 'all visible characters preserved with leading ANSI')
    assertEqual(Math.max(...r.map(l => visibleLen(l))) <= 80, true, 'ANSI codes do not consume the width budget')
    assertEqual(visibleLen(r[0]) > 0, true, 'no empty first line when input starts with an over-long word')
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)