/**
 * Rule-match history tests.
 *
 * Coverage for the per-automation record RuleBasedAutomationBase keeps of every rule
 * match and publishes on the EventBus for the rules window to render:
 *   - a matching rule publishes automation:ruleMatched carrying automation, rule,
 *     timestamp, trigger, forced flag and the acted outcome,
 *   - the acted flag is false when the match produced no action and true when it did,
 *   - a forced run is recorded as forced,
 *   - getRecentRuleMatches() returns the newest match first and is capped,
 *   - the EventBus record and the stored history share one identity triple
 *     (automation, rule, timestamp) the rules window matches on,
 *   - plain AutomationBase instances expose an empty history so the window can seed
 *     from any automation.
 * No MQTT broker or live Redis required; CacheService is stubbed like
 * test-invoke-automation.js.
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
import EventBus from '../src/service/eventBus.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import AutomationBase from '../src/automation/base/automationBase.js'

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
    getName() { return 'Match Target' }
    getStateOrigin() { return null }
    getStateLastAt() { return '' }
    receiveCommand(payload, source) { this.received.push({ payload, source }) }
    received = []
}

/** Concrete rule-based automation wired to the fake device. */
class MatchProbe extends RuleBasedAutomationBase {
    constructor(name, cfgPath) {
        super({ name, configPath: cfgPath })
        this.device = new ProbeDevice()
    }

    loadDevices() {
        return new Map([['target', this.device]])
    }

    resolveCommand(_dev, _tk, _rules) {
        return { payload: 'on' }
    }
}

/** Rule-based automation with no devices, so matches cannot produce actions. */
class EmptyProbe extends RuleBasedAutomationBase {
    constructor(name, cfgPath) {
        super({ name, configPath: cfgPath })
    }

    loadDevices() {
        return new Map()
    }
}

// -- Stubbed Redis layer -------------------------------------------------------------
const cacheProto = Object.getPrototypeOf(CacheService)
cacheProto.get = async () => undefined
cacheProto.set = async () => true
cacheProto.getHumanCooldownRemaining = async () => null

// -- EventBus capture ----------------------------------------------------------------
const published = { matched: [], acted: [] }
EventBus.subscribe('automation:ruleMatched', (record) => published.matched.push(record))
EventBus.subscribe('automation:ruleActed', (record) => published.acted.push(record))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-rules-test-'))
let caseSeq = 0

/**
 * Build a rule-based automation from inline YAML.
 * @param {string} yamlText - Rule config
 * @param {typeof RuleBasedAutomationBase} [Cls] - Probe class to instantiate
 * @returns {RuleBasedAutomationBase} Automation under test
 */
function makeProbe(yamlText, Cls = MatchProbe) {
    const cfgPath = path.join(tmpDir, `rules-case-${caseSeq++}.yaml`)
    fs.writeFileSync(cfgPath, yamlText)
    return new Cls(`RulesCase${caseSeq}`, cfgPath)
}

// -- A match that acts is published and recorded --------------------------------------

console.log('\n\u2500\u2500 Match with action \u2500\u2500\n')

{
    published.matched.length = 0
    published.acted.length = 0

    const auto = makeProbe([
        'rules:',
        '  - name: "always-on"',
        '    devices:',
        '      - target',
        '    action: "on"'
    ].join('\n'))

    await auto.execute({ trigger: 'timer' })

    const record = published.matched[0]
    assert(published.matched.length === 1, 'one rule match published')
    assert(record?.automation === auto.name, 'record carries the automation name')
    assert(record?.rule === 'always-on', 'record carries the rule name')
    assert(record?.trigger === 'timer', 'record carries the trigger')
    assert(record?.forced === false, 'unforced run recorded as unforced')
    assert(record?.acted === false, 'match event reports the outcome as not yet known')
    assert(Number.isInteger(record?.at), 'record carries a numeric timestamp')
    assert(published.acted.length === 1 && published.acted[0].rule === 'always-on',
        'acted outcome published on its own channel')
    assert(published.acted[0]?.acted === true, 'acted event carries the acted flag')
    assert(published.acted[0]?.at === record?.at,
        'acted event shares the match identity timestamp')

    const history = auto.getRecentRuleMatches()
    assert(history.length === 1, 'history holds the match')
    assert(history[0].rule === 'always-on' && history[0].acted === true,
        'stored history agrees with the published record')
    assert(history[0].at === record.at, 'identity timestamp shared by event and history')

    auto.cleanup()
}

// -- A match without action is recorded as matched ------------------------------------

console.log('\n\u2500\u2500 Match without action \u2500\u2500\n')

{
    published.matched.length = 0
    published.acted.length = 0

    const auto = makeProbe([
        'rules:',
        '  - name: "no-devices-here"',
        '    devices:',
        '      - target'
    ].join('\n'), EmptyProbe)

    await auto.execute({ trigger: 'sensor' })

    const record = published.matched[0]
    assert(published.matched.length === 1, 'match published even with no devices')
    assert(record?.acted === false, 'record reports no action')
    assert(published.acted.length === 0, 'no acted outcome published')
    assert(auto.getRecentRuleMatches()[0]?.acted === false, 'history records the bare match')

    auto.cleanup()
}

// -- Forced runs ---------------------------------------------------------------------

console.log('\n\u2500\u2500 Forced runs \u2500\u2500\n')

{
    published.matched.length = 0

    const auto = makeProbe([
        'rules:',
        '  - name: "forced-rule"',
        '    devices:',
        '      - target',
        '    action: "on"'
    ].join('\n'))

    await auto.execute({ trigger: 'manual', force: true })

    const record = published.matched[0]
    assert(record?.forced === true, 'forced run recorded as forced')
    assert(record?.trigger === 'manual', 'manual trigger recorded')

    auto.cleanup()
}

// -- History ordering and cap --------------------------------------------------------

console.log('\n\u2500\u2500 History ordering and cap \u2500\u2500\n')

{
    published.matched.length = 0

    const rules = ['rules:']
    for (let i = 0; i < 65; i++) {
        rules.push(`  - name: "rule-${i}"`)
        rules.push('    devices:')
        rules.push('      - target')
        rules.push('    action: "on"')
    }
    const auto = makeProbe(rules.join('\n'))

    await auto.execute({ trigger: 'timer' })

    const history = auto.getRecentRuleMatches()
    assert(history.length === 25, 'history capped at 25 matches')
    assert(history[0]?.rule === 'rule-64', 'newest match first')
    assert(!history.some((m) => m.rule === 'rule-0'), 'oldest match dropped')
    assert(published.matched.length === 65, 'every match published, cap applies to history only')

    auto.cleanup()
}

// -- Plain automations expose an empty history ---------------------------------------

console.log('\n\u2500\u2500 Base automation history \u2500\u2500\n')

{
    class PlainAuto extends AutomationBase {
        execute() {}
    }
    const plain = new PlainAuto({ name: 'Plain' })
    assert(Array.isArray(plain.getRecentRuleMatches()) && plain.getRecentRuleMatches().length === 0,
        'AutomationBase reports an empty rule history')
}

// -- Summary -------------------------------------------------------------------------

const total = passed + failed
console.log(`\nResults: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}\n`)

process.exit(failed > 0 ? 1 : 0)

