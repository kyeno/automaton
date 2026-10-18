/**
 * Composite condition group tests (any_of / all_of).
 *
 * Verifies the recursive any_of/all_of condition gates against both execution paths:
 *   runtime -- conditionsMatch() driven with an explicit context:
 *     - any_of passes when at least one sub-group matches; several matching branches are fine
 *       (inclusive OR, not exclusive choice).
 *     - all_of passes only when every sub-group matches.
 *     - empty-list semantics: any_of: [] fails closed, all_of: [] passes vacuously.
 *     - malformed shapes (non-array gate values, non-object sub-groups) fail closed.
 *     - composites nest inside composites into arbitrary boolean trees.
 *     - top-level scalar entries still AND together with composite groups.
 *     - dynamic sensor keys keep working and composite lists are never treated as bounds.
 *   static analyzer -- ruleCoverage.evaluateRule()/collectSensorKeys()/buildScenarios():
 *     - identical fail-closed semantics for presence-based OR/AND branches (runtime parity),
 *     - nested sensor bounds + grouped presence hosts feed the scenario grid dimensions.
 *   monitored subjects -- trigger_on_change_only gate with a real temp DatabaseService:
 *     - a presence host referenced ONLY inside an any_of branch wakes timer ticks after its
 *       transition (the recursion in #collectMonitoredSubjects()).
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
import DatabaseService from '../src/service/databaseService.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import { evaluateRule, collectSensorKeys, buildScenarios } from '../src/lib/ruleCoverage.js'

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

// Minimal temp config so the base class constructs cleanly (conditions are injected per call below).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-composite-'))
const cfgPath = path.join(dir, 'probe.yaml')
fs.writeFileSync(cfgPath, ['rules:', '  - name: probe', '    conditions: {}'].join('\n'), 'utf8')

class GateAuto extends RuleBasedAutomationBase {
    loadDevices() { return new Map() }
    resolveCommand() { return null }
}
const auto = new GateAuto({ name: 'GateProbe', configPath: cfgPath })

/** Evaluate `conditions` with an explicit context (no clock-dependent gates in these tests). */
async function match(conditions, ctx) {
    return await auto.conditionsMatch(conditions, ctx)
}

console.log('')
console.log('-- any_of: passes when at least one sub-group matches --')
console.log('')
{
    const evening = { timeOfDay: 'evening', illuminance: 80 }
    assert(await match({ any_of: [{ 'time_of_day': ['night'] }, { illuminance: { lt: 50 } }] }, evening) === false,
        'neither branch holds -> rejected')
    assert(await match({ any_of: [{ 'time_of_day': ['night'] }, { illuminance: { lt: 100 } }] }, evening) === true,
        'second branch holds -> accepted')
    assert(await match({ any_of: [{ 'time_of_day': ['evening'] }, { illuminance: { lt: 100 } }] }, evening) === true,
        'BOTH branches hold -> still accepted (inclusive OR, not exclusive choice)')
}

console.log('')
console.log('-- all_of: passes only when every sub-group matches --')
console.log('')
{
    const evening = { timeOfDay: 'evening', illuminance: 80 }
    assert(await match({ all_of: [{ 'time_of_day': ['evening'] }, { illuminance: { lt: 100 } }] }, evening) === true,
        'every group holds -> accepted')
    assert(await match({ all_of: [{ 'time_of_day': ['evening'] }, { illuminance: { lt: 50 } }] }, evening) === false,
        'one group fails -> rejected')
}

console.log('')
console.log('-- empty-list semantics --')
console.log('')
assert(await match({ any_of: [] }, {}) === false, 'any_of: [] fails closed (nothing can satisfy "any of" nothing)')
assert(await match({ all_of: [] }, {}) === true, 'all_of: [] passes vacuously (mirrors "no conditions = always matches")')

console.log('')
console.log('-- malformed shapes fail closed --')
console.log('')
assert(await match({ any_of: 'hostname1' }, {}) === false, 'non-array any_of value fails closed')
assert(await match({ all_of: {} }, {}) === false, 'non-array all_of value fails closed')
for (const bad of ['nope', null, 42, [{}], undefined]) {
    assert(await match({ any_of: [bad] }, {}) === false, `sub-group ${JSON.stringify(bad)} fails closed`)
}
assert(await match([], {}) === false, 'top-level array condition set fails closed')

console.log('')
console.log('-- composites nest into arbitrary boolean trees --')
console.log('')
{
    const rule = {
        illuminance: { lt: 100 },
        any_of: [
            { all_of: [{ 'time_of_day': ['evening'] }, { temperature: { gte: 20 } }] },
            { 'time_of_day': ['night'] },
        ],
    }
    assert(await match(rule, { timeOfDay: 'evening', temperature: 25, illuminance: 50 }) === true,
        'nested all_of inside any_of branch matches -> accepted')
    assert(await match(rule, { timeOfDay: 'morning', temperature: 25, illuminance: 50 }) === false,
        'neither nested branch matches -> rejected')
    assert(await match(rule, { timeOfDay: 'night', temperature: 5, illuminance: 50 }) === true,
        'second top-level branch (plain period) still wins the OR gate')
    // three levels deep: any_of > all_of > any_of
    const deep = { any_of: [{ all_of: [{ any_of: [{ 'time_of_day': ['dawn'] }] }] }] }
    assert(await match(deep, { timeOfDay: 'dawn' }) === true, 'three-level nesting resolves correctly')
}

