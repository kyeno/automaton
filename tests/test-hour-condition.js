/**
 * Actual wall-clock hour condition tests.
 *
 * Verifies the hour-gated condition type against both execution paths:
 *   runtime -- conditionsMatch() driven through execute() dispatch with a stubbed Date:
 *     - gte bound fires only at/after the given hour (dark + past 23h -> CLOSE/CLOSE)
 *     - does NOT fire before that hour even when fully dark (winter-afternoon case)
 *     - does NOT fire in early-morning hours either (only later than 23h counts)
 *     - bare number = exactly that hour; gt/lt bounds behave as expected
 *     - malformed values fail closed instead of passing silently
 *     - AND semantics with calendar-based time-of-day periods
 *   static analyzer -- ruleCoverage.evaluateRule()/analyzeRules() mirror the same
 *     semantics, treat 'hour' as reserved (never a sensor dimension) and fail
 *     closed when no clock context is present.
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
import temporal from '../src/lib/date.js'
import { evaluateRule, collectSensorKeys, analyzeRules } from '../src/lib/ruleCoverage.js'

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
        console.log('  \u2713 ' + label)
        passed++
    } else {
        console.error('  \u2717 ' + label)
        failed++
    }
}

/**
 * Stub global Date to a fixed hour of day for deterministic clock checks.
 * @param {number} hour - Hour of day (0-23)
 * @returns {Function} Restore function returning the original Date
 */
function stubDate(hour) {
    const RealDate = global.Date
    class FakeDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(2026, 8, 15, hour, 30, 0)
            else super(...args)
        }
        static now() {
            return new RealDate(2026, 8, 15, hour, 30, 0).getTime()
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
        getStateLast: () => null,
        // No human-interaction origin -- the cooldown check fails open.
        getStateOrigin: () => 'unknown',
        getStateLastAt: () => null
    }
}

/**
 * Self-contained roller automation for testing (fixed rule set injected per scenario).
 */
class TestRollers extends RuleBasedAutomationBase {
    /** @type {Map<string, Object>} */ #devices
    /** @type {Object} */ #context

