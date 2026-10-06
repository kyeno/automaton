/**
 * Ambient Lights automation execution tests.
 *
 * Exercises the rule-based execute() flow end-to-end using stubbed devices and
 * fabricated sensor contexts against a self-contained rule set modeled on
 * ambient-lights.yaml.dist (no local configuration required):
 *   - bright morning turns off every listed device (sockets + wall switch)
 *   - the merged "Settled dusk" rule (evening/night) turns on only the outlets
 *   - still-bright evening does nothing
 *   - per-window once semantics: one slot per time window per calendar day
 *   - a forced poke (home-theater player-gone hand-off) re-evaluates the dusk rule
 *     without consuming its once budget, while a later natural tick stays blocked
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
import CacheService from '../src/service/cacheService.js'
import LoggerService from '../src/service/loggerService.js'
import solar from '../src/lib/sun.js'

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
    'Kitchen_Outlet', 'Hallway_Outlet', 'Living_Room_Switch',
]
const AMBIENT_ON_IDS = [
    'Kitchen_Outlet', 'Hallway_Outlet',
]

// Self-contained rule set mirroring ambient-lights.yaml.dist -- keeps the suite
// runnable on any machine without a local ambient-lights.yaml present.
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'automaton-ambient-test-'))
const TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, 'ambient-lights-test.yaml')
writeFileSync(TEST_CONFIG_PATH, [
    'targets:',
    "  - 'Kitchen Outlet'",
    "  - 'Hallway Outlet'",
    "  - 'Living Room Switch'",
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
    '      time_of_day: [morning]',
    "      hour: { gte: 'sunrise' }",
    '      illuminance: { gte: 20 }',
    '    targets:',
    '      Kitchen_Outlet: OFF',
    '      Hallway_Outlet: OFF',
    '      Living_Room_Switch: OFF',
    '',
    // Merged dusk rule: covers every dark window (evening/night) in one rule. Fires
    // autonomously once per window, AND answers a home-theater player-gone hand-off -- a
    // forced poke re-evaluates it without consuming the once-per-day budget.
    "  - name: 'Settled dusk - turn on ambient lamps'",
    '    once: true',
    '    conditions:',
    '      time_of_day: [evening, night]',
    '      illuminance: { lt: 900 }',
    '    targets:',
    '      Kitchen_Outlet: ON',
    '      Hallway_Outlet: ON',
].join('\n'))

/**
 * Test harness around the real AmbientLightsAutomation with stubbed devices/context.
 */
