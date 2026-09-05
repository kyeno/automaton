/**
 * Rule-based target-key rewrite tests.
 *
 * Covers the parts of the rule engine touched by the "targets:" format change
 * that other suites bypass with hand-built device maps:
 *   - toTargetKey(): trim + whitespace->underscore, casing preserved
 *   - loadDevices(): top-level targets list of friendly names -> Map keyed by
 *     toTargetKey(name); missing devices skipped; legacy "{name, id}" objects
 *     and non-string entries rejected gracefully instead of throwing
 *   - validateTargets(): duplicate key detection and unknown rule-key
 *     detection (the previously silently-inert typo class)
 *   - execute() integration: real YAML parse -> dispatch through the base
 *     class, with misconfiguration warnings logged exactly once per config
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

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import { toTargetKey } from '../src/lib/string.js'

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
        console.log(`  ✓ ${label}`)
        passed++
    } else {
        console.error(`  ✗ ${label}`)
        failed++
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'automaton-targets-test-'))

/**
 * Write a YAML config into the temp dir and return its path.
 * @param {string} file - File name inside the temp dir
 * @param {string[]} lines - YAML source lines
 * @returns {string} Absolute path
 */
function writeConfig(file, lines) {
    const path = join(TEST_CONFIG_DIR, file)
    writeFileSync(path, lines.join('\n') + '\n')
    return path
}

/**
 * Create a stub device that records received commands and mimics the base
 * class's cached-state reads so cooldown checks fail open like in other suites.
 * @param {string} name - Device display name
 * @returns {Object} Stub device
 */
function makeStubDevice(name) {
    return {
        name,
        calls: [],
        stateLast: null,
        getName() { return name },
        receiveCommand(payload, source) { this.calls.push({ payload, source }) },
        getStateLast() { return this.stateLast },
        getStateOrigin() { return 'unknown' },
        getStateLastAt() { return null }
    }
}

/**
 * Minimal concrete automation over the real base-class target logic.
 * findDevice() is backed by an injectable name->stub map instead of the live
 * DeviceContainer; resolveCommand delegates to the shared first-rule-wins
 * resolver exactly like production light automations do.
 */
class TestTargetsAutomation extends RuleBasedAutomationBase {
    /** @type {Map<string, Object>} */ devicesByName = new Map()

    /**
     * @param {string} configPath - Path to a temp YAML config
     */
    constructor(configPath) {
        super({ name: 'TestTargetsAutomation', configPath })
    }

    async buildContext() { return {} }

    findDevice(name) { return this.devicesByName.get(name) ?? null }

    resolveCommand(device, targetId, matchingRules) {
        return this.simpleResolveCommand(device, targetId, matchingRules)
    }
}

// ---------------------------------------------------------------------------
// toTargetKey unit checks
// ---------------------------------------------------------------------------

console.log('\n── toTargetKey ──\n')

assert(toTargetKey('Kuchnia Gniazdo LED') === 'Kuchnia_Gniazdo_LED',
    'spaces -> underscores, casing preserved')
assert(toTargetKey('  Salon   Roleta Okno Lewe ') === 'Salon_Roleta_Okno_Lewe',
    'trims and collapses whitespace runs')
assert(toTargetKey('LED Strip') !== 'led_strip',
    'does not lowercase (unlike slugify)')

// ---------------------------------------------------------------------------
// loadDevices(): real base-class path over the new targets list format
// ---------------------------------------------------------------------------

console.log('\n── loadDevices() with mixed/legacy entries ──\n')

{
    const cfg = writeConfig('mixed.yaml', [
        'targets:',
        "  - 'Kitchen Outlet'",
        "  - 'Missing Device'",
        "  - name: 'Legacy Name'",
        '    id: legacy_id',
        '  - 42',
        'rules: []'
    ])
    const auto = new TestTargetsAutomation(cfg)
    auto.devicesByName.set('Kitchen Outlet', makeStubDevice('Kitchen Outlet'))

    const devices = auto.loadDevices()
    assert(devices.size === 1, 'only resolvable string entries land in the map')
    assert(devices.has('Kitchen_Outlet'), 'map keyed by toTargetKey(name), casing kept')
    assert(devices.get('Kitchen_Outlet').getName() === 'Kitchen Outlet',
        'key resolves back to the exact registered device')
}

