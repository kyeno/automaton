/**
 * Night-window light-restore gate tests (home-theater paused/stopped restore rule).
 *
 * Background: the "HTPC: paused/stopped - restore ambient lighting" rule used a bare
 * `hour: { gte: sunset }` gate. A sun shorthand resolves to a fractional hour measured from
 * local midnight, so a one-sided `gte` bound is the window [dusk .. 24:00) and CANNOT wrap
 * midnight: a pause at 04:35 (sunset 18.44 > now 4.59) silently restored nothing, and the
 * log showed only "No rules matched". The rule now expresses the full night as an explicit
 * OR -- "after civil dusk" OR "before civil dawn" -- which also covers the dark morning a
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
const rulesDoc = yamlParseDocument(fs.readFileSync(path.join(ROOT, 'etc/automation/home-office-video.yaml'), 'utf8')).toJS()
const restoreRule = (rulesDoc.rules ?? []).find((r) => r.name === 'HTPC: paused/stopped - restore ambient lighting')

console.log('')
console.log('-- shipped restore rule carries the night window --')
console.log('')
assert(restoreRule !== undefined, "rule 'HTPC: paused/stopped - restore ambient lighting' present in config")
const gate = { ...(restoreRule?.conditions ?? {}) }
delete gate.video_player // live monitor state, not part of the gate under test
assert(Array.isArray(gate.any_of) && gate.any_of.length === 2, 'night window is a two-branch any_of')
assert(gate.any_of?.some((g) => g.hour?.gte === 'sunset') === true, "window branch 'after civil dusk' (gte: sunset)")
assert(gate.any_of?.some((g) => g.hour?.lt === 'sunrise') === true, "window branch 'before civil dawn' (lt: sunrise)")
assert(gate.hour === undefined, 'no one-sided hour gate left to drop the pre-dawn hours')
assert(gate.illuminance?.lt === 700, 'illuminance gate retained as the darkness authority')

//  The reported failure: 2026-10-07 04:35 local (civil dusk 18:26, civil dawn 06:04).
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
    `evening pause after civil dusk restores (${clockOf(EVENING)})`)
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
    const ambientDoc = yamlParseDocument(fs.readFileSync(path.join(ROOT, 'etc/automation/ambient-lights.yaml'), 'utf8')).toJS()
    const byName = (n) => (ambientDoc.rules ?? []).find((r) => r.name === n)
    const duskRule = byName('Settled dusk - turn on ambient lamps')
    const salonRule = byName('After sunset - someone home - full salon ambient')
    const morningRule = byName('Bright morning - turn off leftover lights')

    assert(duskRule !== undefined && salonRule !== undefined && morningRule !== undefined,
        'ambient-lights rules present in config')

    //  Settled dusk: the period list stops at 04:59 while civil dawn is 06:04 now (03:09 in
    //  June), so the dark morning needs its own arm.
    assert(duskRule.conditions.any_of?.some((g) => g.hour?.lt === 'sunrise') === true,
        "settled dusk carries a 'before civil dawn' arm")
    assert(duskRule.conditions.any_of?.some((g) => JSON.stringify(g.time_of_day) === JSON.stringify(['afternoon', 'evening', 'night'])) === true,
        'settled dusk keeps its afternoon/evening/night arm')
    assert(duskRule.conditions.time_of_day === undefined,
        'settled dusk period list lives inside the any_of, not as a top-level gate')
    assert(await match(duskRule.conditions, sunContext(DARK_MORNING, { illuminance: 1, timeOfDay: 'morning' }), DARK_MORNING) === true,
        `settled dusk fires in the dark morning (${clockOf(DARK_MORNING)})`)
    assert(await match(duskRule.conditions, sunContext(AFTER_DAWN, { illuminance: 1, timeOfDay: 'morning' }), AFTER_DAWN) === false,
        `settled dusk is inert after civil dawn (${clockOf(AFTER_DAWN)})`)
    const WINTER_AFTERNOON = local(2026, 11, 8, 16, 0)
    const WINTER_NOON = local(2026, 11, 8, 12, 0)
    assert(await match(duskRule.conditions, sunContext(WINTER_AFTERNOON, { illuminance: 1, timeOfDay: 'afternoon' }), WINTER_AFTERNOON) === true,
        `settled dusk still fires in a winter afternoon (${clockOf(WINTER_AFTERNOON)})`)
    assert(await match(duskRule.conditions, sunContext(WINTER_NOON, { illuminance: 1, timeOfDay: 'noon' }), WINTER_NOON) === false,
        `settled dusk stays inert at winter noon (${clockOf(WINTER_NOON)})`)
    assert(await match(duskRule.conditions, sunContext(EVENING, { illuminance: 900, timeOfDay: 'evening' }), EVENING) === false,
        'settled dusk keeps illuminance as the authority')

    //  Salon boost: two independent ORs (night window, who is home) combined with all_of.
    //  The presence arm is live monitor state, so only the window arm is evaluated here.
    assert(Array.isArray(salonRule.conditions.all_of) && salonRule.conditions.all_of.length === 2,
        'salon boost combines its two ORs with all_of (one any_of per condition map)')
    assert(salonRule.conditions.hour === undefined,
        'salon boost drops the one-sided sunset gate')
    assert(salonRule.conditions.all_of?.[1]?.any_of?.length === 3,
        'salon boost keeps the presence OR over 3 subjects')
    const salonWindow = salonRule.conditions.all_of?.[0] ?? {}
    assert(salonWindow.any_of?.[0]?.hour?.gte === 'sunset' && salonWindow.any_of?.[1]?.hour?.lt === 'sunrise',
        'salon window arms are dusk-forward and dawn-backward')
    assert(await match(salonWindow, sunContext(PRE_DAWN, DARK), PRE_DAWN) === true,
        `salon window fires pre-dawn (${clockOf(PRE_DAWN)})`)
    assert(await match(salonWindow, sunContext(EVENING, DARK), EVENING) === true,
        `salon window fires after civil dusk (${clockOf(EVENING)})`)
    assert(await match(salonWindow, sunContext(AFTER_DAWN, { illuminance: 1, timeOfDay: 'morning' }), AFTER_DAWN) === false,
        `salon window closes after civil dawn (${clockOf(AFTER_DAWN)})`)
    assert(await match(salonWindow, sunContext(NOON, { illuminance: 1, timeOfDay: 'noon' }), NOON) === false,
        `salon window stays closed at noon (${clockOf(NOON)})`)
    assert(['afternoon', 'evening', 'night', 'morning'].every((p) => salonRule.conditions.time_of_day?.includes(p)),
        'salon once-budget is split per window, so a pre-dawn boost never eats the evening one')

    //  The morning lights-off rule must stay inert in the dark, and fire with daylight.
    assert(await match(morningRule.conditions, sunContext(PRE_DAWN, { illuminance: 20, timeOfDay: 'night' }), PRE_DAWN) === false,
        `morning lights-off stays inert pre-dawn (${clockOf(PRE_DAWN)})`)
    assert(await match(morningRule.conditions, sunContext(AFTER_DAWN, { illuminance: 20, timeOfDay: 'morning' }), AFTER_DAWN) === true,
        `morning lights-off fires with daylight (${clockOf(AFTER_DAWN)})`)

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
        presence: { kyeno: true, meerkat: true, htpc: true, bedroom: true },
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