class TestAmbient extends AmbientLightsAutomation {
    #devices
    #context
    /**
     * @param {Map<string, object>} devices - Stub device map keyed by rule-target key
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

/**
 * @param {{illuminance?: number|null, timeOfDay: string}} context - Fabricated buildContext result
 * @param {Object} [triggerData] - Extra fields merged into execute() input (e.g., `{ force: true }` for a delegated run)
 */
async function runScenario(context, triggerData = {}) {
    const devices = new Map(ALL_IDS.map(id => [id, makeStubDevice(id)]))
    const auto = new TestAmbient(devices, {
        // Sun gates resolve against the stubbed clock's own day, so dawn-gated rules stay
        // satisfied in scenarios that are not specifically about the dawn boundary.
        sundawn: solar.getSunTimes(new Date()).sundawn.getTime(),
        sundusk: solar.getSunTimes(new Date()).sundusk.getTime(),
        ...context,
    })
    await auto.execute({ trigger: 'test', ...triggerData })
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
devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
for (const id of ALL_IDS.filter(id => !AMBIENT_ON_IDS.includes(id))) expectPayload(devices, id, null)

// Evening still bright -> nothing happens at all
devices = await runScenario({ illuminance: 8000, timeOfDay: 'evening' })
for (const id of ALL_IDS) expectPayload(devices, id, null)

// Multi-window once semantics (regression): the merged [evening, night] "Settled dusk" rule
// gets ONE slot per window per calendar day -- a pre-dawn firing must not consume actual
// dusk's budget, while re-firing within the SAME window stays blocked for the rest of that
// day. Marker state is stubbed via the CacheService prototype (same approach as
// test-automation-force.js) so these assertions hold with or without live Redis.
{
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    const onceStore = new Map()
    cacheProto.get = async (key) => (onceStore.has(key) ? onceStore.get(key) : undefined)
    cacheProto.set = async (key, item) => { onceStore.set(key, item); return true }
    try {
        // Evening #1 -> dispatches and consumes today's EVENING slot only
        let devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')

        // Evening #2, same calendar day -> its own consumed evening slot blocks it again
        devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        for (const id of ALL_IDS) expectPayload(devices, id, null)

        // Night, same calendar day -> independent NIGHT slot is still free -> fires again
        devices = await runScenario({ illuminance: 50, timeOfDay: 'night' })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')

        const keys = [...onceStore.keys()]
        assert(keys.includes('auto:AmbientLightsAutomation:once:settled_dusk_-_turn_on_ambient_lamps:evening')
            && keys.includes('auto:AmbientLightsAutomation:once:settled_dusk_-_turn_on_ambient_lamps:night'),
            'per-window markers stored under distinct :evening / :night keys')
    } finally {
        cacheProto.get = origGet
        cacheProto.set = origSet
    }
}

// Forced-poke re-evaluation: a home-theater player-gone hand-off pokes this automation with
// force: true. Forced runs neither check nor write the once-per-day markers, so a poke
// re-evaluates the "Settled dusk" rule and restores the lamps even after the natural tick
// already consumed that window's budget -- and repeated pokes keep working. Crucially, the
// pokes do NOT consume the budget, so a later NATURAL tick in the same window stays blocked.
{
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    let onceStore = new Map()
    cacheProto.get = async (key) => (onceStore.has(key) ? onceStore.get(key) : undefined)
    cacheProto.set = async (key, item) => { onceStore.set(key, item); return true }
    try {
        // Natural evening tick #1 -> dispatches and consumes today's EVENING slot.
        let devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')

        // Natural evening tick #2, same day -> the consumed EVENING slot blocks it.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        for (const id of ALL_IDS) expectPayload(devices, id, null)

        // Forced poke #1 (home-theater player-gone hand-off): re-evaluates and restores again,
        // even though the EVENING slot is already consumed -- forced runs bypass the once check.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' }, { force: true })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')

        // Forced poke #2 shortly after still restores again -- forced runs neither check nor
        // write markers, so repeated hand-offs keep working.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' }, { force: true })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')

        // The forced pokes did NOT consume the once budget: a subsequent NATURAL tick in the
        // same window is still blocked by the original natural marker.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        for (const id of ALL_IDS) expectPayload(devices, id, null)
    } finally {
        cacheProto.get = origGet
        cacheProto.set = origSet
    }
}

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
    const auto = new FlatActionAutomation(cfgPath, new Map([['Stub_Light', dev]]))
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
// Pre-dawn guard (regression): the "Bright morning" rule is gated behind civil dawn via
// `hour: { gte: 'sunrise' }`. On an October morning the street sensor crossed the daytime
// lux threshold before dawn, and the 06:06 tick switched the lamps off in pitch darkness
// while the windows stayed shaded. With the gate in force the same tick must stay inert,
// and the first tick past dawn must run the morning routine.
{
    const RealDate = global.Date
    const stubClock = (hour, minute) => {
        class FakeDate extends RealDate {
            constructor(...args) { if (args.length === 0) super(2026, 9, 6, hour, minute, 0, 0); else super(...args) }
            static now() { return new RealDate(2026, 9, 6, hour, minute, 0, 0).getTime() }
        }
        global.Date = FakeDate
        return () => { global.Date = RealDate }
    }
    const civilDawn = new Date(2026, 9, 6, 6, 11, 43, 0).getTime()

    // Fresh once-markers per tick so the gate, not a consumed daily slot, decides the outcome.
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    cacheProto.get = async () => undefined
    cacheProto.set = async () => true

    // 06:06 -- daytime lux, still in pre-dawn darkness -> the morning rule must not run.
    const restore = stubClock(6, 6)
    let devices
    try {
        devices = await runScenario({ illuminance: 20, timeOfDay: 'morning', sundawn: civilDawn })
    } finally { restore() }
    for (const id of ALL_IDS) expectPayload(devices, id, null)

    // 06:20 -- the first tick past civil dawn -> the morning routine runs and clears the lamps.
    const restore2 = stubClock(6, 20)
    try {
        devices = await runScenario({ illuminance: 20, timeOfDay: 'morning', sundawn: civilDawn })
    } finally { restore2() }
    for (const id of ALL_IDS) expectPayload(devices, id, 'OFF')

    cacheProto.get = origGet
    cacheProto.set = origSet
}




console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)