/**
 * Ambient Lights automation execution tests.
 *
 * Exercises the rule-based execute() flow end-to-end using stubbed devices and
 * fabricated sensor contexts against a self-contained rule set modeled on
 * ambient-lights.yaml.dist (no local configuration required):
 *   - bright morning turns off every listed device (sockets + wall switch)
 *   - settled dusk turns on only the outlets (asymmetric target sets)
 *   - still-bright evening does nothing
 *   - flat per-rule "action" fallback dispatches commands (regression test)
 *   - season conditions and temporal helpers (stubbed Date)
 * Redis/MQTT are not required -- unavailable services fail open by design.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from 'redis'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import AmbientLightsAutomation from '../etc/automation/ambientLightsAutomation.js'
import temporal from '../src/lib/date.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

// Best-effort cleanup: remove daily once-markers left over from previous runs so
// repeated executions on the same day still exercise every rule (no-op without Redis).
{
    const client = createClient({ url: process.env['REDIS_URL'], socket: { connectTimeout: 1500, reconnectStrategy: false } })
    try {
        await client.connect()
        const keys = await client.keys('auto:AmbientLightsAutomation:once:*')
        if (keys.length > 0) await client.del(...keys)
    } catch (_) { /* Redis unavailable -- markers fail open by design */ } finally {
        await client.quit().catch(() => {})
    }
}

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

/**
 * Stub global Date with a fixed month/day/hour for deterministic season checks.
 * @param {number} monthIndex - Zero-based month (0=Jan ... 11=Dec)
 * @param {number} [day=15] - Day of month
 * @param {number} [hour=12] - Hour of day
 * @returns {Function} Restore function returning the original Date
 */
function stubDate(monthIndex, day = 15, hour = 12) {
    const RealDate = global.Date
    class FakeDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(2026, monthIndex, day, hour, 0, 0)
            else super(...args)
        }
        static now() {
            return new RealDate(2026, monthIndex, day, hour, 0, 0).getTime()
        }
    }
    global.Date = FakeDate
    return () => { global.Date = RealDate }
}

/**
 * Create a minimal device stub recording every received command.
 * @param {string} name - Device display name
 * @returns {{name: string, calls: object[], getName: Function, receiveCommand: Function}}
 */
function makeStubDevice(name) {
    const calls = []
    return {
        name,
        calls,
        getName: () => name,
        receiveCommand: (payload, fromAutomation) => calls.push({ payload, fromAutomation }),
    }
}

const ALL_IDS = [
    'kitchen_outlet', 'hallway_outlet', 'living_switch',
]
const AMBIENT_ON_IDS = [
    'kitchen_outlet', 'hallway_outlet',
]

// Self-contained rule set mirroring ambient-lights.yaml.dist -- keeps the suite
// runnable on any machine without a local ambient-lights.yaml present.
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'automaton-ambient-test-'))
const TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, 'ambient-lights-test.yaml')
writeFileSync(TEST_CONFIG_PATH, [
    'targets:',
    "  - name: 'Kitchen Outlet'",
    '    id: kitchen_outlet',
    "  - name: 'Hallway Outlet'",
    '    id: hallway_outlet',
    "  - name: 'Living Room Switch'",
    '    id: living_switch',
    '',
    'sensors:',
    "  illuminance: 'Outdoor Luminance'",
    '',
    'triggers_zigbee:',
    "  - 'Outdoor Luminance'",
    '',
    'timer_interval_ms: 30000',
    '',
    'rules:',
    "  - name: 'Bright morning - turn off leftover lights'",
    '    once: true',
    '    conditions:',
    '      time-of-day: [morning]',
    '      illuminance: { gte: 20 }',
    '    targets:',
    '      kitchen_outlet: OFF',
    '      hallway_outlet: OFF',
    '      living_switch: OFF',
    '',
    "  - name: 'Settled dusk - turn on ambient lamps'",
    '    once: true',
    '    conditions:',
    '      time-of-day: [evening]',
    '      illuminance: { lt: 2000 }',
    '    targets:',
    '      kitchen_outlet: ON',
    '      hallway_outlet: ON',
].join('\n'))

/**
 * Test harness around the real AmbientLightsAutomation with stubbed devices/context.
 */
