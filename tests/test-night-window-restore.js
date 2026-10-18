/**
 * Night-window light-restore gate tests (home-theater paused/stopped restore rule).
 *
 * Background: the "HTPC: paused/stopped - restore ambient lighting" rule used a bare
 * `hour: { gte: sunset }` gate. A sun shorthand resolves to a fractional hour measured from
 * local midnight, so a one-sided `gte` bound is the window [dusk .. 24:00) and CANNOT wrap
 * midnight: a pause at 04:35 (sunset 18.44 > now 4.59) silently restored nothing, and the
 * log showed only "No rules matched". The rule now expresses the full night as an explicit
 * OR -- "after sunset" OR "before civil dawn" -- which also covers the dark morning a
 * night owl watches into.
 *
 * Verifies against the rule as shipped in etc/automation/home-office-video.yaml, using the
 * real sun instants computed from the configured geo:
 *   - the pre-dawn pause (the reported failure) and the dark-morning pause restore;
 *   - the window closes at civil dawn and stays closed across the day;
 *   - illuminance remains the authority, so a bright pause never lights the room;
 *   - explainRuleMiss() names the rejecting gate with the resolved hours;
 *   - ruleCoverage parity: the sun window is reserved, never a sensor dimension;
 *   - the ambient-lights rules (settled dusk, salon ambient boost) carry the same window.
 *
 * Redis/MQTT are not required -- the rule's `video_player` key is dropped from the probe
 * conditions because it is live monitor state, not part of the gate under test.
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

import { parseDocument as yamlParseDocument } from 'yaml'

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

/** Stub global.Date to a fixed epoch instant so the matcher's "now" is deterministic.
 * @param {number} ms - Epoch ms to pin the clock to
 * @returns {Function} Restore function */
function stubEpoch(ms) {
    const RealDate = global.Date
    class FakeDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(ms); else super(...args) }
        static now() { return ms }
    }
    global.Date = FakeDate
    return () => { global.Date = RealDate }
}

// Minimal temp config so the base class constructs cleanly (conditions are injected per call).
const ROOT = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-night-window-'))
const probePath = path.join(dir, 'probe.yaml')
fs.writeFileSync(probePath, ['rules:', '  - name: probe', '    conditions: {}'].join('\n'), 'utf8')

class WindowAuto extends RuleBasedAutomationBase {
    loadDevices() { return new Map() }
    resolveCommand() { return null }
}
const auto = new WindowAuto({ name: 'NightWindowProbe', configPath: probePath })

/** Evaluate `conditions` with the clock pinned to `nowMs` and an explicit context. */
async function match(conditions, ctx, nowMs) {
    const restore = stubEpoch(nowMs)
    try { return await auto.conditionsMatch(conditions, ctx) } finally { restore() }
}

/** Ask the matcher WHY it rejected `conditions`, with the clock pinned to `nowMs`. */
async function why(conditions, ctx, nowMs) {
    const restore = stubEpoch(nowMs)
    try { return await auto.explainRuleMiss(conditions, ctx) } finally { restore() }
}

/** Real dawn/dusk instants (epoch ms) for the pinned day, from the configured geo. */
function sunContext(nowMs, extra = {}) {
    const times = solar.getSunTimes(new Date(nowMs))
    return {
        sundawn: times.sundawn ? times.sundawn.getTime() : null,
        sundusk: times.sundusk ? times.sundusk.getTime() : null,
        ...extra
    }
}

/** Local-clock instant on a given day (timezone from the environment). */
function local(y, m, d, h, min = 0) { return new Date(y, m, d, h, min, 0, 0).getTime() }

const clockOf = (ms) => new Date(ms).toLocaleTimeString('en-GB')

//  The rule exactly as shipped.
const rulesDoc = yamlParseDocument(fs.readFileSync(path.join(ROOT, 'etc/automation/home-office-video.yaml.dist'), 'utf8')).toJS()
const restoreRule = (rulesDoc.rules ?? []).find((r) => /paused\/stopped - restore ambient lighting$/.test(r.name))

