/**
 * Rule-based target derivation & validation tests.
 *
 * Covers the parts of the rule engine other suites bypass with hand-built device maps:
 *   - toTargetKey(): trim + whitespace->underscore, casing preserved
 *   - loadDevices() default implementation: derives the addressable set from the union of
 *     per-rule "targets:" keys and resolves each key against the live DeviceContainer;
 *     unknown keys warn and are excluded, non-mechanism resolutions warn (actual type named)
 *     and are excluded, duplicate-key collisions warn (first registration wins)
 *   - init() fail-fast: an instance whose declared targets ALL failed validation throws before
 *     triggers/timers are wired (the container catches this and skips that automation only);
 *     an empty declaration is valid -- speech-only / invoke_automation-only automations pass
 *     through untouched
 *   - execute(): rules match and invocations fire even when no device targets exist at all
 *   - simpleResolveCommand(): EVERY matching rule contributes to a target -- disjoint targets
 *     both act, a shared target is settled by config order (last rule wins the field it names),
 *     structured payloads merge field-wise with per-channel brightness, and a single
 *     contribution keeps the exact payload the old first-match-wins rule produced
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
import AutomationContainer from '../src/automation/container/automationContainer.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import Mechanism from '../src/device/type/mechanism.js'
import Sensor from '../src/device/type/sensor.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
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
 * A mechanism that records dispatched commands and short-circuits the cached-state reads
 * used by human-interaction cooldown checks so they fail open without Redis.
 */
class TestMechanism extends Mechanism {
    /**
     * @param {string} name - Device display name
     */
    constructor(name) {
        super(name, `test-id-${name.replace(/\s+/g, '-')}`, {})
        this.calls = []
    }

    /**
     * Record instead of publishing to MQTT.
     * @param {*} payload - Command payload
     * @param {*} source - Command origin tag
     */
    receiveCommand(payload, source) {
        this.calls.push({ payload, source })
    }

    /** No cached state -> cooldown check fails open. @returns {null} */
    getStateLast() { return null }

    /** Unknown origin -> cooldown check fails open. @returns {'unknown'} */
    getStateOrigin() { return 'unknown' }

    /** Never updated -> cooldown check fails open. @returns {null} */
    getStateLastAt() { return null }
}

/**
 * Register a device in the live container under its friendly name (same idiom as the AI suites).
 * @param {string} name - Friendly name
 * @param {Object} dev - Device instance
 * @returns {Object} The registered device
 */
function register(name, dev) {
    Object.assign(DeviceContainer.getAll(), { [name]: dev })
    return dev
}

let caseSeq = 0

/**
 * Minimal concrete automation over the real base-class target logic; each config gets a
 * distinct instance name for log clarity.
 */
class TestTargetsAutomation extends RuleBasedAutomationBase {
    /**
     * @param {string} configPath - Path to a YAML config file
     */
    constructor(configPath) {
        super({ name: `TestTargets${++caseSeq}`, configPath })
    }

    /**
     * Simplest possible resolution: apply the first declared command for this target key.
     * @param {*} device - Resolved mechanism
     * @param {string} targetKey - Target key from the rule map
     * @param {{}[]} matchingRules - Matched rules
     * @returns {{payload?: *, skip?: boolean}} Command payload or explicit skip
     */
    resolveCommand(device, targetKey, matchingRules) {
        for (const rule of matchingRules) {
            const cmd = rule.targets?.[targetKey]
            if (cmd !== undefined) return { payload: cmd }
        }
        return { skip: true }
    }
}

// ---------------------------------------------------------------------------
// toTargetKey unit checks
// ---------------------------------------------------------------------------

console.log('\n── toTargetKey ──\n')
assert(toTargetKey('Living Room Light') === 'Living_Room_Light', 'spaces collapse to underscores')
assert(toTargetKey('  Kitchen   Outlet  ') === 'Kitchen_Outlet', 'leading/trailing + repeated whitespace trimmed/collapsed')
assert(toTargetKey('Sypialnia Roleta Okno Lewe Lewa') === 'Sypialnia_Roleta_Okno_Lewe_Lewa', 'multi-word names keep casing and word order')
assert(toTargetKey('BalkonSwiatlo') === 'BalkonSwiatlo', 'single token passes through unchanged')

// ---------------------------------------------------------------------------
// Empty declaration set is valid (speech-only / invoke-only automations)
// ---------------------------------------------------------------------------

