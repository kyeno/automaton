/**
 * Home-office roller morning-darkness regression.
 *
 * Reproduces the October-morning failure: the street sensor crossed the 20 lux daytime
 * threshold before civil dawn, the roller rules gated on geometric sunrise, and the
 * ambient lights switched off in pre-dawn darkness while the windows stayed shaded.
 *
 * Pins Warsaw 2026-10-06 (civil dawn 06:11, geometric sunrise 06:45 -- a ~34 minute gap)
 * and drives the tuned rule set through the real execute() flow:
 *   - pre-dawn tick (06:06, 20 lux): nothing dispatches -- the open rule is gated behind
 *     civil dawn, the park rule needs 200 lux, the dark-close rule needs 15 lux
 *   - first post-dawn tick (06:20, 20 lux): the open rule fires and opens the windows
 *   - occupied morning at 250 lux: the park rule out-votes OPEN (most-closed-wins)
 *   - occupied morning at 150 lux: below the park floor, OPEN wins unopposed
 *   - the merge log names every contributing rule, so an out-vote is traceable
 *
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

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import networkPresence from '../src/monitor/networkPresence.js'
import solar from '../src/lib/sun.js'
import temporal from '../src/lib/date.js'
import { getSunTimes as astroTimes } from 'sunrise-sunset-js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init(['locale.geo_latitude: 52.2307', 'locale.geo_longitude: 21.0122'])
LoggerService.init()

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) { console.log(`  ✓ ${label}`); passed++ }
    else { console.error(`  ✗ ${label}`); failed++ }
}


// ---------------------------------------------------------------------------
// Fixed reference day: Warsaw, 6 October 2026 (the morning that broke)
// ---------------------------------------------------------------------------

const REF_Y = 2026
const REF_M = 9 // October (zero-based)
const REF_D = 6
const RealDate = global.Date
const MIDNIGHT = new RealDate(REF_Y, REF_M, REF_D).setHours(0, 0, 0, 0)

/** Epoch ms at HH:MM on the reference day. */
function HM(hour, minute) { return new RealDate(REF_Y, REF_M, REF_D, hour, minute, 0, 0).getTime() }

/** Fractional hour (0-24) of an epoch instant on the reference day. */
function frac(ms) { return (ms - MIDNIGHT) / 3_600_000 }

/**
 * Stub global Date to an exact clock moment on the reference day.
 * @param {number} hour - Hour of day
 * @param {number} minute - Minute of hour
 * @returns {Function} Restore function returning the original Date
 */
function stubClockAt(hour, minute) {
    class FakeDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(REF_Y, REF_M, REF_D, hour, minute, 0, 0)
            else super(...args)
        }
        static now() { return new RealDate(REF_Y, REF_M, REF_D, hour, minute, 0, 0).getTime() }
    }
    global.Date = FakeDate
    return () => { global.Date = RealDate }
}

/**
 * Create a minimal device stub recording every received command.
 * @param {string} name - Device display name
 * @returns {object} Stub device
 */
function makeStubDevice(name) {
    const calls = []
    return {
        name,
        calls,
        getName: () => name,
        receiveCommand: (payload, fromAutomation) => calls.push({ payload, fromAutomation }),
        getStateLast: () => null,
        getStateOrigin: () => 'unknown',
        getStateLastAt: () => null,
    }
}

/**
 * The tuned rule set, mirroring etc/automation/home-office-rollers.yaml: the open rule is
 * gated behind civil dawn, and the office park rule only engages from 200 lux up.
 */
const RULES = [
    {
        name: 'Morning: Dark - close',
        conditions: { time_of_day: ['morning'], illuminance: { lte: 15 } },
        targets: { Salon_Roleta_Okno_Lewe: 'CLOSE', Salon_Roleta_Okno_Prawe: 'CLOSE' },
    },
    {
        name: 'Day: Warm, not too bright - open',
        conditions: {
            time_of_day: ['morning', 'noon', 'afternoon', 'evening'],
            hour: { gte: 'sunrise' },
            illuminance: { gt: 15, lt: 11000 },
            temperature: { lt: 25 },
        },
        targets: { Salon_Roleta_Okno_Lewe: 'OPEN', Salon_Roleta_Okno_Prawe: 'OPEN' },
    },
    {
        name: 'Day: Kyeno present, not too bright',
        conditions: {
            time_of_day: ['morning', 'noon', 'afternoon'],
            hour: { gte: 'sunrise' },
            illuminance: { gte: 200, lte: 11000 },
            presence: 'hostname1',
        },
        targets: { Salon_Roleta_Okno_Lewe: 40, Salon_Roleta_Okno_Prawe: 12 },
    },
]