console.log('')
console.log('-- shipped restore rule carries the night window --')
console.log('')
assert(restoreRule !== undefined, "rule 'HTPC: paused/stopped - restore ambient lighting' present in config")
const gate = { ...(restoreRule?.conditions ?? {}) }
delete gate.video_player // live monitor state, not part of the gate under test
assert(Array.isArray(gate.any_of) && gate.any_of.length === 2, 'night window is a two-branch any_of')
assert(gate.any_of?.some((g) => g.hour?.gte === 'sunset') === true, "window branch 'after sunset' (gte: sunset)")
assert(gate.any_of?.some((g) => g.hour?.lt === 'sunrise') === true, "window branch 'before civil dawn' (lt: sunrise)")
assert(gate.hour === undefined, 'no one-sided hour gate left to drop the pre-dawn hours')
assert(gate.illuminance?.lt === 900, 'illuminance gate retained as the darkness authority')

//  The reported failure: 2026-10-07 04:35 local (sunset 18:26, civil dawn 06:04).
const PRE_DAWN = local(2026, 9, 7, 4, 35)
const DARK_MORNING = local(2026, 9, 7, 5, 30)
const AFTER_DAWN = local(2026, 9, 7, 7, 0)
const NOON = local(2026, 9, 7, 12, 0)
const EVENING = local(2026, 9, 7, 19, 0)
const LATE_NIGHT = local(2026, 9, 7, 23, 30)
const DARK = { illuminance: 1, timeOfDay: 'night' }
console.log('')
console.log(`-- the reported failure: pause at ${clockOf(PRE_DAWN)} --`)
console.log('')
{
    const oldGate = { hour: { gte: 'sunset' }, illuminance: { lt: 700 } }
    assert(await match(oldGate, sunContext(PRE_DAWN, DARK), PRE_DAWN) === false,
        `old 'gte: sunset' gate rejects the pre-dawn pause (the bug) at ${clockOf(PRE_DAWN)}`)
    assert(await match(gate, sunContext(PRE_DAWN, DARK), PRE_DAWN) === true,
        `night window restores the lamps at ${clockOf(PRE_DAWN)}`)
}

console.log('')
console.log('-- the window spans dusk -> dawn and closes in daylight --')
console.log('')
assert(await match(gate, sunContext(EVENING, { ...DARK, timeOfDay: 'evening' }), EVENING) === true,
    `evening pause after sunset restores (${clockOf(EVENING)})`)
assert(await match(gate, sunContext(LATE_NIGHT, { ...DARK, timeOfDay: 'night' }), LATE_NIGHT) === true,
    `late-night pause restores (${clockOf(LATE_NIGHT)})`)
assert(await match(gate, sunContext(DARK_MORNING, { ...DARK, timeOfDay: 'morning' }), DARK_MORNING) === true,
    `dark-morning pause before civil dawn restores (${clockOf(DARK_MORNING)})`)
assert(await match(gate, sunContext(AFTER_DAWN, { illuminance: 1, timeOfDay: 'morning' }), AFTER_DAWN) === false,
    `after civil dawn the window is closed (${clockOf(AFTER_DAWN)})`)
assert(await match(gate, sunContext(NOON, { illuminance: 300, timeOfDay: 'noon' }), NOON) === false,
    `daytime pause stays inert even below the lux bound (${clockOf(NOON)})`)
assert(await match(gate, sunContext(PRE_DAWN, { illuminance: 900, timeOfDay: 'night' }), PRE_DAWN) === false,
    'inside the window but bright outside -> illuminance gate keeps the room unlit')

//  Summer: civil dawn ~03:09, so the window closes long before the 04:35 case.
{
    const JUNE_PRE_DAWN = local(2026, 5, 22, 3, 0)
    const JUNE_AFTER_DAWN = local(2026, 5, 22, 3, 30)
    assert(await match(gate, sunContext(JUNE_PRE_DAWN, DARK), JUNE_PRE_DAWN) === true,
        `summer: pre-dawn pause restores (${clockOf(JUNE_PRE_DAWN)})`)
    assert(await match(gate, sunContext(JUNE_AFTER_DAWN, { ...DARK, timeOfDay: 'morning' }), JUNE_AFTER_DAWN) === false,
        `summer: after the early civil dawn the window is closed (${clockOf(JUNE_AFTER_DAWN)})`)
}

