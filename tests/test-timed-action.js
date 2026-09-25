/**
 * Tests for the shared TimedAction helper -- single-slot timed actions with race protection.
 *
 * Covers: start() scheduling + bound-callback invocation, the race guard (a second request
 * while busy returns false without scheduling), stop()/cleanup() releasing the slot, isActive(),
 * and the invariant that a throwing callback still releases the slot so the timer cannot leak.
 * Uses short real delays (no fake timers) so the suite stays fast.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import TimedAction from '../src/lib/timedAction.js'

// Minimal env bootstrap so services can be imported and LoggerService works headless.
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
await LoggerService.init?.()

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('\n── TimedAction ──\n')

{
    const ta = new TimedAction('test slot')

    // Fresh slot is idle.
    assert(ta.isActive() === false, 'new instance starts with an idle slot')
    assert(ta.stop() === false, 'stop() on an idle slot is a no-op and reports nothing cancelled')

    // A bound callback fires after the delay exactly once.
    let calls = 0
    const cb = () => { calls++ }
    assert(ta.start(20, cb) === true, 'start() returns true when the slot is free')
    await sleep(60)
    assert(calls === 1, `callback invoked exactly once after the delay (got ${calls})`)
    assert(ta.isActive() === false, 'slot released automatically after the callback ran')

    // Race: while busy, a second request must be ignored -- never two concurrent timers.
    calls = 0
    const first = () => { calls += 1 }
    const second = () => { calls += 100 }
    assert(ta.start(30, first) === true, 'first start() succeeds')
    await sleep(15)   // well inside the window -- second is still racing
    assert(ta.start(30, second) === false, 'second start() returns false while the slot is busy')
    assert(ta.isActive() === true, 'slot correctly reported active during the race')
    await sleep(80)
    assert(calls === 1 && calls !== 101, `only the first callback ran; the racing one was dropped (got ${calls})`)
}

{
    // stop() cancels an in-flight timer and releases the slot.
    let fired = false
    const cb = () => { fired = true }
    const ta = new TimedAction('cancel test')
    assert(ta.start(2000, cb) === true, 'timer scheduled with a long delay')
    assert(ta.isActive() === true, 'slot active before cancel')
    ta.stop()
    assert(ta.isActive() === false, 'stop() releases the slot immediately')
    assert(ta.stop() === false, 'stopping twice is safe')
    await sleep(60)
    assert(fired === false, 'cancelled callback never fires')
}

{
    // cleanup() is equivalent to stop().
    let fired = false
    const ta = new TimedAction('cleanup test')
    ta.start(5000, () => { fired = true })
    ta.cleanup()
    assert(ta.isActive() === false, 'cleanup() releases the slot')
    await sleep(60)
    assert(fired === false, 'cleaned-up callback never fires')
}

{
    // A throwing callback must not leak the slot -- it is released via try/finally.
    const ta = new TimedAction('throwing test')
    let threw = false
    const cb = () => { threw = true; throw new Error('boom') }
    assert(ta.start(20, cb) === true, 'timer scheduled with a throwing callback')
    await sleep(60)
    assert(threw === true, 'callback ran and threw as expected')
    assert(ta.isActive() === false, 'slot still released even though the callback threw')
    // The slot is free again, so a fresh start succeeds.
    assert(ta.start(20, () => {}) === true, 'new start() works after a throwing callback')
    await sleep(40)
}

// -- Summary --------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)