console.log('\n── empty target union survives construction & init ──\n')
{
    // A rule with no "targets:" map at all -- the TTS/greeter shape.
    const cfg = writeConfig('empty-union.yaml', [
        'rules:',
        "  - name: 'No device targets'",
        "    invoke_automation: 'SideEffect'"
    ])
    const auto = new TestTargetsAutomation(cfg)
    assert(auto.loadDevices().size === 0, 'loadDevices() returns an empty Map when no rule declares targets')
    let initOk = true
    try { await auto.init() } catch { initOk = false }
    assert(initOk, 'init() does not throw for a zero-target automation')

    // The old landmine: execute() used to abort before rule matching when no devices existed.
    // Now invocations must still fire even though there are zero device targets.
    const containerPrototype = Object.getPrototypeOf(AutomationContainer)
    const origCallAuto = containerPrototype.callAutomation
    /** @type {{name: string}[]} */
    const invocations = []
    containerPrototype.callAutomation = async function(name) { invocations.push({ name }) }
    let execThrew = null
    try { await auto.execute({ trigger: 'test' }) } catch (e) { execThrew = e.message }
    containerPrototype.callAutomation = origCallAuto
    assert(execThrew === null, `execute() completes with zero device targets (threw: ${execThrew ?? 'nothing'})`)
    assert(invocations.length === 1 && invocations[0].name === 'SideEffect',
        'invoke_automation fires despite the absence of any device target')
}
{
    // Even more extreme: no rules at all (closest shape to tts-greeter.yaml).
    const cfg = writeConfig('no-rules.yaml', [
        '# speech-only automation -- no rules section whatsoever'
    ])
    const auto = new TestTargetsAutomation(cfg)
    let initOk = true
    try { await auto.init() } catch { initOk = false }
    assert(initOk, 'init() does not throw when the config has no rules either')
}

// ---------------------------------------------------------------------------
// Partial invalidity: valid mechanisms survive alongside warned bogus keys
// ---------------------------------------------------------------------------

console.log('\n── partial invalid targets ──\n')
{
    const outlet = register('Valid Outlet', new TestMechanism('Valid Outlet'))
    const cfg = writeConfig('partial-invalid.yaml', [
        'rules:',
        "  - name: 'Mixed validity'",
        '    targets:',
        '      Valid_Outlet: ON',
        '      Bogus_Key: OFF'
    ])
    const auto = new TestTargetsAutomation(cfg)
    const devices = auto.loadDevices()
    assert(devices.size === 1 && devices.has('Valid_Outlet'),
        'valid key resolves; unknown key excluded from the device map')
    assert(devices.get('Valid_Outlet') === outlet, 'resolved entry is the registered mechanism instance')

    let initOk = true
    try { await auto.init() } catch { initOk = false }
    assert(initOk, 'init() passes while at least one declared target is a valid mechanism')

    await auto.execute({ trigger: 'test' })
    assert(outlet.calls.length === 1 && outlet.calls[0].payload === 'ON',
        'execute() dispatches only to the resolved device with its rule command')
    assert(outlet.calls[0]?.source === DeviceCommandSource.AUTOMATION,
        'dispatch carries the AUTOMATION origin tag')
}

// ---------------------------------------------------------------------------
// Total invalidity: construction survives, init() throws (container kills this automation only)
// ---------------------------------------------------------------------------

console.log('\n── all declared targets invalid ──\n')
{
    const cfg = writeConfig('all-invalid.yaml', [
        'rules:',
        "  - name: 'Nothing resolvable'",
        '    targets:',
        '      Missing_A: ON',
        '      Missing_B: OFF'
    ])
    // Construction itself must not throw -- fail-fast happens at activation time.
    const auto = new TestTargetsAutomation(cfg)
    assert(auto.loadDevices().size === 0, 'loadDevices() yields an empty Map when nothing resolves')
    let rejection = null
    try { await auto.init() } catch (e) { rejection = e.message }
    assert(rejection !== null && /failed validation/.test(rejection),
        `init() rejects naming every offending key (got: ${rejection ?? 'no error'})`)
}

// ---------------------------------------------------------------------------
// Non-mechanism resolutions are warned about and excluded
// ---------------------------------------------------------------------------