console.log('')
console.log('-- explainRuleMiss() names the rejecting gate --')
console.log('')
{
    const oldGate = { hour: { gte: 'sunset' }, illuminance: { lt: 700 } }
    const oldReason = await why(oldGate, sunContext(PRE_DAWN, DARK), PRE_DAWN)
    assert(/fails gte sunset/.test(oldReason), `old gate explained: "${oldReason}"`)
    assert(/hour 4\.\d\d/.test(oldReason), `explanation prints the resolved clock hour: "${oldReason}"`)

    const dayReason = await why(gate, sunContext(NOON, { illuminance: 300, timeOfDay: 'noon' }), NOON)
    assert(/any_of/.test(dayReason), `daytime pause explained by the window: "${dayReason}"`)

    const luxReason = await why(gate, sunContext(PRE_DAWN, { illuminance: 900, timeOfDay: 'night' }), PRE_DAWN)
    assert(/illuminance/.test(luxReason), `bright pause explained by the lux gate: "${luxReason}"`)

    const okReason = await why(gate, sunContext(PRE_DAWN, DARK), PRE_DAWN)
    assert(typeof okReason === 'string' && okReason.length > 0, `matched rule degrades gracefully: "${okReason}"`)
}

console.log('')
console.log('-- static coverage parity (ruleCoverage) --')
console.log('')
{
    const keys = collectSensorKeys([{ conditions: gate }])
    assert(JSON.stringify(keys) === JSON.stringify(['illuminance']),
        `collectSensorKeys() sees only the lux dimension, never the sun window (${JSON.stringify(keys)})`)
    assert(evaluateRule(gate, {}, { illuminance: 1 }) === true,
        'evaluateRule() treats the sun window as satisfied (static analysis)')
    assert(evaluateRule(gate, {}, { illuminance: 900 }) === false,
        'evaluateRule() still enforces the lux dimension statically')
}