    /**
     * @param {Map<string, Object>} devices - Map of target id -> stub device
     * @param {Object} context - Fabricated sensor context
     */
    constructor(devices, context) {
        super({ name: 'HourCondTest', configPath: '/dev/null' })
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
 * Run one automation at a fixed clock hour and return the resulting device map.
 * The fabricated time-of-day label is derived from the same stubbed clock, so period
 * membership stays consistent with the wall-clock scenarios under test.
 * @param {number} hour - Hour of day to simulate (0-23)
 * @param {{name?: string, conditions: object, targets: object}[]} rules - Rule set
 * @param {number} illuminance - Simulated outdoor lux reading
 * @returns {Promise<Map<string, Object>>} Devices after execute()
 */
async function runAt(hour, rules, illuminance) {
    const restore = stubDate(hour)
    try {
        const devices = new Map([
            ['Roller_Left', makeStubDevice('Roller Left')],
            ['Roller_Right', makeStubDevice('Roller Right')]
        ])
        const auto = new TestRollers(devices, { timeOfDay: temporal.getCurrentTimePeriod(), illuminance })
        auto.config = { rules }
        await auto.execute({ trigger: 'test' })
        return devices
    } finally {
        restore()
    }
}

/**
 * Assert a device received exactly the expected payload sequence.
 * @param {Map<string, Object>} devices - Device map from runAt()
 * @param {string} id - Target id
 * @param {(Object|string)[]} expectedPayloads - Expected payloads, in order
 * @param {string} label - Assertion label
 */
function assertCalls(devices, id, expectedPayloads, label) {
    const actual = devices.get(id).calls.map((c) => JSON.stringify(c.payload))
    const expected = expectedPayloads.map((p) => JSON.stringify(p))
    const match = actual.length === expected.length && actual.every((v, i) => v === expected[i])
    assert(match, label + ' (got [' + (actual.join(', ') || 'none') + '])')
}

const LATE_NIGHT_RULES = [
    {
        name: 'After 23h: dark - close all',
        conditions: { hour: { gte: 23 }, illuminance: { lte: 15 } },
        targets: { Roller_Left: 'CLOSE', Roller_Right: 'CLOSE' }
    }
]

console.log('')
console.log('-- Late-night rule: fires only past the gated hour --')
console.log('')

{
    // Past 23h and truly dark -> both rollers closed.
    let d = await runAt(23, LATE_NIGHT_RULES, 5)
    assertCalls(d, 'Roller_Left', ['CLOSE'], 'past 23h + dark -> left roller CLOSE')
    assertCalls(d, 'Roller_Right', ['CLOSE'], 'past 23h + dark -> right roller CLOSE')

    // One hour earlier with identical darkness -> inert (winter-afternoon case).
    d = await runAt(22, LATE_NIGHT_RULES, 5)
    assertCalls(d, 'Roller_Left', [], 'at 22h + dark -> no dispatch')

    // Deep winter afternoon at dusk light levels -> still inert.
    d = await runAt(16, LATE_NIGHT_RULES, 5)
    assertCalls(d, 'Roller_Left', [], 'afternoon + dark -> no dispatch')

    // Early morning darkness does not count as "later than 23h" either.
    d = await runAt(2, LATE_NIGHT_RULES, 5)
    assertCalls(d, 'Roller_Left', [], 'early-morning + dark -> no dispatch')

    // The darkness requirement stays in force: bright past-23h sky does nothing.
    d = await runAt(23, LATE_NIGHT_RULES, 500)
    assertCalls(d, 'Roller_Left', [], 'past 23h but bright -> no dispatch')
}

console.log('')
console.log('-- Bare number means exactly that hour --')
console.log('')

{
    const exactRules = [
        {
            name: 'Hour four only',
            conditions: { hour: 4, illuminance: { lte: 15 } },
            targets: { Roller_Left: 'CLOSE' }
        }
    ]
    let d = await runAt(4, exactRules, 5)
    assertCalls(d, 'Roller_Left', ['CLOSE'], 'hour: 4 at 04h -> dispatches')
    d = await runAt(3, exactRules, 5)
    assertCalls(d, 'Roller_Left', [], 'hour: 4 at 03h -> inert')
    d = await runAt(5, exactRules, 5)
    assertCalls(d, 'Roller_Left', [], 'hour: 4 at 05h -> inert')
}

console.log('')
console.log('-- gt / lt bounds --')
console.log('')

{
    const gtRules = [{ name: 'gt22', conditions: { hour: { gt: 22 } }, targets: { Roller_Left: 'OPEN' } }]
    let d = await runAt(23, gtRules, 500)
    assertCalls(d, 'Roller_Left', ['OPEN'], 'gt: 22 at 23h -> dispatches')
    d = await runAt(22, gtRules, 500)
    assertCalls(d, 'Roller_Left', [], 'gt: 22 at 22h -> inert (strict)')

    const ltRules = [{ name: 'lt5', conditions: { hour: { lt: 5 } }, targets: { Roller_Left: 'OPEN' } }]
    d = await runAt(4, ltRules, 500)
    assertCalls(d, 'Roller_Left', ['OPEN'], 'lt: 5 at 04h -> dispatches')
    d = await runAt(5, ltRules, 500)
    assertCalls(d, 'Roller_Left', [], 'lt: 5 at 05h -> inert (strict)')
}

console.log('')
console.log('-- Malformed values fail closed --')
console.log('')

{
    const badRules = [
        {
            name: 'malformed',
            conditions: { hour: 'late', illuminance: { lte: 15 } },
            targets: { Roller_Left: 'CLOSE' }
        }
    ]
    let d = await runAt(23, badRules, 5)
    assertCalls(d, 'Roller_Left', [], "hour as a string -> fails closed")
    d = await runAt(2, badRules, 5)
    assertCalls(d, 'Roller_Left', [], 'malformed value never passes regardless of clock')
}

console.log('')
console.log('-- AND semantics with calendar periods --')
console.log('')

{
    // Both the period label and the raw hour must hold.
    const bothRules = [
        {
            name: 'afternoon past 16h',
            conditions: { 'time-of-day': ['afternoon'], hour: { gt: 16 }, illuminance: { lte: 15 } },
            targets: { Roller_Left: 'CLOSE' }
        }
    ]
    let d = await runAt(17, bothRules, 5)
    assertCalls(d, 'Roller_Left', ['CLOSE'], 'period + hour both satisfied at 17h -> dispatches')
    d = await runAt(19, bothRules, 5)
    assertCalls(d, 'Roller_Left', [], 'hour ok but period is evening at 19h -> inert')
    d = await runAt(16, bothRules, 5)
    assertCalls(d, 'Roller_Left', [], 'period ok but hour not > 16 at 16h -> inert')
}

console.log('')
console.log('-- Static analyzer mirrors runtime semantics --')
console.log('')

{
    // Bounds object against an injected clock hour.
    assert(evaluateRule({ hour: { gte: 23 } }, { hour: 23 }) === true, 'evaluateRule: gte bound matches at 23')
    assert(evaluateRule({ hour: { gte: 23 } }, { hour: 22 }) === false, 'evaluateRule: gte bound rejects 22')
    // Bare number exact match.
    assert(evaluateRule({ hour: 4 }, { hour: 4 }) === true, 'evaluateRule: bare number matches exactly')
    assert(evaluateRule({ hour: 4 }, { hour: 5 }) === false, 'evaluateRule: bare number rejects other hours')
    // No clock context in the analysis -> declared bound cannot be satisfied (fail closed).
    assert(evaluateRule({ hour: { gte: 23 } }, {}) === false, 'evaluateRule: absent clock context fails closed')
    // Malformed values fail closed too.
    assert(evaluateRule({ hour: 'late' }, { hour: 23 }) === false, 'evaluateRule: malformed value fails closed')

    // 'hour' is reserved -- never collected as a sensor dimension for scenario grids.
    const keys = collectSensorKeys([{ conditions: { hour: { gte: 23 }, illuminance: { lte: 15 } } }])
    assert(JSON.stringify(keys) === JSON.stringify(['illuminance']), "collectSensorKeys excludes 'hour'")
}

{
    // Full sweep: the late-night rule covers only the 23h cell of the dark scenario.
    const scenarios = [
        { label: 'dark', context: { illuminance: 5 }, sensors: { illuminance: 5 } },
        { label: 'bright', context: { illuminance: 500 }, sensors: { illuminance: 500 } }
    ]
    const report = analyzeRules({
        rules: LATE_NIGHT_RULES,
        periodMap: temporal.getHourToPeriodMap(),
        scenarios
    })
    const at = (h) => report.hours.find((x) => x.hour === h)
    assert(at(23).coveredScenarios === 1 && at(23).gapCount === 1, 'sweep: 23h covers exactly the dark scenario')
    assert(at(22).coveredScenarios === 0, 'sweep: 22h uncovered')
    assert(at(16).coveredScenarios === 0, 'sweep: afternoon uncovered')
    assert(at(2).coveredScenarios === 0, 'sweep: early morning uncovered')
}

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
