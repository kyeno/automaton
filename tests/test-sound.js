/**
 * Sound module tests for beep() and doubleBeep().
 *
 * See test-sound-mario.js for Mario theme tests.
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

console.log('=== sound.js tests ===\n')

// -- Module exports --------------------------------------------------------

console.log('── module exports ──\n')

report('sound.beep is a function', typeof sound.beep !== 'function' ? 'not a function' : null)
report('sound.doubleBeep is a function', typeof sound.doubleBeep !== 'function' ? 'not a function' : null)
report('sound.mario is a function', typeof sound.mario !== 'function' ? 'not a function' : null)
report('sound.marioGameOver is a function', typeof sound.marioGameOver !== 'function' ? 'not a function' : null)
report('export object is frozen', Object.isFrozen(sound) ? null : 'not frozen')

// -- beep() ----------------------------------------------------------------

console.log('\n── beep() ──\n')

await testCall(sound.beep, {}, 'basic beep with defaults')
await sleep(300)

await testCall(sound.beep, { frequency: 1_000 }, 'beep with frequency 1000Hz')
await sleep(300)

await testCall(sound.beep, { duration: 500 }, 'beep with duration 500ms')
await sleep(600)

await testCall(sound.beep, { frequency: 600, duration: 300 }, 'beep with frequency 600Hz and duration 300ms')
await sleep(400)

await testNoCallback(sound.beep, {}, 'beep without callback (no throw)', 300)
await testNoCallback(sound.beep, { frequency: 800, duration: 200 }, 'beep with empty options (no throw)', 400)

// -- doubleBeep() ----------------------------------------------------------

console.log('\n── doubleBeep() ──\n')

await testCall(sound.doubleBeep, {}, 'doubleBeep with defaults')
await sleep(500)

await testCall(sound.doubleBeep, { frequency: 800, duration: 150 }, 'doubleBeep with custom freq/duration')
await sleep(500)

await testNoCallback(sound.doubleBeep, { frequency: 600, duration: 100 }, 'doubleBeep without callback (no throw)', 500)

/* ------------------------------------------------------------------ */
/* Summary                                                            */
/* ------------------------------------------------------------------ */

const total = passed + failed
console.log(`\n=== results: ${passed} passed${failed > 0 ? `, ${failed} failed` : ''} ===`)
process.exit(failed > 0 ? 1 : 0)