class TestAmbient extends AmbientLightsAutomation {
    #devices
    #context
    /**
     * @param {Map<string, object>} devices - Stub device map keyed by target id
     * @param {{illuminance?: number|null, timeOfDay: string}} context - Fabricated buildContext result
     */
    constructor(devices, context) {
        super(TEST_CONFIG_PATH)
        this.#devices = devices
        this.#context = context
    }
    loadDevices() { return this.#devices }
    async buildContext() { return this.#context }
}

async function runScenario(context) {
    const devices = new Map(ALL_IDS.map(id => [id, makeStubDevice(id)]))
    const auto = new TestAmbient(devices, context)
    await auto.execute({ trigger: 'test' })
    return devices
}

function expectPayload(devices, id, expectedState) {
    const dev = devices.get(id)
    if (expectedState === null) {
        assert(dev.calls.length === 0, `${id}: no command sent`)
        return
    }
    assert(
        dev.calls.length === 1 && JSON.stringify(dev.calls[0].payload) === JSON.stringify({ state: expectedState }),
        `${id}: received ${JSON.stringify({ state: expectedState })} exactly once`
    )
    assert(dev.calls.every(c => c.fromAutomation === DeviceCommandSource.AUTOMATION), `${id}: marked as automation-originated`)
}

console.log('\n── Ambient lights execution ──\n')

// Bright morning -> OFF for every listed device (sockets + wall switch)
let devices = await runScenario({ illuminance: 50, timeOfDay: 'morning' })
for (const id of ALL_IDS) expectPayload(devices, id, 'OFF')

// Settled dusk -> ON only for the two outlets; the wall switch stays untouched
devices = await runScenario({ illuminance: 1500, timeOfDay: 'evening' })
for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
for (const id of ALL_IDS.filter(id => !AMBIENT_ON_IDS.includes(id))) expectPayload(devices, id, null)

// Evening still bright -> nothing happens at all
devices = await runScenario({ illuminance: 8000, timeOfDay: 'evening' })
for (const id of ALL_IDS) expectPayload(devices, id, null)

// Flat per-rule "action" fallback (regression: old configs used flat action values)
{
    const dir = mkdtempSync(join(tmpdir(), 'automaton-flat-'))
    const cfgPath = join(dir, 'flat-action.yaml')
    writeFileSync(cfgPath, [
        'rules:',
        "  - name: 'flat off'",
        '    conditions: {}',
        '    action: OFF',
    ].join('\n'))

    class FlatActionAutomation extends RuleBasedAutomationBase {
        #devices
        constructor(configPath, devices) {
            super({ name: 'FlatActionTest', configPath })
            this.#devices = devices
        }
        loadDevices() { return this.#devices }
        async buildContext() { return { timeOfDay: 'morning' } }
        resolveCommand(device, targetId, matchingRules) {
            const rule = matchingRules.find(r => r.action !== undefined)
            if (!rule) return null
            const payload = String(rule.action).toUpperCase() === 'OFF' ? { state: 'OFF' } : { state: 'ON' }
            return { payload }
        }
    }

    const dev = makeStubDevice('Stub Light')
    const auto = new FlatActionAutomation(cfgPath, new Map([['stub_light', dev]]))
    await auto.execute({ trigger: 'test' })
    assert(
        dev.calls.length === 1 && JSON.stringify(dev.calls[0].payload) === '{"state":"OFF"}',
        'flat "action" fallback dispatches command to every listed device'
    )
}

// Season conditions + temporal helpers (deterministic via stubbed Date)
{
    const restoreDec = stubDate(11 /* December */)
    assert(temporal.getCurrentSeason() === 'winter', 'getCurrentSeason(): winter in December')
    assert(temporal.getLocalDayString(new Date()) === '2026-12-15', 'getLocalDayString(): local YYYY-MM-DD format')
    const auto = new TestAmbient(new Map(), { timeOfDay: 'morning' })
    assert(await auto.conditionsMatch({ season: ['winter'] }, {}), 'season [winter] matches in December')
    assert(!(await auto.conditionsMatch({ season: ['summer'] }, {})), 'season [summer] rejected in December')
    assert(!(await auto.conditionsMatch({ season: 'spring' }, {})), 'single-string season rejected when mismatched')
    restoreDec()

    const restoreJul = stubDate(6 /* July */)
    assert(temporal.getCurrentSeason() === 'summer', 'getCurrentSeason(): summer in July')
    assert(await auto.conditionsMatch({ season: ['summer', 'autumn'] }, {}), 'multi-value season list matches on one hit')
    restoreJul()
}

console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)