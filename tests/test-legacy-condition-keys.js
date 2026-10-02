/**
 * Legacy condition-key unification tests (kebab-case -> snake_case).
 *
 * Verifies the activation-time guard added when `time-of-day`, `video-player`
 * and `state-changed-ago-minutes` were renamed to their snake_case forms:
 *   findLegacyConditionKeys() -- pure recursive scanner:
 *     - flags each legacy key with its dot path and replacement name,
 *     - recurses through nested any_of / all_of composite groups,
 *     - reports every occurrence (same key in several branches = several hits),
 *     - stays silent on clean snake_case trees and non-object inputs.
 *   constructor warning -- real GateAuto instantiation from temp YAML files:
 *     - one loud LoggerService.warn per offending rule naming key + location + rename,
 *     - no warnings at all for fully migrated configs,
 *     - warn-only: construction succeeds even with stale keys present.
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
import RuleBasedAutomationBase, { findLegacyConditionKeys } from '../src/automation/base/ruleBasedAutomationBase.js'
import Transport from 'winston-transport'

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-legacy-keys-'))

class GateAuto extends RuleBasedAutomationBase {
    loadDevices() { return new Map() }
    resolveCommand() { return null }
}

/** Warn-level entries captured by {@link CaptureWarnTransport}, in emission order. */
const capturedLogs = []

/** Minimal Winston transport recording warn-level entries for assertions (mirrors UiLogTransport). */
class CaptureWarnTransport extends Transport {
    constructor() {
        super({ name: 'legacy-key-test-capture' })
    }

    log(info, callback) {
        if (info.level === 'warn') capturedLogs.push(info)
        callback()
    }
}

LoggerService.addTransport(new CaptureWarnTransport())

/** Construct a GateAuto from `yamlText`, returning the instance plus warn entries emitted during construction. */
function constructCapturing(yamlText, fileLabel) {
    const cfgPath = path.join(dir, `${fileLabel}.yaml`)
    fs.writeFileSync(cfgPath, yamlText, 'utf8')
    const start = capturedLogs.length
    const auto = new GateAuto({ name: `LegacyProbe-${fileLabel}`, configPath: cfgPath })
    return { auto, warnings: capturedLogs.slice(start) }
}

console.log('')
console.log('-- findLegacyConditionKeys(): flat conditions --')
console.log('')
{
    const hits = findLegacyConditionKeys({ 'time-of-day': ['morning'] })
    assert(hits.length === 1 && hits[0].key === 'time-of-day' && hits[0].renameTo === 'time_of_day' && hits[0].where === 'time-of-day',
        'flat time-of-day flagged with replacement and top-level path')
    const allThree = findLegacyConditionKeys({
        'time-of-day': ['night'],
        'video-player': { htpc: ['playing'] },
        'state-changed-ago-minutes': { gte: 5 }
    })
    assert(allThree.length === 3, 'all three legacy keys flagged in one mapping')
    assert(findLegacyConditionKeys({ time_of_day: ['night'], video_player: { htpc: ['playing'] }, state_changed_ago_minutes: { gte: 5 } }).length === 0,
        'fully migrated snake_case tree stays silent')
}

console.log('')
console.log('-- findLegacyConditionKeys(): nested composites --')
console.log('')
{
    const hits = findLegacyConditionKeys({
        illuminance: { lt: 600 },
        any_of: [
            { presence: 'kyeno' },
            { 'video-player': { htpc: ['playing'] }, all_of: [{ 'time-of-day': ['evening'] }] }
        ]
    })
    assert(hits.length === 2, 'two stale keys found inside an any_of branch tree')
    assert(hits.some(h => h.where === 'any_of[1].video-player'), 'path reports the exact composite slot (any_of[1])')
    assert(hits.some(h => h.where === 'any_of[1].all_of[0].time-of-day'), 'recurses through a second nesting level (all_of[0])')
    const dupes = findLegacyConditionKeys({
        any_of: [{ 'time-of-day': ['morning'] }, { 'time-of-day': ['night'] }]
    })
    assert(dupes.length === 2 && dupes[0].where === 'any_of[0].time-of-day' && dupes[1].where === 'any_of[1].time-of-day',
        'same legacy key in several branches yields one hit per occurrence')
}

console.log('')
console.log('-- findLegacyConditionKeys(): non-object inputs --')
console.log('')
for (const bad of [null, undefined, 'nope', 42, []]) {
    assert(findLegacyConditionKeys(bad).length === 0, `input ${JSON.stringify(bad)} yields no hits`)
}
assert(findLegacyConditionKeys(undefined).length === 0, 'missing conditions object (undefined) yields no hits')



console.log('')
console.log('-- constructor warning: stale config warns loudly, still constructs --')
console.log('')
{
    const { auto, warnings } = constructCapturing([
        'rules:',
        '  - name: stale-flat',
        '    conditions:',
        '      time-of-day: [morning]',
        '      state-changed-ago-minutes: { gte: 5 }',
        '  - name: stale-nested',
        '    conditions:',
        '      illuminance: { lt: 600 }',
        '      any_of:',
        '        - presence: kyeno',
        '        - video-player: { htpc: [playing] }',
        '          all_of:',
        '            - time-of-day: [evening]'
    ].join('\n'), 'stale')
    assert(auto !== null, 'construction succeeds despite legacy keys (warn-only, never blocks startup)')
    assert(warnings.length === 2, `one warning per offending rule (got ${warnings.length})`)
    const flat = warnings.find(w => w.message.includes('"stale-flat"'))
    assert(!!flat, 'first warning names the flat-rule offender')
    if (flat) {
        assert(flat.message.includes('time-of-day -> time_of_day'), 'flat warning carries the rename hint for time-of-day')
        assert(flat.message.includes('state-changed-ago-minutes -> state_changed_ago_minutes'),
            'flat warning carries the rename hint for state-changed-ago-minutes')
        assert(String(flat.context).includes('LegacyProbe-stale'), 'warning is routed through the automation log context')
    }
    const nested = warnings.find(w => w.message.includes('"stale-nested"'))
    assert(!!nested, 'second warning names the composite-rule offender')
    if (nested) {
        assert(nested.message.includes('any_of[1].video-player: video-player -> video_player'),
            'composite warning pinpoints the stale key inside any_of[1]')
        assert(nested.message.includes('any_of[1].all_of[0].time-of-day: time-of-day -> time_of_day'),
            'composite warning pinpoints the doubly-nested stale key')
    }
}

console.log('')
console.log('-- constructor warning: migrated config stays silent --')
console.log('')
{
    const { warnings } = constructCapturing([
        'rules:',
        '  - name: clean',
        '    conditions:',
        '      time_of_day: [evening]',
        '      illuminance: { lt: 600 }',
        '      any_of:',
        '        - presence: kyeno',
        '        - video_player: { htpc: [playing] }'
    ].join('\n'), 'clean')
    assert(warnings.length === 0, `no legacy-key warnings for a fully migrated config (got ${warnings.length})`)
}

console.log('')
if (failed > 0) {
    console.error(`${failed} FAILED, ${passed} passed`)
    process.exit(1)
}
console.log(`All ${passed} tests passed`)
