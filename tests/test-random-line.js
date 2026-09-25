/**
 * Random line reader tests (src/lib/randomLine.js).
 *
 * Covers the two streaming passes against real files in a temp dir: newline
 * counting (trailing newline, missing trailing newline, blank lines, CRLF,
 * comment filtering), indexed reads (chunk boundaries, lines spanning chunks,
 * BOM/CR trimming, out-of-range and invalid indices), and random selection
 * (deterministic via the injected `random` hook, plus the [0,1) clamp).
 *
 * The chunk-boundary cases matter most: a tiny chunkSize forces nearly every
 * line to span several reads, which is where stale-buffer bytes or an
 * off-by-one in the scan would show up as a phantom or missing line.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { countLines, readLineAt, readRandomLine } from '../src/lib/randomLine.js'

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

// Temp workspace, removed on exit so a failing run leaves nothing behind.
const dir = mkdtempSync(path.join(tmpdir(), 'random-line-'))
process.on('exit', () => {
    try {
        rmSync(dir, { recursive: true, force: true })
    } catch {
        // Best effort -- a leftover temp dir must never mask a test result.
    }
})

/** Write a fixture file and return its absolute path. */
function fixture(name, content) {
    const p = path.join(dir, name)
    writeFileSync(p, content)
    return p
}

// ---------------------------------------------------------------------------
// countLines
// ---------------------------------------------------------------------------
console.log('\n── countLines ──\n')

const basic = fixture('basic.txt', 'alpha\nbeta\ngamma\n')
assertEqual(countLines(basic), 3, 'trailing newline: 3 lines')
assertEqual(countLines(fixture('no-trailing.txt', 'alpha\nbeta')), 2, 'missing trailing newline still counts last line')
assertEqual(countLines(fixture('empty.txt', '')), 0, 'empty file counts 0')
assertEqual(countLines(fixture('blank.txt', '\n\n\n')), 0, 'only newlines counts 0')
assertEqual(countLines(path.join(dir, 'nope.txt')), 0, 'missing file counts 0')
assertEqual(countLines(dir), 0, 'directory instead of file counts 0')

const blankMixed = fixture('blank-mixed.txt', 'alpha\n\n  \nbeta\n\n')
assertEqual(countLines(blankMixed), 2, 'blank and whitespace-only lines skipped by default')
// With skipBlank:false the whitespace-only "  " line counts, but the two zero-byte
// lines (one interior, one from the trailing newline) still do not -- a line must
// contain at least one byte to exist at all, which is what keeps a trailing newline
// from inflating the index space.
assertEqual(countLines(blankMixed, { skipBlank: false }), 3, 'skipBlank:false counts whitespace-only lines but not empty ones')

const crlf = fixture('crlf.txt', 'alpha\r\nbeta\r\n')
assertEqual(countLines(crlf), 2, 'CRLF line endings counted')
assertEqual(readLineAt(crlf, 0), 'alpha', 'CRLF: trailing CR stripped from returned line')

const commented = fixture('commented.txt', '# header\nalpha\n# mid\nbeta\n')
assertEqual(countLines(commented), 4, 'comment lines counted when no marker given')
assertEqual(countLines(commented, { commentChar: '#' }), 2, 'comment lines skipped with commentChar')
assertEqual(readLineAt(commented, 1, { commentChar: '#' }), 'beta', 'commentChar does not shift the index space')
assertEqual(
    countLines(fixture('indented-comment.txt', '   # indented\nalpha\n'), { commentChar: '#' }),
    1,
    'indented comment line still recognized'
)
assertEqual(
    countLines(fixture('not-comment.txt', '#hashtag text\n'), { commentChar: '#' }),
    0,
    'a line starting with the marker is always a comment'
)

// ---------------------------------------------------------------------------
// readLineAt
// ---------------------------------------------------------------------------
console.log('\n── readLineAt ──\n')

assertEqual(readLineAt(basic, 0), 'alpha', 'index 0')
assertEqual(readLineAt(basic, 1), 'beta', 'index 1')
assertEqual(readLineAt(basic, 2), 'gamma', 'index 2')
assertEqual(readLineAt(basic, 3), null, 'index past end is null')
assertEqual(readLineAt(basic, -1), null, 'negative index is null')
assertEqual(readLineAt(basic, 1.5), null, 'non-integer index is null')
assertEqual(readLineAt(basic, NaN), null, 'NaN index is null')
assertEqual(readLineAt(path.join(dir, 'nope.txt'), 0), null, 'missing file is null')

