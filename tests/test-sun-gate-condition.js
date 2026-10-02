/**
 * Sun/clock merged-gate condition tests (after_latest_of / after_earliest_of).
 *
 * Verifies the two "merged" gate condition types against both execution paths:
 *   runtime -- conditionsMatch() driven with a pinned clock and an explicit context:
 *     - after_latest_of fires only once BOTH candidates have passed (the later instant governs):
 *       a late dusk waits past a fixed clock bound; an early dusk lets the clock bound win.
 *     - after_earliest_of fires as soon as EITHER candidate has been reached (the earlier wins):
 *       an early dawn opens before a period start; a late dawn defers to the period start.
 *     - AND semantics combined with strict conditions (season + illuminance) mirror the
 *       "season spring, illuminance lte 15" style of rule plus a sun/clock gate.
 *     - malformed / unresolvable candidates fail closed; partially-resolvable lists drop the bad entry.
 *     - clock candidates accept bare numbers, {hour:N}, and day-period names ('morning', ...).
 *     - buildContext() exposes real numeric sundawn/sundusk instants computed from configured geo.
 *   static analyzer -- ruleCoverage.collectSensorKeys()/evaluateRule() treat the gates as reserved
 *     (never sensor dimensions) and satisfied, mirroring state_changed_ago_minutes handling.
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import solar from '../src/lib/sun.js'
import { evaluateRule, collectSensorKeys } from '../src/lib/ruleCoverage.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0

function assert(cond, label) {
    if (cond) { console.log(`  ok - ${label}`); passed += 1 }
    else { console.error(`  FAIL - ${label}`); failed += 1 }
}

// Fixed reference day for deterministic clock instants (August 15, 2026).
const REF_Y = 2026
const REF_M = 7 // August (zero-based)
const REF_D = 15

/** Epoch ms at a given local hour on the fixed reference day. */
function H(hour) { return new Date(REF_Y, REF_M, REF_D, hour, 0, 0, 0).getTime() }

/** Stub global.Date to a fixed epoch instant so conditionsMatch()'s "now" is deterministic. @returns restore fn */
function stubEpoch(ms) {
    const RealDate = global.Date
    class FakeDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(ms); else super(...args) }
        static now() { return ms }
    }
    global.Date = FakeDate
    return () => { global.Date = RealDate }
}

// Minimal temp config so the base class constructs cleanly (conditions are injected per call below).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-sun-gate-'))
const cfgPath = path.join(dir, 'probe.yaml')
fs.writeFileSync(cfgPath, ['rules:', '  - name: probe', '    conditions: {}'].join('\n'), 'utf8')

class GateAuto extends RuleBasedAutomationBase {
    loadDevices() { return new Map() }
    resolveCommand() { return null }
}
const auto = new GateAuto({ name: 'GateProbe', configPath: cfgPath })

/** Evaluate `conditions` with the clock pinned to `nowMs` and an explicit context. */
async function match(conditions, ctx, nowMs) {
    const restore = stubEpoch(nowMs)
    try { return await auto.conditionsMatch(conditions, ctx) } finally { restore() }
}

console.log('')
console.log('-- after_latest_of: fires only once BOTH candidates have passed --')
console.log('')
assert(await match({ after_latest_of: ['sundusk', { hour: 19 }] }, { sundusk: H(21) }, H(20)) === false,
    'late dusk (21h): not fired at 20h (waits for the later instant)')
assert(await match({ after_latest_of: ['sundusk', { hour: 19 }] }, { sundusk: H(18) }, H(20)) === true,
    'early dusk (18h): fired at 20h (the 19h bound is the later one and has passed)')
assert(await match({ after_latest_of: ['sundusk', { hour: 19 }] }, { sundusk: H(18) }, H(19)) === true,
    'fired exactly at the 19h threshold (>= semantics)')

console.log('')
console.log('-- after_earliest_of: fires once EITHER candidate has been reached --')
console.log('')
assert(await match({ after_earliest_of: ['sundawn', 'morning'] }, { sundawn: H(3) }, H(4)) === true,
    'early dawn (03h): fired at 04h (dawn already passed)')
assert(await match({ after_earliest_of: ['sundawn', 'morning'] }, { sundawn: H(6) }, H(4)) === false,
    'late dawn (06h): not fired at 04h (waits for morning start at 05h)')
assert(await match({ after_earliest_of: ['sundawn', 'morning'] }, { sundawn: H(6) }, H(5)) === true,
    'fired exactly when morning starts (05h threshold)')

console.log('')
console.log('-- merged gate combined with strict conditions (AND) --')
console.log('')
{
    const duskRule = { season: 'summer', illuminance: { gte: 20 }, after_latest_of: ['sundusk', { hour: 19 }] }
    assert(await match(duskRule, { sundusk: H(21), timeOfDay: 'evening', illuminance: 50 }, H(22)) === true,
        'season + illuminance satisfied past the later instant -> fires')
    assert(await match(duskRule, { sundusk: H(21), timeOfDay: 'evening', illuminance: 50 }, H(20)) === false,
        'season + illuminance ok but before the later instant -> inert')
    assert(await match(duskRule, { sundusk: H(21), timeOfDay: 'evening', illuminance: 5 }, H(22)) === false,
        'gate passed but illuminance below bound -> inert')
}

console.log('')
console.log('-- malformed / unresolvable candidates fail closed --')
console.log('')
assert(await match({ after_latest_of: [] }, {}, H(20)) === false, 'empty candidate list fails closed')
assert(await match({ after_earliest_of: ['bogus'] }, {}, H(20)) === false,
    'unknown shorthand with nothing else resolvable -> fails closed')
