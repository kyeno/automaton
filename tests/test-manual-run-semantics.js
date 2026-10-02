/**
 * Manual-trigger semantics tests for AutomationBase + AutomationContainer.
 *
 * Verifies the "/automation run" contract end-to-end through the real
 * container.callAutomation() entry point (probe registered via the registerInstance test
 * seam): a manual poke is a pure ONE-SHOT evaluation -- exactly one execute() pass per
 * invocation -- with ZERO interaction with the periodic timer. setInterval/clearInterval
 * are spy-wrapped so any interval created, cleared or re-anchored along the way would be
 * counted and fail the assertions; the schedule keeps running untouched on its own.
 * No MQTT broker or live Redis required.
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
import AutomationBase from '../src/automation/base/automationBase.js'
import AutomationContainer from '../src/automation/container/automationContainer.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

// Bootstrap config + logger so logging works in unit-test mode
await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

// -- Timer spies -------------------------------------------------------------------
// Wrap the globals before any automation starts its interval; Node resolves bare
// setInterval/clearInterval against globalThis at call time, so this catches every use.

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
let setCount = 0
let clearCount = 0
globalThis.setInterval = (...args) => { setCount++; return realSetInterval(...args) }
globalThis.clearInterval = (...args) => { clearCount++; return realClearInterval(...args) }

/** Minimal concrete automation counting execute() passes (no rules, no devices). */
class ManualRunProbe extends AutomationBase {
    constructor(name, cfg) {
        super({ name, config: cfg })
        this.runs = 0
        this.lastTrigger = null
    }

    /** Count one evaluation pass and remember who triggered it. */
    async execute(triggerData = null) {
        this.runs++
        this.lastTrigger = triggerData?.trigger ?? null
    }
}

console.log('\n\u2500\u2500 One-shot manual runs, zero timer interaction \u2500\u2500\n')

setCount = 0   // ignore anything the service bootstrapping above may have scheduled
clearCount = 0

const probe = new ManualRunProbe('ManualRunProbe', { timer_interval_ms: 300 })
await probe.init()

assert(setCount === 1 && clearCount === 0, 'init() starts exactly one periodic interval')
assert(setCount - clearCount === 1, 'exactly one live interval after init')

AutomationContainer.registerInstance(probe.name, probe)

try {
    // -- A single manual poke is exactly one evaluation pass -------------------------

    await AutomationContainer.callAutomation(probe.name, { trigger: 'manual' })
    assert(probe.runs === 1, 'one manual invocation evaluates the rules exactly once')
    assert(probe.lastTrigger === 'manual', 'the run carries its manual trigger metadata')
    assert(setCount === 1 && clearCount === 0, 'manual run creates and clears no timer handle (zero timer interaction)')

    // -- Repeated pokes stay independent one-shots ------------------------------------

    await AutomationContainer.callAutomation(probe.name, { trigger: 'manual', force: true })
    assert(probe.runs === 2, 'a second manual invocation is another independent one-shot pass')
    assert(setCount - clearCount === 1, 'still exactly one live interval -- no overlapping timers')

    // -- Delegated invocations leave the schedule untouched as well --------------------

    const setsBefore = setCount
    const clearsBefore = clearCount
    await AutomationContainer.callAutomation(probe.name, { trigger: 'SomeOtherAutomation' })
    assert(probe.runs === 3, 'delegated runs also evaluate exactly once per call')
    assert(setCount === setsBefore && clearCount === clearsBefore, 'delegated runs touch no timer handle either')
} finally {
    probe.cleanup()
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
}

assert(clearCount >= 1, 'cleanup() stops the periodic interval on shutdown')

// -- Summary ------------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)