console.log('\n── non-mechanism target types ──\n')
{
    register('Balkon Swiatlo', new Sensor('Balkon Swiatlo', 'test-id-sensor-1', {}))
    const cfgOnlySensor = writeConfig('sensor-only.yaml', [
        'rules:',
        "  - name: 'Sensors are not actuators'",
        '    targets:',
        '      Balkon_Swiatlo: ON'
    ])
    const auto = new TestTargetsAutomation(cfgOnlySensor)
    assert(auto.loadDevices().size === 0, 'a sensor resolving a declared key is excluded from the map')
    let rejection = null
    try { await auto.init() } catch (e) { rejection = e.message }
    assert(rejection !== null && /failed validation/.test(rejection),
        'all-non-mechanism declarations reject at init like all-missing ones')
}
{
    const plug = register('Kuchnia Gniazdo', new TestMechanism('Kuchnia Gniazdo'))
    register('Balkon Temperatura', new Sensor('Balkon Temperatura', 'test-id-sensor-2', {}))
    const cfgMixed = writeConfig('mixed-types.yaml', [
        'rules:',
        "  - name: 'Actuator plus sensor'",
        '    targets:',
        '      Kuchnia_Gniazdo: OFF',
        '      Balkon_Temperatura: OFF'
    ])
    const auto = new TestTargetsAutomation(cfgMixed)
    const devices = auto.loadDevices()
    assert(devices.size === 1 && devices.has('Kuchnia_Gniazdo'),
        'mechanism kept, sensor excluded when both are declared')
    let initOk = true
    try { await auto.init() } catch { initOk = false }
    assert(initOk, 'init() passes with a valid mechanism alongside an excluded sensor')
    await auto.execute({ trigger: 'test' })
    assert(plug.calls.length === 1 && plug.calls[0].payload === 'OFF', 'only the actuator receives the command')
}

// ---------------------------------------------------------------------------
// Duplicate-key collisions warn; first registration wins
// ---------------------------------------------------------------------------

console.log('\n── duplicate target keys ──\n')
{
    // Two registered names collapsing onto one key (single vs double space).
    const first = register('Living Room Light', new TestMechanism('Living Room Light'))
    register('Living  Room Light', new TestMechanism('Living  Room Light'))
    const cfg = writeConfig('duplicate-keys.yaml', [
        'rules:',
        "  - name: 'Collision'",
        '    targets:',
        '      Living_Room_Light: CLOSE'
    ])
    const auto = new TestTargetsAutomation(cfg)
    const devices = auto.loadDevices()
    assert(devices.size === 1 && devices.has('Living_Room_Light'), 'colliding declaration resolves to exactly one device')
    assert(devices.get('Living_Room_Light') === first, 'first-registered device wins the collision')
    let initOk = true
    try { await auto.init() } catch { initOk = false }
    assert(initOk, 'init() passes despite a warned-about key collision')
}

// ---------------------------------------------------------------------------
// Multi-rule target merge: every matching rule acts (simpleResolveCommand)
// ---------------------------------------------------------------------------