// ---------------------------------------------------------------------------
// validateTargets(): duplicate keys and unknown rule keys
// ---------------------------------------------------------------------------

console.log('\n── validateTargets() ──\n')

{
    // Consistent config -> no warnings.
    const clean = new TestTargetsAutomation(writeConfig('clean.yaml', [
        'targets:',
        "  - 'A B'",
        "  - 'C D'",
        'rules:',
        "  - name: 'r'",
        '    targets:',
        '      A_B: ON',
        '      C_D: OFF'
    ]))
    assert(clean.validateTargets().length === 0, 'consistent config reports no issues')
    assert(clean.validateTargets().length === 0, 'pure -- repeated calls agree')

    // Two names collapsing onto one key (differ only by a whitespace run).
    const dup = new TestTargetsAutomation(writeConfig('dup.yaml', [
        'targets:',
        "  - 'Kuchnia Gniazdo'",
        "  - 'Kuchnia  Gniazdo'"
    ]))
    const dupWarnings = dup.validateTargets()
    assert(dupWarnings.length === 1 && dupWarnings[0].includes('Duplicate target key'),
        'duplicate keys detected')
    assert(dupWarnings[0].includes('"Kuchnia Gniazdo"') && dupWarnings[0].includes('"Kuchnia  Gniazdo"'),
        'both colliding names are named in the warning')

    // Rule references a key no declared target maps to.
    const unknown = new TestTargetsAutomation(writeConfig('unknown.yaml', [
        'targets:',
        "  - 'A B'",
        'rules:',
        "  - name: 'r'",
        '    targets:',
        '      A_B: ON',
        '      Typo_Key: OFF'
    ]))
    const warnings = unknown.validateTargets()
    assert(warnings.some(w => w.includes('Typo_Key')), 'unknown rule key reported')
    assert(warnings.some(w => w.includes('"A_B"')), 'valid keys listed for correction')
}

// ---------------------------------------------------------------------------
// execute(): real YAML -> dispatch, warnings exactly once per config object
// ---------------------------------------------------------------------------

console.log('\n── execute() end-to-end with a typo in one rule ──\n')

{
    const cfg = writeConfig('e2e.yaml', [
        'targets:',
        "  - 'Kitchen Outlet'",
        "  - 'Hallway Outlet'",
        'rules:',
        "  - name: 'all off'",
        '    targets:',
        '      Kitchen_Outlet: OFF',
        '      Hallway_Outlet: OFF',
        "  - name: 'typo rule (should warn once and stay inert)'",
        '    targets:',
        '      Kitchen_Oulet: ON'
    ])
    const auto = new TestTargetsAutomation(cfg)
    const kitchen = makeStubDevice('Kitchen Outlet')
    const hallway = makeStubDevice('Hallway Outlet')
    auto.devicesByName.set('Kitchen Outlet', kitchen)
    auto.devicesByName.set('Hallway Outlet', hallway)

    // Count only the misconfiguration warning so unrelated log noise cannot skew it.
    let undeclaredWarns = 0
    const originalLog = auto.log.bind(auto)
    auto.log = function (message, level) {
        if (level === 'warn' && String(message).includes('undeclared keys')) undeclaredWarns++
        return originalLog(message, level)
    }

    await auto.execute({ trigger: 'test' })
    await auto.execute({ trigger: 'test' })

    assert(undeclaredWarns === 1, 'unknown-key warning logged exactly once across two runs')
    for (const dev of [kitchen, hallway]) {
        assert(dev.calls.length === 2 && dev.calls.every(c => JSON.stringify(c.payload) === '{"state":"OFF"}'),
            `${dev.name}: OFF dispatched on every run despite the typo rule`)
        assert(dev.calls.every(c => c.source === DeviceCommandSource.AUTOMATION),
            `${dev.name}: commands marked automation-originated`)
    }
}

console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)