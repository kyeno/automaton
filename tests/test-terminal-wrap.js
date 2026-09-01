/**
 * Terminal wrap utility tests.
 * Regression coverage for wrapAnsi hard-breaking: any single unbroken token
 * longer than the wrap width used to spin forever in the splice-back loop,
 * freezing the whole UI (e.g., long TTS input or log lines with huge tokens).
 * Also covers wrapPreformatted, the whitespace-preserving hard-break path used
 * for box-drawing trees (/config debug) where indentation must survive wrapping.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { wrapAnsi, wrapPreformatted, visibleLen } from '../src/lib/terminal.js'

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

// -- wrapPreformatted: whitespace-preserving hard wrap -------------------------

console.log('\n\u2500\u2500 wrapPreformatted: short lines pass through untouched \u2500\u2500\n')

{
    const tree = [
        '\u251c\u2500 ui',
        '\u2502   \u251c\u2500 status_bar',
        '\u2502   \u2502   \u2514\u2500 lines[2]',
        '\u2502   \u2514\u2500 windows[4]',
        '\u2514\u2500 logger',
    ]
    for (const line of tree) {
        const out = wrapPreformatted(line, 120)
        assertEqual(out.length === 1 && out[0] === line, true, `fits byte-identical: ${line}`)
    }
    const spaced = '    xxxx  double  spaces  kept'
    const outSpaced = wrapPreformatted(spaced, 120)
    assertEqual(outSpaced.length === 1 && outSpaced[0] === spaced, true, 'internal multiple spaces preserved')
    const outEmpty = wrapPreformatted('', 80)
    assertEqual(outEmpty.length === 1 && outEmpty[0] === '', true, 'empty string yields one empty line')
}

console.log('\n\u2500\u2500 wrapPreformatted: long lines hard-break with indent carried \u2500\u2500\n')

{
    // 4-space indent + 100 visible chars, width 50:
    //   line 1 = 4 spaces + 46 chars (50 visible)
    //   line 2 = 4 spaces + 46 chars (50 visible)
    //   line 3 = 4 spaces + 8 chars (12 visible)
    const line = '    ' + 'A'.repeat(100)
    const out = wrapPreformatted(line, 50)
    assertEqual(out.length, 3, 'breaks into three lines')
    assertEqual(out[0], '    ' + 'A'.repeat(46), 'first line fills the width including indent')
    assertEqual(out[1], '    ' + 'A'.repeat(46), 'continuation re-indented to the original indent')
    assertEqual(out[2], '    ' + 'A'.repeat(8), 'final partial line keeps the indent')
    // No character loss: 104 original visible chars + 2 continuation indents (4 each)
    assertEqual(out.reduce((sum, l) => sum + visibleLen(l), 0), 112, 'no visible characters lost')
}

{
    // A line exactly at the width stays one line; one char over breaks
    const at = wrapPreformatted('B'.repeat(50), 50)
    assertEqual(at.length === 1 && at[0] === 'B'.repeat(50), true, 'exactly at width stays one line')
    const over = wrapPreformatted('B'.repeat(51), 50)
    assertEqual(over.length === 2 && over[0] === 'B'.repeat(50) && over[1] === 'B', true, 'one char over breaks with no indent')
}

{
    // ANSI codes: dim-prefixed long line; codes must survive and not count toward width
    const line = '\x1b[2m  ' + 'C'.repeat(90) + '\x1b[0m'
    const out = wrapPreformatted(line, 50)
    assertEqual(out.length, 2, 'ANSI line breaks by visible width only')
    assertEqual(out[0], '\x1b[2m  ' + 'C'.repeat(48), 'first line keeps leading ANSI + spaces')
    assertEqual(out[1], '\x1b[2m  ' + 'C'.repeat(42) + '\x1b[0m', 'continuation re-indented, dim code and reset carried')
    assertEqual(out.reduce((sum, l) => sum + visibleLen(l), 0), 94, 'no visible characters lost (92 + one re-indented pair)')
}

{
    // Termination + performance: a very long indented line must complete quickly
    const line = '        ' + 'D'.repeat(5000)
    const t0 = Date.now()
    const out = wrapPreformatted(line, 80)
    const ms = Date.now() - t0
    assertEqual(ms < 2000, true, `5000-char line wraps in ${ms}ms (< 2000ms)`)
    assertEqual(out.length, 70, 'line count matches the budget arithmetic')
    assertEqual(out.every(l => visibleLen(l) <= 80), true, 'no line exceeds the width budget')
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)