assert(await match({ after_earliest_of: ['sundawn', 'bogus'] }, { sundawn: H(3) }, H(4)) === true,
    'unresolvable candidate dropped; remaining dawn still governs')
assert(await match({ after_latest_of: 'sundusk' }, { sundusk: H(18) }, H(20)) === false,
    'non-list value fails closed')

console.log('')
console.log('-- clock candidates accept number / {hour:N} / day-period forms --')
console.log('')
assert(await match({ after_latest_of: [19] }, {}, H(20)) === true, 'bare-number hour resolves (past 19h at 20h)')
assert(await match({ after_earliest_of: [{ 'time_of_day': 'evening' }] }, {}, H(17)) === false,
    "{'time_of_day':'evening'} = 18h; not passed at 17h")
assert(await match({ after_earliest_of: [{ 'time_of_day': 'evening' }] }, {}, H(18)) === true,
    "{'time_of_day':'evening'} = 18h; passed exactly at 18h")

console.log('')
console.log('-- context carries real sun instants from configured geo --')
console.log('')
{
    const restore = stubEpoch(H(12))
    let builtCtx = null
    try { builtCtx = await auto.buildContext() } finally { restore() }
    assert(typeof builtCtx?.sundawn === 'number' && typeof builtCtx?.sundusk === 'number',
        'buildContext exposes numeric sundawn/sundusk for the configured location')
    const expected = solar.getSunTimes(new Date(REF_Y, REF_M, REF_D, 12))
    assert(builtCtx.sundawn === expected.sundawn.getTime() && builtCtx.sundusk === expected.sundusk.getTime(),
        'context sun instants match the sunrise-sunset-js computation for that day')
}

console.log('')
console.log('-- static analyzer treats gates as reserved / satisfied --')
console.log('')
{
    const keys = collectSensorKeys([{ conditions: { after_latest_of: ['sundusk', { hour: 19 }], illuminance: { lte: 15 } } }])
    assert(JSON.stringify(keys) === JSON.stringify(['illuminance']), 'collectSensorKeys excludes the merged-gate keys')
    assert(evaluateRule({ after_latest_of: ['sundusk', { hour: 19 }] }, {}) === true,
        'evaluateRule treats a lone gate as satisfied (static analysis)')
    assert(evaluateRule({ after_earliest_of: ['sundawn', 'morning'], hour: { gte: 23 } }, { hour: 23 }) === true,
        'gate + matching hour -> satisfied statically')
    assert(evaluateRule({ after_earliest_of: ['sundawn', 'morning'], hour: { gte: 23 } }, { hour: 20 }) === false,
        'gate satisfied but hour mismatch -> rejected statically')
}

console.log('')
console.log('-- hour condition accepts sunrise/sunset shorthands (sub-hour precision) --')
console.log('')
{
    const HM = (h, m) => new Date(REF_Y, REF_M, REF_D, h, m, 0, 0).getTime()
    const dawnMs = HM(4, 31)   // sunrise at 04:31 -> fractional hour ~4.517
    const duskMs = HM(20, 18)  // sunset at 20:18 -> fractional hour ~20.3

    assert(await match({ hour: { gte: 'sunrise' } }, { sundawn: dawnMs }, H(5)) === true,
        'gte sunrise: fired after real sunrise (05:00 >= 04:31)')
    assert(await match({ hour: { gte: 'sundawn' } }, { sundawn: dawnMs }, HM(4, 31)) === true,
        'gte sundawn: fired exactly AT the sunrise instant (>= semantics)')
    assert(await match({ hour: { gte: 'sunrise' } }, { sundawn: dawnMs }, HM(4, 30)) === false,
        'gte sunrise: NOT fired one minute before sunrise (sub-hour precision)')
    assert(await match({ hour: { lte: 'sunset' } }, { sundusk: duskMs }, HM(20, 10)) === true,
        'lte sunset: fired before real sunset (20:10 <= 20:18)')
    assert(await match({ hour: { lte: 'sundusk' } }, { sundusk: duskMs }, HM(20, 30)) === false,
        'lte sundusk: NOT fired after sunset (20:30 > 20:18)')

    // plain numeric bounds keep legacy integer-hour semantics (regression guard)
    assert(await match({ hour: { lte: 4 } }, {}, H(4)) === true,
        'plain { lte: 4 } still covers all of hour 4 (integer semantics preserved)')
    assert(await match({ hour: { gte: 5 } }, {}, H(4)) === false,
        'plain { gte: 5 } not satisfied during hour 4 (integer semantics preserved)')

    // unresolvable shorthand fails closed
    assert(await match({ hour: { gte: 'sunrise' } }, {}, H(5)) === false,
        'gte sunrise with no sun instant in context -> fails closed')
}

console.log('')
console.log('-- static analyzer treats sun-shorthand hour bounds as satisfied --')
console.log('')
{
    assert(evaluateRule({ hour: { gte: 'sunrise' } }, {}) === true,
        'evaluateRule treats a lone sun-shorthand hour bound as satisfied (static analysis)')
    assert(evaluateRule({ hour: { gte: 'sunset', lt: 20 } }, { hour: 19 }) === true,
        'mixed sun + numeric hour bound treated as satisfied statically')
    assert(evaluateRule({ hour: { gte: 6 } }, { hour: 5 }) === false,
        'plain numeric hour bound still evaluated statically (no regression)')
}

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)