const TARGET_IDS = ['Salon_Roleta_Okno_Lewe', 'Salon_Roleta_Okno_Prawe']

/** Roller automation with injected rules, fabricated context and captured logs. */
class TestRollers extends RuleBasedAutomationBase {
    #devices
    #context

    /**
     * @param {Map<string, object>} devices - Target-key -> stub device
     * @param {object} context - Fabricated buildContext() result
     */
    constructor(devices, context) {
        super({ name: 'MorningDarknessTest', configPath: '/dev/null' })
        this.#devices = devices
        this.#context = context
    }

    loadDevices() { return this.#devices }
    async buildContext() { return this.#context }
    resolveCommand(device, targetId, matchingRules) {
        return this.blindsResolveCommand(device, targetId, matchingRules)
    }
}

/**
 * Run one tick of the roller automation at an exact clock moment.
 * @param {number} hour - Stubbed clock hour
 * @param {number} minute - Stubbed clock minute
 * @param {{illuminance: number, temperature?: number}} reading - Fabricated sensor values
 * @returns {Promise<{devices: Map<string, object>, logs: {message: string, level: string}[]}>}
 *   Devices after execute() plus every log line the automation emitted
 */
async function runAt(hour, minute, reading) {
    const restore = stubClockAt(hour, minute)
    try {
        const devices = new Map(TARGET_IDS.map((id) => [id, makeStubDevice(id)]))
        const sun = solar.getSunTimes(new Date(REF_Y, REF_M, REF_D, 12))
        const auto = new TestRollers(devices, {
            timeOfDay: temporal.getCurrentTimePeriod(),
            illuminance: reading.illuminance,
            temperature: reading.temperature ?? 20,
            sundawn: sun.sundawn.getTime(),
            sundusk: sun.sundusk.getTime(),
        })
        const logs = []
        auto.log = (message, level = 'info') => logs.push({ message, level })
        auto.config = { rules: RULES }
        await auto.execute({ trigger: 'test' })
        return { devices, logs }
    } finally {
        restore()
    }
}

/**
 * Assert the exact payload sequence a device received.
 * @param {Map<string, object>} devices - Device map from runAt()
 * @param {string} id - Target key
 * @param {(object|string)[]} expected - Expected payloads in order
 * @param {string} label - Assertion label
 */
function assertCalls(devices, id, expected, label) {
    const actual = devices.get(id).calls.map((c) => JSON.stringify(c.payload))
    const want = expected.map((p) => JSON.stringify(p))
    const match = actual.length === want.length && actual.every((v, i) => v === want[i])
    assert(match, `${label} (got [${actual.join(', ') || 'none'}])`)
}

// ---------------------------------------------------------------------------
// A. Civil-twilight sun gates for Warsaw on the reference day
// ---------------------------------------------------------------------------

console.log('\n── Warsaw 2026-10-06 sun gates ──\n')

const sunToday = solar.getSunTimes(new Date(REF_Y, REF_M, REF_D, 12))
const astro = astroTimes(52.2307, 21.0122, new Date(REF_Y, REF_M, REF_D, 12))
const dawnClock = temporal.formatClockHour(frac(sunToday.sundawn.getTime()))
const duskClock = temporal.formatClockHour(frac(sunToday.sundusk.getTime()))
const sunriseClock = temporal.formatClockHour(frac(astro.sunrise.getTime()))
const sunsetClock = temporal.formatClockHour(frac(astro.sunset.getTime()))

assert(dawnClock === '06:12', `sundawn is civil dawn 06:11:43 -> ${dawnClock} rounded (got ${dawnClock})`)
assert(duskClock === sunsetClock, `sundusk is actual sunset ${sunsetClock} (got ${duskClock})`)
assert(sunToday.sundawn.getTime() === astro.twilight.civilDawn.getTime(),
    'sundawn resolves to sunrise-sunset-js twilight.civilDawn')
assert(sunToday.sundusk.getTime() === astro.sunset.getTime(),
    'sundusk resolves to sunrise-sunset-js sunset')

const dawnGapMin = Math.round((frac(astro.sunrise.getTime()) - frac(sunToday.sundawn.getTime())) * 60)
assert(dawnGapMin >= 25,
    `civil dawn leads geometric sunrise (${sunriseClock}) by ${dawnGapMin} min -- the pre-dawn darkness window`)
const duskGapMin = Math.round((frac(sunToday.sundusk.getTime()) - frac(astro.sunset.getTime())) * 60)
assert(duskGapMin === 0,
    `sundusk equals geometric sunset (${sunsetClock}) by ${duskGapMin} min`)

// ---------------------------------------------------------------------------
// B. The morning that used to break: pre-dawn vs. post-dawn ticks
// ---------------------------------------------------------------------------

console.log('\n── Pre-dawn vs. post-dawn ticks ──\n')

const presenceProto = Object.getPrototypeOf(networkPresence)
const origIsOnline = presenceProto.isOnline
presenceProto.isOnline = async (name) => name === 'hostname1'

try {
    // 06:06 -- 5 minutes before civil dawn, the street sensor already reads daytime.
    // Nothing may move: the open rule is gated behind dawn, the park rule needs 200 lux,
    // the dark-close rule needs 15 lux. This is the tick that used to kill the lamps.
    let r = await runAt(6, 6, { illuminance: 20 })
    assertCalls(r.devices, 'Salon_Roleta_Okno_Lewe', [], 'pre-dawn 06:06 at 20 lux -> left roller untouched')
    assertCalls(r.devices, 'Salon_Roleta_Okno_Prawe', [], 'pre-dawn 06:06 at 20 lux -> right roller untouched')

    // Deep pre-dawn darkness still closes the windows -- the guard gates the OPEN path only.
    r = await runAt(6, 6, { illuminance: 10 })
    assertCalls(r.devices, 'Salon_Roleta_Okno_Lewe', ['CLOSE'], 'pre-dawn 06:06 at 10 lux -> dark-close rule fires')

    // 06:20 -- the first tick past civil dawn. The open rule is finally allowed.
    r = await runAt(6, 20, { illuminance: 20 })
    assertCalls(r.devices, 'Salon_Roleta_Okno_Lewe', ['OPEN'], 'first post-dawn tick at 20 lux -> left roller OPEN')
    assertCalls(r.devices, 'Salon_Roleta_Okno_Prawe', ['OPEN'], 'first post-dawn tick at 20 lux -> right roller OPEN')

    // 07:00 at 250 lux with the office occupied -- the park rule engages and its partial
    // positions out-vote every OPEN in the same tick (most-closed-wins).
    r = await runAt(7, 0, { illuminance: 250 })
    assertCalls(r.devices, 'Salon_Roleta_Okno_Lewe', [{ position: 40 }], 'occupied 07:00 at 250 lux -> park CLOSE wins over OPEN')
    assertCalls(r.devices, 'Salon_Roleta_Okno_Prawe', [{ position: 12 }], 'occupied 07:00 at 250 lux -> right roller parks at 12')

    // The merge log names every contributing rule, so the out-vote is traceable.
    const mergeLine = r.logs.find((l) => l.level === 'debug' && l.message.includes('merged 2 contribution(s)'))
    assert(mergeLine !== undefined, 'merge emits a per-target debug line listing contributions')
    assert(mergeLine?.message.includes('Day: Warm, not too bright - open=OPEN') === true,
        'merge line names the open rule')
    assert(mergeLine?.message.includes('Day: Kyeno present, not too bright=40') === true,
        'merge line names the park rule and its position')

    // 07:00 at 150 lux -- below the park floor, so OPEN wins unopposed.
    r = await runAt(7, 0, { illuminance: 150 })
    assertCalls(r.devices, 'Salon_Roleta_Okno_Lewe', ['OPEN'], 'occupied 07:00 at 150 lux -> below park floor, OPEN wins')
    assertCalls(r.devices, 'Salon_Roleta_Okno_Prawe', ['OPEN'], 'occupied 07:00 at 150 lux -> right roller OPEN too')
} finally {
    presenceProto.isOnline = origIsOnline
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : '') + `\n${'═'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)