// Every line must be reachable, and the last index must match countLines - 1.
assertEqual(readLineAt(basic, countLines(basic) - 1), 'gamma', 'last index equals countLines()-1')
assertEqual(readLineAt(fixture('single.txt', 'solo'), 0), 'solo', 'single line without newline')
assertEqual(readLineAt(fixture('bom.txt', '\uFEFFfirst\nsecond\n'), 0), 'first', 'leading BOM stripped')
assertEqual(readLineAt(fixture('spaces.txt', '   padded   \nsecond\n'), 0), 'padded', 'surrounding whitespace trimmed')

// ---------------------------------------------------------------------------
// Chunk boundaries -- the memory-safe streaming path
// ---------------------------------------------------------------------------
console.log('\n── Chunk boundary handling ──\n')

const long = fixture('long-lines.txt', `${'x'.repeat(500)}\nshort\n${'y'.repeat(300)}\n`)
for (const chunkSize of [1, 2, 3, 7, 16, 64, 4096]) {
    assertEqual(countLines(long, { chunkSize }), 3, `countLines with chunkSize=${chunkSize}`)
    assertEqual(readLineAt(long, 0, { chunkSize }), 'x'.repeat(500), `chunkSize=${chunkSize}: line spanning many chunks`)
    assertEqual(readLineAt(long, 1, { chunkSize }), 'short', `chunkSize=${chunkSize}: short line`)
    assertEqual(readLineAt(long, 2, { chunkSize }), 'y'.repeat(300), `chunkSize=${chunkSize}: final line`)
}

// A file much larger than the default chunk: verifies the scan keeps making
// progress across many reads instead of stalling or re-reading offset 0.
const many = fixture('many.txt', `${Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n')}\n`)
assertEqual(countLines(many), 5000, 'large file line count')
assertEqual(readLineAt(many, 0), 'line-0', 'large file first line')
assertEqual(readLineAt(many, 2500), 'line-2500', 'large file middle line')
assertEqual(readLineAt(many, 4999), 'line-4999', 'large file last line')

// maxLineLength caps retention of an unterminated line.
const capped = fixture('capped.txt', 'a'.repeat(5000))
assertEqual(readLineAt(capped, 0, { maxLineLength: 10 }), 'a'.repeat(10), 'maxLineLength truncates a long line')

// ---------------------------------------------------------------------------
// readRandomLine
// ---------------------------------------------------------------------------
console.log('\n── readRandomLine ──\n')

assertEqual(readRandomLine(basic, { random: () => 0 }), 'alpha', 'random()=0 picks the first line')
assertEqual(readRandomLine(basic, { random: () => 0.99 }), 'gamma', 'random()=0.99 picks the last line')
assertEqual(readRandomLine(basic, { random: () => 0.5 }), 'beta', 'random()=0.5 picks the middle line')
assertEqual(readRandomLine(basic, { random: () => 1 }), 'gamma', 'random()=1 is clamped to the last line')
assertEqual(readRandomLine(basic, { random: () => 0, commentChar: '#' }), 'alpha', 'random honours commentChar filtering')

assertEqual(readRandomLine(fixture('empty.txt', '')), null, 'empty file yields null')
assertEqual(readRandomLine(path.join(dir, 'nope.txt')), null, 'missing file yields null')
assertEqual(readRandomLine(fixture('blank.txt', '\n\n')), null, 'blank-only file yields null')

// Default RNG must only ever return a real line, never null or a phantom.
let allValid = true
for (let i = 0; i < 200; i++) {
    const line = readRandomLine(basic)
    if (line !== 'alpha' && line !== 'beta' && line !== 'gamma') allValid = false
}
assert(allValid, '200 default-RNG draws all return a real line')

// The proverb files shipped with the repo must parse cleanly.
console.log('\n── Shipped proverb files ──\n')
for (const locale of ['pl_PL', 'en_US']) {
    const p = path.join(import.meta.dirname, '..', 'etc', 'i18n', locale, 'proverbs.txt')
    const total = countLines(p, { commentChar: '#' })
    assert(total >= 3, `${locale}/proverbs.txt has at least 3 proverbs (got ${total})`)
    assert(countLines(p) > total, `${locale}/proverbs.txt header comments are excluded`)
    let allClean = true
    for (let i = 0; i < total; i++) {
        const line = readLineAt(p, i, { commentChar: '#' })
        if (!line || line.startsWith('#') || line.includes('\n')) allClean = false
    }
    assert(allClean, `${locale}/proverbs.txt: all ${total} entries are clean single-line proverbs`)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)

