/**
 * Ambient Lights automation execution tests.
 *
 * Exercises the rule-based execute() flow end-to-end using stubbed devices and
 * fabricated sensor contexts against a self-contained rule set modeled on
 * ambient-lights.yaml.dist (no local configuration required):
 *   - bright morning turns off every listed device (sockets + wall switch)
 *   - the "Settled dusk" rule (afternoon/evening) turns on only the outlets, and never before
 *     `predusk` (sunset minus 30 minutes) -- inert 45 min before dusk, live 15 min before it
 *   - still-bright evening does nothing
 *   - per-window once semantics: one slot per time window per calendar day
 *   - both shipped configs flag the settled-dusk rule with reassert_state so a stale cache can
 *     never desync the paired lamps at the daily transition (doc/BUGS.md issue 3)
 *   - the invoke-only "Pre-dawn restore" rule never fires on a natural tick, so a pre-dawn
 *     firing cannot consume the dusk budget; a forced hand-off restores and consumes nothing
 *   - a forced poke (home-theater player-gone hand-off) re-evaluates the dusk rule
 *     without consuming its once budget, while a later natural tick stays blocked
 *   - the hallway cupboard lamp: lit at dusk with the rest, put out by the post-midnight rule,
 *     cleared by the bright-morning safety net, and deliberately absent from the pre-dawn restore
 *     (every matching rule acts on a shared target, so a restore ON there would fight it)
 *   - restore coverage parity: the pre-dawn restore covers every dusk target and stays out of
 *     presence-owned room lights, which come back through their own presence-gated rule on the
 *     same hand-off poke -- at their own levels, and only when someone is home
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

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse as yamlParse } from 'yaml'

import { createClient } from 'redis'

import ConfigService from '../src/service/configService.js'
import CacheService from '../src/service/cacheService.js'
import LoggerService from '../src/service/loggerService.js'
import solar from '../src/lib/sun.js'
import networkPresence from '../src/monitor/networkPresence.js'

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
 * Stub global Date to an exact epoch instant. Used by the dusk scenarios: the settled-dusk rule
 * is floored on `predusk` (sunset minus 30 minutes), so a scenario that exercises it has to
 * pin "now" relative to that day's real dusk instead of running at whatever hour the suite does.
 * @param {number} ms - Epoch milliseconds to pin the clock to.
 * @returns {Function} Restore function returning the original Date
 */
function stubAtMs(ms) {
    const RealDate = global.Date
    class FakeDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(ms); else super(...args) }
        static now() { return ms }
    }
    global.Date = FakeDate
    return () => { global.Date = RealDate }
}

/**
 * Epoch ms of an instant `offsetMs` past the sunset of the CURRENT real day -- the canonical
 * "dusk has settled" clock. Offsets from the computed dusk (not wall times) keep the assertions
 * deterministic at any latitude and in any season.
 * @param {number} [offsetMs=900000] - Offset from sunset (negative = before dusk).
 * @returns {number} Epoch milliseconds
 */