console.log('')
console.log('-- top-level scalars AND together with composite groups --')
console.log('')
{
    const rule = { illuminance: { lt: 90 }, any_of: [{ 'time_of_day': ['night'] }] }
    assert(await match(rule, { timeOfDay: 'evening', illuminance: 80 }) === false,
        'scalar ok but no OR branch holds -> rejected')
    assert(await match(rule, { timeOfDay: 'night', illuminance: 80 }) === true,
        'scalar + one OR branch both hold -> accepted')
    assert(await match(rule, { timeOfDay: 'night', illuminance: 120 }) === false,
        'OR branch holds but scalar fails -> rejected')
}

console.log('')
console.log('-- dynamic sensor keys unchanged; composites are not sensor bounds --')
console.log('')
assert(await match({ foo: { gte: 1 } }, { foo: 2 }) === true, 'unknown key with object bounds still works as a sensor range')
assert(await match({ any_of: [{ 'time_of_day': ['evening'] }] }, { timeOfDay: 'evening' }) === true,
    'composite-only condition set evaluates without treating the list as a bound')

console.log('')
console.log('-- static analyzer mirrors runtime semantics (evaluateRule) --')
console.log('')
{
    const orPresence = { any_of: [{ presence: 'hostname1' }, { presence: 'hostname2' }] }
    assert(evaluateRule(orPresence, { presence: { hostname1: true, hostname2: false } }) === true,
        'any_of presence: first host online -> satisfied statically')
    assert(evaluateRule(orPresence, { presence: { hostname1: false, hostname2: true } }) === true,
        'any_of presence: second host online -> satisfied statically')
    assert(evaluateRule(orPresence, { presence: { hostname1: false, hostname2: false } }) === false,
        'any_of presence: all hosts offline -> rejected statically')

    const andPresence = { all_of: [{ presence: 'hostname1' }, { presence: 'htpc' }] }
    assert(evaluateRule(andPresence, { presence: { hostname1: true, htpc: true } }) === true,
        'all_of presence: every host online -> satisfied statically')
    assert(evaluateRule(andPresence, { presence: { hostname1: true, htpc: false } }) === false,
        'all_of presence: one host offline -> rejected statically')

    // fail-closed parity with the runtime evaluator
    assert(evaluateRule({ any_of: [] }, {}) === false, 'empty any_of fails closed in the analyzer too')
    assert(evaluateRule({ all_of: [] }, {}) === true, 'empty all_of passes vacuously in the analyzer too')
    assert(evaluateRule({ any_of: 'bogus' }, {}) === false, 'non-array any_of fails closed in the analyzer too')
    assert(evaluateRule({ any_of: ['nope'] }, {}) === false, 'non-object subgroup fails closed in the analyzer too')

    // nested sensor bounds + composite keys never leak into the sensor dimension
    const rules = [
        { conditions: { hour: { gte: 16 }, illuminance: { lt: 600 }, any_of: [{ presence: 'hostname1' }, { temperature: { lte: 24 } }] } },
    ]
    assert(JSON.stringify(collectSensorKeys(rules)) === JSON.stringify(['illuminance', 'temperature']),
        'collectSensorKeys sweeps grouped sensor bounds and excludes composite keys')
}

console.log('')
console.log('-- scenario grid picks up hosts referenced inside groups --')
console.log('')
{
    const built = buildScenarios([{ conditions: { any_of: [{ presence: 'hostname1' }, { presence: 'hostname2' }] } }])
    assert(JSON.stringify(built.meta.presenceHosts) === JSON.stringify(['hostname1', 'hostname2']),
        'grouped presence hosts feed the scenario grid dimensions')
    const hit = built.scenarios.some((s) => evaluateRule(
        { any_of: [{ presence: 'hostname1' }, { presence: 'hostname2' }] }, s.context, s.sensors))
    assert(hit === true, 'grid contains a scenario where the grouped OR rule matches (hostname1 online)')
}

console.log('')
console.log('-- monitored subjects recurse into groups (react-on-change gate) --')
console.log('')
async function main() {
    // Isolated temp database + config whose ONLY subject references live inside an any_of branch.
    const dbFile = path.join(dir, 'state.db')
    const cfg2 = path.join(dir, 'probe-grouped.yaml')
    fs.writeFileSync(cfg2, [
        'trigger_on_change_only: true',
        'rules:',
        '  - name: probe',
        '    conditions:',
        '      any_of:',
        '        - presence: hostname1',
        '        - presence: hostname2',
        '        - presence: htpc',
    ].join('\n'), 'utf8')

    /** Minimal automation whose buildContext() flags whether execution got past the gate. */
    class ProbeAuto extends RuleBasedAutomationBase {
        built = false
        async buildContext() { this.built = true; return {} }
        loadDevices() { return new Map() }   // empty -> execute stops right after context build
        resolveCommand() { return null }
    }

    assert(await DatabaseService.init(dbFile), 'database available for grouped-subject tests')
    const probe = new ProbeAuto({ name: 'ProbeGrouped', configPath: cfg2 })
    await new Promise((r) => setTimeout(r, 25))   // ensure later Date.now() is strictly greater than baseline

    probe.built = false
    await probe.execute({ trigger: 'timer' })
    assert(probe.built === false, 'gate SKIPS a timer tick with no monitored change yet (grouped subjects)')

    const rec = await DatabaseService.recordTransition({ domain: 'network', subject: 'hostname1', toState: 'online' })
    assert(rec.changed === true, 'transition of an any_of-referenced host recorded as a genuine change')

    probe.built = false
    await probe.execute({ trigger: 'timer' })
    assert(probe.built === true, 'gate PROCEEDS on the next timer tick -- grouped presence change woke it')
}

main()
    .then(() => {
        console.log(`\n${passed}/${passed + failed} composite-condition checks passed`)
        process.exit(failed > 0 ? 1 : 0)
    })
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })