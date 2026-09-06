/**
 * Trigger-coalescing regression tests.
 *
 * Guards the fix for "forced-run automations launch twice at boot": several hosts changing
 * state in quick succession used to each trigger a full rule evaluation and re-invoke shared
 * downstream automations. EventBus-triggered runs are now coalesced into a single execution,
 * while manual/timer/invoke paths stay immediate. These tests drive real EventBus publishes
 * against a recording AutomationBase subclass and assert the consolidation behaviour.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import AutomationBase from '../src/automation/base/automationBase.js'
import EventBus from '../src/service/eventBus.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'

// Minimal env + config bootstrap so LoggerService has a logger section and lifecycle
// methods (init/cleanup) can emit log lines during a headless run.
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

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

/** Records every execute() invocation so we can count runs and inspect their trigger label. */
class RecordingAutomation extends AutomationBase {
    #calls = []
    execute(triggerData) { this.#calls.push(triggerData); return 'ok' }
    get calls() { return this.#calls }
}

console.log('\n── Trigger coalescing ──\n')

{
    const auto = new RecordingAutomation({ name: 'coalesce-auto', config: { triggers_video: ['host-a', 'host-b'] } })
    await auto.init()   // subscribes to videoPlayer:host-a and videoPlayer:host-b

    // Two near-simultaneous events must collapse into a single execution.
    EventBus.publish('videoPlayer:host-a')
    EventBus.publish('videoPlayer:host-b')
    await sleep(450)   // comfortably past the 250ms quiescence window + margin

    assert(auto.calls.length === 1, `two rapid events -> exactly one run (got ${auto.calls.length})`)
    if (auto.calls[0]) {
        assert(String(auto.calls[0].trigger).includes('host-a'), 'consolidated trigger includes first topic')
        assert(String(auto.calls[0].trigger).includes('host-b'), 'consolidated trigger includes second topic')
    } else {
        assert(false, 'consolidated trigger includes first topic')
        assert(false, 'consolidated trigger includes second topic')
    }

    // A later, separate event is NOT merged with the previous burst -- nothing is dropped.
    EventBus.publish('videoPlayer:host-a')
    await sleep(450)
    assert(auto.calls.length === 2, `a distinct later event triggers its own run (total ${auto.calls.length})`)

    auto.cleanup()
}

// -- Summary --------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)