function duskInstant(offsetMs = 15 * 60_000) {
    return solar.getSunTimes(new Date()).sundusk.getTime() + offsetMs
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
// The hallway cupboard lamp: lit at dusk like the others, but owned by the post-midnight rule
// that puts it out for the night, so it is deliberately NOT in AMBIENT_ON_IDS (the pre-dawn
// restore set) -- see the restore-coverage invariant below.
const CUPBOARD_ID = 'Hallway_Cupboard_Outlet'
const SCENARIO_IDS = [...ALL_IDS, CUPBOARD_ID]
// The presence-owned room light: it is deliberately NOT in the pre-dawn restore rule, and
// comes back through its own presence-gated rule on the same hand-off poke.
const ROOM_LIGHT_ID = 'Living_Room_Switch'
const ROOM_LIGHT_ON = { state: 'ON', brightness: { l1: 100, l2: 100 } }

// Self-contained rule set mirroring ambient-lights.yaml.dist -- keeps the suite
// runnable on any machine without a local ambient-lights.yaml present.
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'automaton-ambient-test-'))
const TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, 'ambient-lights-test.yaml')
writeFileSync(TEST_CONFIG_PATH, [
    'targets:',
    "  - 'Kitchen Outlet'",
    "  - 'Hallway Outlet'",
    "  - 'Hallway Cupboard Outlet'",
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
    '      Hallway_Cupboard_Outlet: OFF',
    '      Living_Room_Switch: OFF',
    '',
    // Settled dusk: both dusk windows at the top level, floored on `predusk` -- sunset 30
    // minutes ahead. Each window keeps its own `once:` slot, and the single sun floor covers
    // both, so a gloomy mid-afternoon can never light the lamps before dusk has settled.
    // reassert_state mirrors the shipped configs: paired lamps must flip together even when a
    // cached state is stale (an earlier unconfirmed command left it pre-command).
    "  - name: 'Settled dusk - turn on ambient lamps'",
    '    once: true',
    '    reassert_state: true',
    '    conditions:',
    '      time_of_day: [afternoon, evening]',
    "      hour: { gte: 'predusk' }",
    '      illuminance: { lt: 900 }',
    '    targets:',
    '      Kitchen_Outlet: ON',
    '      Hallway_Outlet: ON',
    '      Hallway_Cupboard_Outlet: ON',
    '',
    // Past midnight: the cupboard lamp goes out for the night. Listed AFTER the dusk rule on
    // purpose -- when several matching rules name the same target, every one of them acts and the
    // LAST one in config order wins the field it names, so this OFF outranks the dusk ON on this
    // socket alone. `once: true` with a `time_of_day` gate is window-scoped: it consumes only the
    // `night` slot, never the dusk rule's `evening`/`afternoon` budgets.
    "  - name: 'Past midnight - turn off hallway cupboard lamp'",
    '    once: true',
    '    conditions:',
    '      time_of_day: [night]',
    '    targets:',
    '      Hallway_Cupboard_Outlet: OFF',
    '',
    // Pre-dawn restore: invoke-only. It answers a home-theater player-gone hand-off (a forced
    // poke, which bypasses markers entirely) and never fires on a natural tick, so a 00:26
    // presence blip in the middle of a session cannot blast the lamps.
    "  - name: 'Pre-dawn restore - turn on ambient lamps'",
    '    forced_only: true',
    '    conditions:',
    '      time_of_day: [night, morning]',
    "      hour: { lt: 'sunrise' }",
    '      illuminance: { lt: 900 }',
    '    targets:',
    '      Kitchen_Outlet: ON',
    '      Hallway_Outlet: ON',
    '',
    // Presence-owned room light, mirroring the live salon rule. The home-theater hand-off poke
    // re-evaluates THIS rule too, so an occupant gets the light back at its own level and an
    // empty house stays dark -- which is why the room light is not in the restore rule above.
    "  - name: 'After sunset - someone home - full room ambient'",
    '    once: true',
    '    conditions:',
    '      time_of_day: [afternoon, evening, night, morning]',
    '      illuminance: { lt: 900 }',
    '      all_of:',
    '        - any_of:',
    "            - hour: { gte: 'sunset' }",
    "            - hour: { lt: 'sunrise' }",
    '        - any_of:',
    '            - presence: kyeno',
    '            - presence: meerkat',
    '    targets:',
    "      Living_Room_Switch: { state: 'ON', brightness: { l1: 100, l2: 100 } }",
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
    const devices = new Map(SCENARIO_IDS.map(id => [id, makeStubDevice(id)]))
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

function expectPayload(devices, id, expected) {
    const dev = devices.get(id)
    if (expected === null) {
        assert(dev.calls.length === 0, `${id}: no command sent`)
        return
    }
    // A bare state string, or a full structured payload ({state, brightness}) for dimmers.
    const want = (typeof expected === 'object') ? expected : { state: expected }
    assert(
        dev.calls.length === 1 && JSON.stringify(dev.calls[0].payload) === JSON.stringify(want),
        `${id}: received ${JSON.stringify(want)} exactly once`
    )
    assert(dev.calls.every(c => c.fromAutomation === DeviceCommandSource.AUTOMATION), `${id}: marked as automation-originated`)
}

// Presence is resolved live through the network-presence monitor, not through the fabricated
// context, so it is stubbed for the whole run. Default: nobody home -- that keeps the
// presence-owned room light out of every scenario that is not about presence.
let PRESENCE = {}
Object.getPrototypeOf(networkPresence).isOnline = async (name) => PRESENCE[name] === true

console.log('\n── Ambient lights execution ──\n')

// Bright morning -> OFF for every listed device (sockets + wall switch)
let devices = await runScenario({ illuminance: 50, timeOfDay: 'morning' })
for (const id of ALL_IDS) expectPayload(devices, id, 'OFF')

// Settled dusk -> ON only for the two outlets; the wall switch stays untouched. The clock is
// pinned just past that day's sunset: the rule is floored on `predusk`, so a scenario that
// exercises it must sit above that floor whatever hour the suite happens to run at.
{
    const restoreDusk = stubAtMs(duskInstant())
    try { devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' }) } finally { restoreDusk() }
}
for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
for (const id of ALL_IDS.filter(id => !AMBIENT_ON_IDS.includes(id))) expectPayload(devices, id, null)

// Evening still bright -> nothing happens at all
devices = await runScenario({ illuminance: 8000, timeOfDay: 'evening' })
for (const id of ALL_IDS) expectPayload(devices, id, null)

// Gloomy mid-afternoon BEFORE sunset (regression for the 2026-10-10 14:53 incident):
// sub-threshold illuminance must NOT light the lamps while the sun is still up -- the
// afternoon arm waits for `hour >= sunset`, and the unguarded evening arm does not cover 14:xx.
{
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    cacheProto.get = async () => undefined   // no markers: only the gate decides
    cacheProto.set = async () => true
    const restoreClock = stubDate(9 /* October */, 10, 14)   // 14:00; that day's dusk ~18:3x
    try {
        let devices = await runScenario({ illuminance: 686, timeOfDay: 'afternoon' })
        for (const id of ALL_IDS) expectPayload(devices, id, null)
    } finally {
        restoreClock()
        cacheProto.get = origGet
        cacheProto.set = origSet
    }
}

// The `predusk` floor in a winter afternoon (regression for the season gap): the floor is civil
// dusk 30 minutes ahead, and it covers EVERY window the dusk rule lists -- `afternoon` included,
// which is where winter dusk lands. Probe instants are offsets from that day's computed civil
// dusk, so the assertions hold at any latitude: 45 minutes before dusk stays dark, 15 minutes
// before it lights the lamps.
{
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    cacheProto.get = async () => undefined   // no markers: only the gate decides
    cacheProto.set = async () => true
    // Read that day's sunset with the clock parked on the 15th of December, then probe
    // relative to it. December dusk sits deep inside the `afternoon` window.
    const readDecDusk = stubDate(11 /* December */, 15, 12)
    const decDusk = solar.getSunTimes(new Date()).sundusk.getTime()
    readDecDusk()
    try {
        const beforeFloor = stubAtMs(decDusk - 45 * 60_000)
        try {
            const devices = await runScenario({ illuminance: 50, timeOfDay: 'afternoon' })
            for (const id of ALL_IDS) expectPayload(devices, id, null)
        } finally { beforeFloor() }

        const pastFloor = stubAtMs(decDusk - 15 * 60_000)
        try {
            const devices = await runScenario({ illuminance: 50, timeOfDay: 'afternoon' })
            for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
        } finally { pastFloor() }
    } finally {
        cacheProto.get = origGet
        cacheProto.set = origSet
    }
}

// Multi-window once semantics (regression): the "Settled dusk" rule gets ONE slot per window
// per calendar day -- a gloomy winter afternoon firing must not consume the dusk slot, while
// re-firing within the SAME window stays blocked for the rest of that day. Marker state is
// stubbed via the CacheService prototype (same approach as test-automation-force.js) so these
// assertions hold with or without live Redis.
{
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    const onceStore = new Map()
    cacheProto.get = async (key) => (onceStore.has(key) ? onceStore.get(key) : undefined)
    cacheProto.set = async (key, item) => { onceStore.set(key, item); return true }
    // Pin the clock to a post-dusk winter afternoon (~16:3x sunset): the afternoon arm
    // requires `hour >= sunset`, so this scenario runs past it -- deterministically, any month.
    const restoreClock = stubDate(11 /* December */, 15, 17)
    try {
        // Evening #1 -> dispatches and consumes today's EVENING slot only
        let devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')

        // Evening #2, same calendar day -> its own consumed evening slot blocks it again
        devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        for (const id of ALL_IDS) expectPayload(devices, id, null)

        // Afternoon, same calendar day -> independent AFTERNOON slot is still free and the clock
        // sits past that day's sunset -> fires. The winter case: dusk lands inside
        // `afternoon`, so the two windows must never share a budget.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'afternoon' })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')

        const keys = [...onceStore.keys()].sort()
        assert(keys.includes('auto:AmbientLightsAutomation:once:settled_dusk_-_turn_on_ambient_lamps:evening')
            && keys.includes('auto:AmbientLightsAutomation:once:settled_dusk_-_turn_on_ambient_lamps:afternoon'),
            'per-window markers stored under distinct :afternoon / :evening keys')
        assert(!keys.some((k) => !k.endsWith(':evening') && !k.endsWith(':afternoon')),
            `no all-day marker was written (${JSON.stringify(keys)})`)
    } finally {
        restoreClock()
        cacheProto.get = origGet
        cacheProto.set = origSet
    }
}

// Pre-dawn hand-off (regression): the merged dusk rule used to carry an `hour: { lt: sunrise }`
// arm, so a natural 00:26 tick fired it and consumed the rule's WHOLE daily budget -- the real
// dusk firing hours later was silently skipped with "already acted today". That arm is now its
// own invoke-only rule: a natural pre-dawn tick must send NOTHING, while the home-theater
// player-gone hand-off (a forced poke) must restore the lamps, every time, consuming nothing.
{
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    const onceStore = new Map()
    cacheProto.get = async (key) => (onceStore.has(key) ? onceStore.get(key) : undefined)
    cacheProto.set = async (key, item) => { onceStore.set(key, item); return true }
    const restoreClock = stubDate(9 /* October */, 15, 2)   // 02:00 -- inside the night window
    try {
        // Natural pre-dawn tick -> the invoke-only restore rule stays out. The only rule that
        // acts is the post-midnight one, putting the cupboard lamp out for the night.
        let devices = await runScenario({ illuminance: 50, timeOfDay: 'night' })
        for (const id of ALL_IDS) expectPayload(devices, id, null)
        expectPayload(devices, CUPBOARD_ID, 'OFF')

        // Forced hand-off at the same instant -> the invoke-only restore rule fires, and it
        // restores the lamps it owns. The cupboard lamp is NOT among them: the post-midnight
        // rule owns it and keeps it out. The presence-owned room light is not among them
        // either; it is covered by the presence scenario below.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'night' }, { force: true })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
        expectPayload(devices, ROOM_LIGHT_ID, null)
        expectPayload(devices, CUPBOARD_ID, 'OFF')

        // Repeated hand-offs keep working -- forced runs neither check nor write markers.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'night' }, { force: true })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
        expectPayload(devices, ROOM_LIGHT_ID, null)
        expectPayload(devices, CUPBOARD_ID, 'OFF')

        // The hand-offs consumed nothing: the only marker in the store is the natural tick's own
        // post-midnight slot, earned by the one rule that legitimately acted on that tick.
        assert([...onceStore.keys()].every((k) => k.includes('past_midnight_')),
            `pre-dawn hand-offs consumed no budget (${JSON.stringify([...onceStore.keys()])})`)

        // The evening budget is untouched, so the dusk firing that the old merged rule lost
        // now happens normally -- and dusk still leaves the wall switch to its own rules. The
        // clock moves to 19:00, past the rule's `predusk` floor, which 02:00 would never clear.
        const restoreEvening = stubDate(9 /* October */, 15, 19)
        try {
            devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        } finally { restoreEvening() }
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
        for (const id of ALL_IDS.filter((i) => !AMBIENT_ON_IDS.includes(i))) expectPayload(devices, id, null)
    } finally {
        restoreClock()
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
    // Pinned just past sunset: every tick here exercises the dusk rule, which is floored on
    // `predusk` and would stay inert at an arbitrary wall-clock hour.
    const restoreClock = stubAtMs(duskInstant())
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
        restoreClock()
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




// Post-dusk gate (regression for the 2026-10-10 incident): commit 6bea899 made `afternoon` a
// bare top-level window in the settled-dusk rule, so a gloomy mid-afternoon below the lux
// threshold lit the lamps hours before sunset. Both shipped configs must now carry a single
// sun floor -- `hour: { gte: predusk }`, sunset minus 30 minutes -- covering EVERY window the
// rule lists, so no window can light the lamps before dusk has settled in any season.
{
    const DUSK_RULE = 'Settled dusk - turn on ambient lamps'
    for (const file of ['etc/automation/ambient-lights.yaml.dist', 'etc/automation/ambient-lights.yaml']) {
        if (!existsSync(file)) continue
        const rules = yamlParse(readFileSync(file, 'utf8')).rules ?? []
        const rule = rules.find((r) => r.name === DUSK_RULE) ?? {}
        const conds = rule.conditions ?? {}
        assert(JSON.stringify(conds.time_of_day) === JSON.stringify(['afternoon', 'evening']),
            `${file}: settled dusk lists both dusk windows at the top level`)
        assert(conds.hour?.gte === 'predusk',
            `${file}: settled dusk floors every window on predusk (sunset minus 30 min)`)
        assert(conds.any_of === undefined,
            `${file}: no unguarded arm survives -- the sun floor covers every window`)
        assert(rule.reassert_state === true,
            `${file}: settled dusk re-asserts state so a stale cache cannot desync paired lamps`)
    }
}

// Restore-coverage parity (regression): the invoke-only pre-dawn restore answers a home-theater
// player-gone hand-off. Three invariants keep it honest. (1) It must cover every device the dusk
// rule lights -- a target the dusk rule lights and the restore rule omits stays dark after a
// hand-off. (2) It must stay out of every device a PRESENCE-gated rule owns. Those are room
// lights that should only burn when someone is in the room; the restore rule is presence-blind,
// and the very same forced poke re-evaluates their own rules too, so an occupant gets each one
// back at its OWN level while an empty house stays dark. Listing a presence-owned target in the
// restore rule would light an empty room and override the level its own rule chose. (3) A dusk
// target may be skipped ONLY when a post-midnight rule owns it -- that is the hallway cupboard
// lamp carve-out: the restore rule is a FORCED, human-triggered poke, and the rule that puts the
// cupboard out at midnight has already spent its once-per-night slot by 3am, so re-lighting it
// there would leave no way to put it back out before sunrise.
{
    const RESTORE_RULE = 'Pre-dawn restore - turn on ambient lamps'
    const DUSK_RULE = 'Settled dusk - turn on ambient lamps'

    /** Detect a `presence` gate anywhere in a condition tree (top level, any_of, all_of). */
    const hasPresence = (cond) => {
        if (!cond || typeof cond !== 'object') return false
        if (Object.prototype.hasOwnProperty.call(cond, 'presence')) return true
        return Object.values(cond).some((v) => Array.isArray(v)
            ? v.some((item) => hasPresence(item))
            : hasPresence(v))
    }

    // Checked on every ambient config that exists (dist is tracked, the live file is
    // deployment-specific).
    for (const file of ['etc/automation/ambient-lights.yaml.dist', 'etc/automation/ambient-lights.yaml']) {
        if (!existsSync(file)) continue
        const rules = yamlParse(readFileSync(file, 'utf8')).rules ?? []
        const byName = new Map(rules.map((r) => [r.name, r]))
        const dusk = Object.keys(byName.get(DUSK_RULE)?.targets ?? {})
        const restore = Object.keys(byName.get(RESTORE_RULE)?.targets ?? {})

        // Targets a post-midnight rule owns -- a rule gated to the night window ALONE (the
        // presence-owned room light lists every window, and the restore rule is the hand-off
        // responder, so neither of them owns the midnight).
        const midnightOwned = new Set(rules
            .filter((r) => r.name !== RESTORE_RULE)
            .filter((r) => JSON.stringify(r.conditions?.time_of_day) === JSON.stringify(['night']))
            .flatMap((r) => Object.keys(r.targets ?? {})))
        const skipped = dusk.filter((t) => !restore.includes(t))
        const missing = skipped.filter((t) => !midnightOwned.has(t))
        assert(missing.length === 0, `${file}: pre-dawn restore covers every dusk target (${JSON.stringify(missing)})`)
        assert(JSON.stringify([...skipped].sort()) === JSON.stringify([...midnightOwned].sort()),
            `${file}: the only dusk targets the pre-dawn restore skips are post-midnight-owned ones `
            + `(skipped ${JSON.stringify(skipped)}, midnight-owned ${JSON.stringify([...midnightOwned])})`)
        //  (3) Each carved-out target must be put out by a night rule, so it can never survive the night.
        const midnightOff = new Set(rules
            .filter((r) => JSON.stringify(r.conditions?.time_of_day) === JSON.stringify(['night']))
            .filter((r) => Object.values(r.targets ?? {}).every((v) => String(v).toUpperCase() === 'OFF'))
            .flatMap((r) => Object.keys(r.targets ?? {})))
        assert(skipped.every((t) => midnightOff.has(t)),
            `${file}: every carved-out target is put out by a night rule `
            + `(${JSON.stringify(skipped.filter((t) => !midnightOff.has(t)))})`)
        assert(byName.get(RESTORE_RULE)?.forced_only === true, `${file}: pre-dawn restore stays invoke-only`)

        const presenceOwned = new Set()
        for (const r of rules) {
            if (r.name === RESTORE_RULE || !hasPresence(r.conditions)) continue
            for (const t of Object.keys(r.targets ?? {})) presenceOwned.add(t)
        }
        const hijacked = restore.filter((t) => presenceOwned.has(t))
        // A template may ship without presence rules; a real deployment that has room lights
        // must, or this guard would be silently vacuous.
        if (file.endsWith('ambient-lights.yaml')) {
            assert(presenceOwned.size > 0, `${file}: deployment config has presence-owned targets to guard`)
        }
        assert(hijacked.length === 0,
            `${file}: pre-dawn restore stays out of presence-owned targets (${JSON.stringify(hijacked)})`)
    }
}

// Presence-owned room light (regression): the salon-style room light is deliberately NOT in the
// invoke-only pre-dawn restore rule -- it belongs to a presence-gated rule of its own, at its
// own levels. A home-theater player-gone hand-off force-pokes this automation, and a forced run
// re-evaluates EVERY rule, so the room light comes back through ITS rule at ITS level when
// someone is home, and an empty house at 03:00 stays dark.
{
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    cacheProto.get = async () => undefined
    cacheProto.set = async () => true
    const restoreClock = stubDate(9 /* October */, 15, 3)   // 03:00 -- dark, before civil dawn
    try {
        // Empty house, powered-off host: the hand-off restores the lamps it owns, and the room
        // light stays off -- nobody is in it.
        PRESENCE = { kyeno: false, meerkat: false }
        let devices = await runScenario({ illuminance: 50, timeOfDay: 'night' }, { force: true })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
        expectPayload(devices, ROOM_LIGHT_ID, null)

        // Someone home: the same poke re-evaluates the presence rule, and the room light comes
        // back at its OWN 100/100 -- not at the home-theater pause level.
        PRESENCE = { kyeno: true, meerkat: false }
        devices = await runScenario({ illuminance: 50, timeOfDay: 'night' }, { force: true })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
        expectPayload(devices, ROOM_LIGHT_ID, ROOM_LIGHT_ON)

        // Natural pre-dawn tick with someone home: the restore rule stays invoke-only, so only
        // the presence rule participates -- the lamps it does not own stay untouched.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'night' })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, null)
        expectPayload(devices, ROOM_LIGHT_ID, ROOM_LIGHT_ON)
    } finally {
        restoreClock()
        PRESENCE = {}
        cacheProto.get = origGet
        cacheProto.set = origSet
    }
}


// ── 10. Hallway cupboard lamp: lit at dusk, out after midnight, never survives daylight ──
// The post-midnight rule owns this socket alone, and it is listed AFTER the dusk rule: when
// several matching rules name the same target, EVERY one of them acts and the last one in config
// order wins the field it names, so no rule is shadowed by an earlier one.
{
    const cacheProto = Object.getPrototypeOf(CacheService)
    const origGet = cacheProto.get
    const origSet = cacheProto.set
    const onceStore = new Map()
    cacheProto.get = async (key) => (onceStore.has(key) ? onceStore.get(key) : undefined)
    cacheProto.set = async (key, item) => { onceStore.set(key, item); return true }

    // 19:00 (evening) -- dusk settles: the cupboard lamp comes on WITH the other lamps.
    let restoreClock = stubDate(9 /* October */, 15, 19)
    try {
        const devices = await runScenario({ illuminance: 50, timeOfDay: 'evening' })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
        expectPayload(devices, CUPBOARD_ID, 'ON')
    } finally { restoreClock() }

    // 01:00 (night) -- midnight has passed: the cupboard lamp goes out and nothing else moves.
    // The dusk rule is not a participant here (its windows are evening/afternoon), so exactly one
    // rule acts and its once: marker is scoped to the `night` window only.
    restoreClock = stubDate(9, 15, 1)
    try {
        let devices = await runScenario({ illuminance: 50, timeOfDay: 'night' })
        expectPayload(devices, CUPBOARD_ID, 'OFF')
        for (const id of ALL_IDS) expectPayload(devices, id, null)
        assert([...onceStore.keys()]
            .includes('auto:AmbientLightsAutomation:once:past_midnight_-_turn_off_hallway_cupboard_lamp:night'),
            'midnight rule consumes only its own :night once-slot')

        // A second post-midnight tick the same night -> the consumed slot stands down, so a human
        // who relights the cupboard lamp after midnight keeps it lit.
        devices = await runScenario({ illuminance: 50, timeOfDay: 'night' })
        for (const id of SCENARIO_IDS) expectPayload(devices, id, null)
    } finally { restoreClock() }

    // Forced 03:00 hand-off poke: TWO rules match the same run and each contributes its own
    // target -- the invoke-only pre-dawn restore relights the lamps it owns while the midnight
    // rule keeps the cupboard lamp out. This is the "every matching rule acts" contract, and the
    // reason the cupboard lamp is deliberately absent from the restore rule.
    restoreClock = stubDate(9, 15, 3)
    try {
        const devices = await runScenario({ illuminance: 50, timeOfDay: 'night' }, { force: true })
        for (const id of AMBIENT_ON_IDS) expectPayload(devices, id, 'ON')
        expectPayload(devices, CUPBOARD_ID, 'OFF')
        expectPayload(devices, ROOM_LIGHT_ID, null)
    } finally { restoreClock() }

    cacheProto.get = origGet
    cacheProto.set = origSet
}

// Morning safety net: the cupboard lamp is in the bright-morning rule as well, so it cannot
// survive into daylight even on a day that produced no post-midnight trigger at all.
{
    const devices = await runScenario({ illuminance: 50, timeOfDay: 'morning' })
    for (const id of ALL_IDS) expectPayload(devices, id, 'OFF')
    expectPayload(devices, CUPBOARD_ID, 'OFF')
}

// Config shape (both shipped configs): lit at dusk, out after midnight, cleared at bright
// morning, and kept OUT of the invoke-only pre-dawn restore -- that rule is a FORCED,
// human-triggered poke, and by 3am the midnight rule has spent its once-per-night slot, so
// re-lighting the cupboard lamp there would leave no way to put it back out before sunrise.
{
    const DUSK_RULE = 'Settled dusk - turn on ambient lamps'
    const MIDNIGHT_RULE = 'Past midnight - turn off hallway cupboard lamp'
    const RESTORE_RULE = 'Pre-dawn restore - turn on ambient lamps'
    const MORNING_RULE = 'Bright morning - turn off leftover lights'
    for (const file of ['etc/automation/ambient-lights.yaml.dist', 'etc/automation/ambient-lights.yaml']) {
        if (!existsSync(file)) continue
        const rules = yamlParse(readFileSync(file, 'utf8')).rules ?? []
        const byName = new Map(rules.map((r) => [r.name, r]))
        const cupboard = file.endsWith('.dist') ? 'Hallway_Cupboard_Outlet' : 'Przedpokoj_Gniazdo_Szafka'
        const idx = (name) => rules.findIndex((r) => r.name === name)

        assert(byName.get(DUSK_RULE)?.targets?.[cupboard] === 'ON', `${file}: dusk lights the cupboard lamp`)
        assert(byName.get(MIDNIGHT_RULE)?.targets?.[cupboard] === 'OFF', `${file}: midnight rule puts it out`)
        assert(JSON.stringify(byName.get(MIDNIGHT_RULE)?.conditions?.time_of_day) === JSON.stringify(['night']),
            `${file}: midnight rule is gated to the night window`)
        assert(byName.get(MIDNIGHT_RULE)?.once === true, `${file}: midnight rule fires once per night`)
        assert(Object.keys(byName.get(MIDNIGHT_RULE)?.targets ?? {}).length === 1,
            `${file}: midnight rule owns the cupboard lamp alone`)
        assert(idx(MIDNIGHT_RULE) > idx(DUSK_RULE),
            `${file}: midnight rule is listed after the dusk rule (last matching rule wins the field)`)
        assert(byName.get(MORNING_RULE)?.targets?.[cupboard] === 'OFF', `${file}: morning safety net clears it`)
        assert(byName.get(RESTORE_RULE)?.targets?.[cupboard] === undefined,
            `${file}: pre-dawn restore stays out of the cupboard lamp (documented carve-out)`)
    }
}


console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)