console.log('\n── multi-rule target merge ──\n')
{
    const cfg = writeConfig('merge.yaml', [
        'rules:',
        "  - name: 'Any'",
        '    targets:',
        '      A: ON'
    ])
    const auto = new TestTargetsAutomation(cfg)
    const resolve = (rules, key) => auto.simpleResolveCommand(null, key, rules)
    const json = (r) => JSON.stringify(r?.payload)

    //  Backward compatibility: a single contribution yields exactly the legacy payload.
    assert(json(resolve([{ targets: { A: 'ON' } }], 'A')) === JSON.stringify({ state: 'ON' }),
        'single ON rule -> {state:"ON"}, unchanged from first-match-wins')
    assert(json(resolve([{ targets: { A: 'OFF' } }], 'A')) === JSON.stringify({ state: 'OFF' }),
        'single OFF rule -> {state:"OFF"}')
    assert(json(resolve([{ targets: { A: { state: 'ON', brightness: { l1: 50 } } } }], 'A'))
        === JSON.stringify({ state: 'ON', brightness: { l1: 50 } }),
        'single structured rule -> payload passed through untouched')
    assert(resolve([{ targets: { B: 'ON' } }], 'A') === null,
        'a rule that does not declare this target yields no command')
    assert(resolve([{ targets: { A: null } }], 'A') === null,
        'a null target value yields no command')

    //  Disjoint targets: both rules act, each on its own device.
    const disjoint = [{ targets: { A: 'ON' } }, { targets: { B: 'OFF' } }]
    assert(json(resolve(disjoint, 'A')) === JSON.stringify({ state: 'ON' })
            && json(resolve(disjoint, 'B')) === JSON.stringify({ state: 'OFF' }),
        'disjoint targets from two matching rules both act')

    //  Shared target: the LAST matching rule in config order wins the field it names.
    assert(json(resolve([{ targets: { A: 'ON' } }, { targets: { A: 'OFF' } }], 'A'))
        === JSON.stringify({ state: 'OFF' }),
        'ON then OFF on one target -> last rule wins (OFF)')
    assert(json(resolve([{ targets: { A: 'OFF' } }, { targets: { A: 'ON' } }], 'A'))
        === JSON.stringify({ state: 'ON' }),
        'OFF then ON on one target -> last rule wins (ON)')

    //  Structured contributions merge field-wise; the per-channel brightness map merges
    //  channel-wise, so a narrow refinement keeps the channels it does not name.
    assert(json(resolve([
        { targets: { A: { state: 'ON', brightness: { l1: 50, l2: 25 } } } },
        { targets: { A: { brightness: { l2: 10 } } } }
    ], 'A')) === JSON.stringify({ state: 'ON', brightness: { l1: 50, l2: 10 } }),
        'structured rules merge field-wise and brightness merges per channel')
    assert(json(resolve([
        { targets: { A: { brightness: { l1: 40 } } } },
        { targets: { A: 'ON' } }
    ], 'A')) === JSON.stringify({ brightness: { l1: 40 }, state: 'ON' }),
        'a later bare ON adds state and keeps the earlier brightness')

    //  A scalar OPEN/CLOSE is terminal; numeric positions fold last-wins.
    assert(json(resolve([{ targets: { A: { state: 'ON' } } }, { targets: { A: 'OPEN' } }], 'A'))
        === JSON.stringify('OPEN'),
        'a scalar OPEN replaces the accumulated payload wholesale')
    assert(json(resolve([{ targets: { A: 30 } }, { targets: { A: 70 } }], 'A'))
        === JSON.stringify({ position: 70 }),
        'numeric positions fold last-wins')

    //  Merging must not mutate the rule objects it reads (the config is shared state).
    const source = { targets: { A: { state: 'ON', brightness: { l1: 50 } } } }
    resolve([source, { targets: { A: { brightness: { l2: 10 } } } }], 'A')
    assert(JSON.stringify(source.targets.A) === JSON.stringify({ state: 'ON', brightness: { l1: 50 } }),
        'merging does not mutate the rule config')
}

console.log('\n── multi-rule dispatch (execute) ──\n')
{
    // End-to-end: two rules match the same tick. Each contributes its own targets, and the
    // shared target is settled by config order -- no rule is shadowed by an earlier one.
    class MergeAutomation extends TestTargetsAutomation {
        resolveCommand(device, targetKey, matchingRules) {
            return this.simpleResolveCommand(device, targetKey, matchingRules)
        }
    }
    const alpha = register('Merge Alpha Light', new TestMechanism('Merge Alpha Light'))
    const beta = register('Merge Beta Light', new TestMechanism('Merge Beta Light'))
    const cfg = writeConfig('merge-dispatch.yaml', [
        'rules:',
        "  - name: 'Broad dusk rule'",
        '    targets:',
        '      Merge_Alpha_Light: ON',
        "  - name: 'Narrow midnight rule'",
        '    targets:',
        '      Merge_Beta_Light: ON',
        '      Merge_Alpha_Light: OFF'
    ])
    const auto = new MergeAutomation(cfg)
    await auto.execute({ trigger: 'test' })
    const payloads = (dev) => dev.calls.map((c) => JSON.stringify(c.payload))
    assert(alpha.calls.length === 1 && JSON.stringify(alpha.calls[0].payload) === JSON.stringify({ state: 'OFF' }),
        `shared target gets exactly one command, from the later rule (got [${payloads(alpha)}])`)
    assert(beta.calls.length === 1 && JSON.stringify(beta.calls[0].payload) === JSON.stringify({ state: 'ON' }),
        `the other rule's own target acts in the same run (got [${payloads(beta)}])`)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(42)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(42)}\n`)

process.exit(failed > 0 ? 1 : 0)