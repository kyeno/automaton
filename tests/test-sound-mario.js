/**
 * Dedicated sound module tests for Mario themes.
 *
 * Tests mario() and marioGameOver() from src/lib/sound.js.
 * Requires `beep` CLI installed and appropriate privileges on the target machine.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import sound from '../src/lib/sound.js'

let passed = 0
let failed = 0

function report(name, err) {
    if (err) {
        console.log(`[FAIL] ${name}: ${err}`)
        failed++
    } else {
        console.log(`[PASS] ${name}`)
        passed++
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Run a callback-driven sound call and assert no error. */
async function testCall(fn, opts, label) {
    await new Promise((resolve) => {
        fn({
            ...opts,
            callback: (err) => {
                report(label, err)
                resolve()
            }
        })
    })
}

/** Call without callback -- verify it doesn't throw, then wait for completion. */
async function testNoCallback(fn, opts, label, waitMs) {
    try {
        fn(opts)
        report(label, null)
    } catch (e) {
        report(label, e.message)
    }
    await sleep(waitMs)
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

console.log('=== sound.js mario tests ===\n')

// -- Module exports --------------------------------------------------------

console.log('── module exports ──\n')

report('sound.mario is a function', typeof sound.mario !== 'function' ? 'not a function' : null)
report('sound.marioGameOver is a function', typeof sound.marioGameOver !== 'function' ? 'not a function' : null)

// -- mario() ---------------------------------------------------------------

console.log('\n── mario() ──\n')

await testCall(sound.mario, {}, 'mario melody with callback')
// testCall already awaits the callback; no extra sleep needed

await testNoCallback(sound.mario, {}, 'mario without callback (no throw)', 1_500)

// -- marioGameOver() -------------------------------------------------------

console.log('\n── marioGameOver() ──\n')

await testCall(sound.marioGameOver, {}, 'marioGameOver melody with callback')
// testCall already awaits the callback; no extra sleep needed

await testNoCallback(sound.marioGameOver, {}, 'marioGameOver without callback (no throw)', 2_500)

/* ------------------------------------------------------------------ */
/* Summary                                                            */
/* ------------------------------------------------------------------ */

const total = passed + failed
console.log(`\n=== results: ${passed} passed${failed > 0 ? `, ${failed} failed` : ''} ===`)
process.exit(failed > 0 ? 1 : 0)