console.log('')
console.log('-- ambient-lights rules carry the same night window --')
console.log('')
{
    const ambientDoc = yamlParseDocument(fs.readFileSync(path.join(ROOT, 'etc/automation/ambient-lights.yaml.dist'), 'utf8')).toJS()
    const byName = (n) => (ambientDoc.rules ?? []).find((r) => r.name === n)
    const duskRule = byName('Settled dusk - turn on ambient lamps')
    const preDawnRule = byName('Pre-dawn restore - turn on ambient lamps')
    const morningRule = byName('Bright morning - turn off leftover lights')

    assert(duskRule !== undefined && preDawnRule !== undefined && morningRule !== undefined,
        'ambient-lights rules present in config')

    //  Settled dusk: both dusk windows at the top level -- each keeps its own `once:` slot (the
    //  budget splitter reads `time_of_day` gates at any depth) -- floored on a single sun gate,
    //  `predusk`, sunset minus 30 minutes. In winter dusk lands inside `afternoon`, and the
    //  fixed `evening` band starts at 18:00 while summer dusk is 21:00, so the floor has to cover
    //  BOTH: a gloomy mid-afternoon BEFORE dusk must stay dark -- the periods are fixed clock
    //  bands with no sun awareness of their own.
    assert(JSON.stringify(duskRule.conditions.time_of_day) === JSON.stringify(['afternoon', 'evening']),
        'settled dusk lists both dusk windows at the top level (one once slot each)')
    assert(duskRule.conditions.hour?.gte === 'predusk',
        'settled dusk floors every window on `predusk` (sunset minus 30 minutes)')
    assert(duskRule.conditions.any_of === undefined,
        'no per-arm any_of left behind -- the single sun floor covers every window')
    assert(duskRule.conditions.illuminance?.lt === 900,
        'settled dusk keeps illuminance as the darkness authority')
    assert(await match(duskRule.conditions, sunContext(EVENING, { illuminance: 1, timeOfDay: 'evening' }), EVENING) === true,
        `settled dusk fires after sunset (${clockOf(EVENING)})`)
    assert(await match(duskRule.conditions, sunContext(DARK_MORNING, { illuminance: 1, timeOfDay: 'morning' }), DARK_MORNING) === false,
        `settled dusk is inert in the dark morning (${clockOf(DARK_MORNING)})`)
    assert(await match(duskRule.conditions, sunContext(AFTER_DAWN, { illuminance: 1, timeOfDay: 'morning' }), AFTER_DAWN) === false,
        `settled dusk is inert after civil dawn (${clockOf(AFTER_DAWN)})`)
    //  The reported incident (2026-10-10): a slightly overcast afternoon read 686 lx at 14:53,
    //  more than three hours before that day's 18:33 sunset -- with no sun gate the lamps lit.
    const GLOOMY_AFTERNOON = local(2026, 9, 10, 14, 53)
    assert(await match(duskRule.conditions, sunContext(GLOOMY_AFTERNOON, { illuminance: 686, timeOfDay: 'afternoon' }), GLOOMY_AFTERNOON) === false,
        `gloomy pre-dusk afternoon stays dark (${clockOf(GLOOMY_AFTERNOON)}) -- the reported bug`)
    const WINTER_AFTERNOON = local(2026, 11, 8, 17, 0)   // past that day's sunset
    const DEC8_DUSK = sunContext(WINTER_AFTERNOON).sundusk
    //  The floor is `predusk` = sunset minus 30 minutes, so "before the floor" is expressed as
    //  an offset from that day's computed dusk -- a fixed wall time would silently land on the
    //  wrong side of it at another latitude (15:30 here is dusk minus 22 minutes: already lit).
    const WINTER_PRE_DUSK = DEC8_DUSK - 45 * 60_000
    const WINTER_NOON = local(2026, 11, 8, 12, 0)
    assert(await match(duskRule.conditions, sunContext(WINTER_AFTERNOON, { illuminance: 1, timeOfDay: 'afternoon' }), WINTER_AFTERNOON) === true,
        `settled dusk fires in a winter afternoon once dusk has settled (${clockOf(WINTER_AFTERNOON)})`)
    assert(await match(duskRule.conditions, sunContext(WINTER_PRE_DUSK, { illuminance: 1, timeOfDay: 'afternoon' }), WINTER_PRE_DUSK) === false,
        `winter afternoon BEFORE the predusk floor stays dark (${clockOf(WINTER_PRE_DUSK)})`)
    //  The floor itself: the rule opens half an hour before dusk -- 45 minutes before it stays
    //  dark, 15 minutes before it lights the lamps.
    assert(await match(duskRule.conditions, sunContext(WINTER_AFTERNOON, { illuminance: 1, timeOfDay: 'afternoon' }), DEC8_DUSK - 15 * 60_000) === true,
        `predusk floor opens the rule 15 minutes before sunset (${clockOf(DEC8_DUSK - 15 * 60_000)})`)
    assert(await match(duskRule.conditions, sunContext(WINTER_NOON, { illuminance: 1, timeOfDay: 'noon' }), WINTER_NOON) === false,
        `settled dusk stays inert at winter noon (${clockOf(WINTER_NOON)})`)
    assert(await match(duskRule.conditions, sunContext(EVENING, { illuminance: 900, timeOfDay: 'evening' }), EVENING) === false,
        'settled dusk keeps illuminance as the authority')

    //  Pre-dawn restore: the arm the dusk rule used to carry, now invoke-only. It answers the
    //  home-theater player-gone hand-off (a forced run) and stays out of natural ticks, so a
    //  00:26 presence blip in the middle of a session never blasts the lamps.
    assert(preDawnRule.forced_only === true,
        'pre-dawn restore is invoke-only -- natural ticks never fire it')
    assert(preDawnRule.once === undefined,
        'pre-dawn restore declares no once: budget (forced runs never check or write markers)')
    assert(preDawnRule.conditions.hour?.lt === 'sunrise',
        "pre-dawn restore gates on 'before civil dawn' (lt: sunrise)")
    assert(JSON.stringify(preDawnRule.conditions.time_of_day) === JSON.stringify(['night', 'morning']),
        'pre-dawn restore covers night and the dark morning')
    assert(preDawnRule.conditions.illuminance?.lt === 900,
        'pre-dawn restore keeps illuminance as the darkness authority')
    assert(await match(preDawnRule.conditions, sunContext(PRE_DAWN, DARK), PRE_DAWN) === true,
        `pre-dawn restore fires pre-dawn (${clockOf(PRE_DAWN)})`)
    assert(await match(preDawnRule.conditions, sunContext(DARK_MORNING, { illuminance: 1, timeOfDay: 'morning' }), DARK_MORNING) === true,
        `pre-dawn restore fires in the dark morning (${clockOf(DARK_MORNING)})`)
    assert(await match(preDawnRule.conditions, sunContext(AFTER_DAWN, { illuminance: 1, timeOfDay: 'morning' }), AFTER_DAWN) === false,
        `pre-dawn restore closes after civil dawn (${clockOf(AFTER_DAWN)})`)
    assert(await match(preDawnRule.conditions, sunContext(NOON, { illuminance: 1, timeOfDay: 'noon' }), NOON) === false,
        `pre-dawn restore stays inert at noon (${clockOf(NOON)})`)
    assert(await match(preDawnRule.conditions, sunContext(PRE_DAWN, { illuminance: 900, timeOfDay: 'night' }), PRE_DAWN) === false,
        'pre-dawn restore keeps illuminance as the authority')
    const JUNE_PRE_DAWN = local(2026, 5, 22, 3, 0)
    assert(await match(preDawnRule.conditions, sunContext(JUNE_PRE_DAWN, DARK), JUNE_PRE_DAWN) === true,
        `summer: pre-dawn restore fires (${clockOf(JUNE_PRE_DAWN)})`)

    //  The morning lights-off rule must stay inert in the dark, and fire with daylight.
    assert(await match(morningRule.conditions, sunContext(PRE_DAWN, { illuminance: 20, timeOfDay: 'night' }), PRE_DAWN) === false,
        `morning lights-off stays inert pre-dawn (${clockOf(PRE_DAWN)})`)
    assert(await match(morningRule.conditions, sunContext(AFTER_DAWN, { illuminance: 20, timeOfDay: 'morning' }), AFTER_DAWN) === true,
        `morning lights-off fires with daylight (${clockOf(AFTER_DAWN)})`)

    //  `once:` budget scoping: the engine suffixes a marker with the active window only when the
    //  rule declares a `time_of_day` gate -- at the top level OR nested in any_of/all_of. A rule
    //  whose gate was nested inside an any_of used to get one all-day slot, so a 00:26 pre-dawn
    //  firing silently ate the 18:33 dusk firing. Every `once:` rule here must declare a gate.
    const declaresTimeWindow = (conds) => {
        if (!conds || typeof conds !== 'object' || Array.isArray(conds)) return false
        if (conds['time_of_day'] !== undefined) return true
        return [conds.any_of, conds.all_of].some((list) =>
            Array.isArray(list) && list.some((sub) => declaresTimeWindow(sub)))
    }
    const unscoped = ambientDoc.rules
        .filter((rule) => rule.once === true && !declaresTimeWindow(rule.conditions))
        .map((rule) => rule.name)
    assert(unscoped.length === 0,
        `every once: rule declares a time_of_day gate, so no marker is all-day-scoped (${JSON.stringify(unscoped)})`)

    //  Static parity over the whole ambient config: presence/hour/time_of_day must resolve
    //  against the analyzer's reserved keys (never as sensor dimensions), and every rule must
    //  be reachable under some period / lux / presence combination.
    const ambientKeys = new Set()
    for (const rule of ambientDoc.rules) for (const key of collectSensorKeys([rule])) ambientKeys.add(key)
    assert([...ambientKeys].sort().join(',') === 'illuminance',
        `presence/hour/time_of_day resolve statically, leaving only illuminance (${[...ambientKeys].sort().join(',')})`)
    const periods = ['night', 'morning', 'noon', 'afternoon', 'evening']
    const sweepCtx = (p) => ({
        timeOfDay: p,
        presence: { hostname1: true, hostname2: true, htpc: true, bedroom: true },
        videoPlayer: { htpc: 'paused', bedroom: 'playing' },
    })
    const unreachable = ambientDoc.rules
        .filter((rule) => !periods.some((p) => [1, 20000].some((lux) => evaluateRule(rule.conditions, sweepCtx(p), { illuminance: lux }))))
        .map((rule) => rule.name)
    assert(unreachable.length === 0, 'every ambient rule is statically reachable', JSON.stringify(unreachable))
}

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
