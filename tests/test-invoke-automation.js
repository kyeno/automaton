/**
 * Engine-level tests for rule-level `invoke_automation`.
 *
 * Covers the delegation mechanics that home-theater mode relies on but which are a general
 * engine feature, exercised here directly against RuleBasedAutomationBase.execute():
 *   - multiple rules referencing the same target dedupe to ONE invocation per run, with force OR-merged,
 *   - both spec shapes resolve to the same name (`name:` object form and bare-string form),
 *   - non-forced specs propagate no force flag,
 *   - pure-invoke rules still fire even when they produce zero device commands,
 *   - an invoke can coexist with normal device dispatch in the same matched rule,
 *   - invoking an unknown automation warns and returns without throwing (execution continues),
 *   - the container re-entrancy guard caps A -> B -> A cycles at the depth limit.
 * No MQTT broker or live Redis required; CacheService is stubbed like test-automation-force.js.
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
import CacheService from '../src/service/cacheService.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import AutomationContainer from '../src/automation/container/automationContainer.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
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
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

/** Minimal device stand-in recording every command it receives. */
class ProbeDevice {
    getName() { return 'Invoke Target' }
    getStateOrigin() { return null }   // not HUMAN -> local cooldown fallback passes
    getStateLastAt() { return '' }
    receiveCommand(payload, source) { this.received.push({ payload, source }) }
    received = []
}

/** Concrete rule-based automation wired to the fake device; counts resolutions. */
class InvokeProbe extends RuleBasedAutomationBase {
    constructor(name, cfgPath) {
        super({ name, configPath: cfgPath })
        this.device = new ProbeDevice()
        this.resolveCalls = 0
    }

    loadDevices() {
        return new Map([['target', this.device]])
    }

    resolveCommand(_dev, _tk, _rules) {
        this.resolveCalls++
        return { payload: 'on' }
    }
}

// -- Stubbed Redis layer -------------------------------------------------------------
// The CacheService singleton is frozen, so patch its prototype instead (mirrors force test).
const cacheProto = Object.getPrototypeOf(CacheService)
cacheProto.get = async () => undefined
cacheProto.set = async () => true
cacheProto.getHumanCooldownRemaining = async () => null

// -- Fixtures ------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-invoke-test-'))
let caseSeq = 0
function makeProbe(yamlText) {
    const cfgPath = path.join(tmpDir, `invoke-case-${caseSeq++}.yaml`)
    fs.writeFileSync(cfgPath, yamlText)
    return new InvokeProbe(`InvokeCase${caseSeq}`, cfgPath)
}

/** Capture the container's callAutomation/getAutomation for save/restore across sections. */
const containerPrototype = Object.getPrototypeOf(AutomationContainer)
const origCallAuto = containerPrototype.callAutomation
const origGetAuto = containerPrototype.getAutomation

// Recording spy: observe which automation each matched rule delegates to and with what flag.
const invocations = []
containerPrototype.callAutomation = async function(name, data = {}) {
    invocations.push({ name, force: data?.force === true })
}

console.log('\n\u2500\u2500 invoke_automation delegation semantics \u2500\u2500\n')
{
    // Two rules both reference TargetX; one is forced, one is not -> deduped to a single
    // invocation carrying force (OR-merged).
    const auto = makeProbe([
        'rules:',
        '  - name: "ref A"',
        '    invoke_automation: { name: TargetX }',
        '  - name: "ref B"',
        '    invoke_automation: { name: TargetX, force: true }'
    ].join('\n'))
    await auto.execute({ trigger: 'test' })
    assert(invocations.length === 1, 'two rules referencing the same target fire it exactly once per run')
    assert(invocations[0]?.name === 'TargetX' && invocations[0].force === true,
        'deduped invocation carries force:true (OR-merged across references)')
    invocations.length = 0
}

{
    // Bare-string spec resolves to the same name as the object form and propagates no force.
    const auto = makeProbe([
        'rules:',
        '  - name: "string ref"',
        '    invoke_automation: StringTarget'
    ].join('\n'))
    await auto.execute({ trigger: 'test' })
    assert(invocations.length === 1 && invocations[0].name === 'StringTarget',
        'bare-string invoke_automation resolves to that automation name')
    assert(invocations[0].force === false, 'non-forced spec does not set the force flag')
    invocations.length = 0
}

{
    // A rule whose only action is invoking still fires even though it dispatches nothing --
    // loadDevices() must be non-empty for execute() to proceed, but no device needs a command.
    const auto = makeProbe([
        'rules:',
        '  - name: "pure invoke"',
        '    invoke_automation: { name: PureTarget, force: true }'
    ].join('\n'))
    await auto.execute({ trigger: 'test' })
    assert(invocations.length === 1 && invocations[0].name === 'PureTarget' && invocations[0].force === true,
        'pure-invoke rule fires its target (forced) with zero device commands dispatched')
    assert(auto.device.received.length === 0, 'no device command results from a pure-invoke rule')
    invocations.length = 0
}

{
    // An invocation and a normal device dispatch can coexist in one matched rule; both happen.
    const auto = makeProbe([
        'rules:',
        '  - name: "invoke + dispatch"',
        '    invoke_automation: { name: SideEffect, force: true }',
        '    targets: { target: on }'
    ].join('\n'))
    await auto.execute({ trigger: 'test' })
    assert(invocations.length === 1 && invocations[0].name === 'SideEffect' && invocations[0].force === true,
        'invocation recorded alongside the rule\'s own device dispatch')
    assert(
        auto.resolveCalls >= 1 && auto.device.received.length === 1
            && auto.device.received[0].payload === 'on'
            && auto.device.received[0].source === DeviceCommandSource.AUTOMATION,
        'device still receives its automation-sourced command when an invoke is also present'
    )
    invocations.length = 0
}
// Restore the real entry point before exercising container-level behavior (unknown + cycles).
containerPrototype.callAutomation = origCallAuto

console.log('\n\u2500\u2500 unknown automation & re-entrancy guard \u2500\u2500\n')

{
    // Drive the REAL callAutomation with a stubbed getAutomation so we can observe the warn path
    // and the depth-limit cycle break without loading any concrete automations.
    const counts = { A: 0, B: 0 }
    containerPrototype.getAutomation = function(name) {
        if (name === 'Missing') return null
        if (name === 'CycleA') {
            return { execute: async () => { counts.A++; await AutomationContainer.callAutomation('CycleB', { trigger: 'cycle' }) } }
        }
        if (name === 'CycleB') {
            return { execute: async () => { counts.B++; await AutomationContainer.callAutomation('CycleA', { trigger: 'cycle' }) } }
        }
        return null
    }

    let threw = false
    try {
        await AutomationContainer.callAutomation('Missing', {})
    } catch (_) {
        threw = true
    }
    assert(!threw, 'invoking an unknown automation warns and returns instead of throwing')
    assert(counts.A === 0 && counts.B === 0, 'unknown invocation executes nothing downstream')

    // A -> B -> A ... must terminate at the configured depth limit rather than recurse forever.
    await AutomationContainer.callAutomation('CycleA', { trigger: 'test' })
    const total = counts.A + counts.B
    assert(total > 0, 'a mutual cycle does run before being cut off by the depth guard')
    assert(total <= 5, `depth cap bounds the A<->B cycle to a small number of executions (got ${total})`)
    assert(counts.A === 3 && counts.B === 2, 'alternating cycle stops exactly at the depth limit (A=3, B=2)')

    containerPrototype.getAutomation = origGetAuto
}

console.log(`\n${'\u2550'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed`
    + (failed > 0 ? `, ${failed} failed` : '') + `\n${'\u2550'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)