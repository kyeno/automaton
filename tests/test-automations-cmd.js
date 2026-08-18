/**
 * Automations command tests.
 * Behavioral coverage for the /automations subcommand dispatcher: GNU-style usage help on
 * bare invocation, tree listing via "list", single-item detail view via "debug" (silence
 * window, per-rule condition summaries, config keys fallback), and manual triggering via
 * "run" asserting execute() receives the "manual" trigger reason. Name resolution covers
 * exact, case-insensitive, unknown, and missing-name paths. The command is driven through
 * a stub context + container pair that records every printed line and every
 * callAutomation() dispatch, so assertions read what would actually hit the screen and
 * the automation engine.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import AutomationsCmd from '../src/ui/commands/automationsCmd.js'

let passed = 0
let failed = 0

function assertEqual(actual, expected, label) {
    if (actual === expected) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
        failed++
    }
}

// -- Stub harness --------------------------------------------------------------

/**
 * Fake automation shaped like a RuleBasedAutomationBase instance so getType()
 * detects the "ruleBased" prototype-chain pattern naturally.
 */
class FakeRuleBasedAutomation {
    constructor(name, config = {}) {
        this.name = name
        this._initialized = true
        this.config = config
        this.lastTriggerData = null
    }

    getTriggerTopics() { return [] }

    getTimerIntervalMs() { return 45_000 }

    async execute(triggerData) { this.lastTriggerData = triggerData }
}

/**
 * Build a stub AutomationContainer around fake instances. Mirrors the real API surface
 * the command relies on and records every callAutomation() dispatch for assertions.
 * @param {Array<Object>} automations - Fake automation instances
 * @returns {{calls: Array, getAll: Function, getAutomation: Function, callAutomation: Function}}
 */
function makeContainer(automations) {
    const map = new Map(automations.map((a) => [a.name, a]))
    const calls = []
    return {
        calls,
        getAll: () => map,
        getAutomation: (name) => map.get(name) ?? null,
        callAutomation: async (name, data) => {
            const inst = map.get(name)
            if (!inst || typeof inst.execute !== 'function') return // mirrors container warn path
            calls.push({ name, data })
            await inst.execute(data)
        },
    }
}

/**
 * Instantiate an AutomationsCmd wired to a recording print context.
 * @param {Object|null} container - Stub container; null simulates a missing service
 * @returns {{cmd: Object, printed: string[]}} Command instance plus captured output lines
 */
function createHarness(container) {
    const printed = []
    const ctx = { print: (text) => printed.push(String(text)) }
    if (container) ctx.automationContainer = container
    return { cmd: new AutomationsCmd(ctx), printed }
}

// -- Fixtures ------------------------------------------------------------------

const ambientConfig = {
    silence_between: '2300-0600',
    rules: [
        { name: 'Dawn cleanup', conditions: { 'time-of-day': 'morning', illuminance: { gte: 400 } }, once: true },
        { name: 'Dusk ambience', conditions: { 'time-of-day': ['evening', 'night'] } },
    ],
}
const ambient = new FakeRuleBasedAutomation('AmbientLightsAutomation', ambientConfig)
const weatherman = new FakeRuleBasedAutomation('TtsWeatherManAutomation', {})
weatherman.getTriggerTopics = () => ['network:kyeno']

/** Plain-object automation without a rule-based prototype chain or any rules. */
const legacy = {
    name: 'LegacyAuto',
    _initialized: false,
    config: { note: 'plain object automation' },
    getTriggerTopics() { return [] },
    getTimerIntervalMs() { return 0 },
}

// -- Usage help ------------------------------------------------------------------

console.log('\n\u2500\u2500 Usage help \u2500\u2500\n')

{
    // Bare invocation renders GNU-style usage with the registered names listed last
    const bare = createHarness(makeContainer([ambient, weatherman]))
    await bare.cmd.execute('')
    assertEqual(bare.printed[0].split('\n')[0], 'Usage: /automations <subcommand> [args]', 'usage header line')
    assertEqual(bare.printed[0].includes('list'), true, 'usage lists "list" subcommand')
    assertEqual(bare.printed[0].includes('debug <name>'), true, 'usage lists "debug" subcommand')
    assertEqual(bare.printed[0].includes('run <name>'), true, 'usage lists "run" subcommand')
    assertEqual(
        bare.printed[0].endsWith('Available: AmbientLightsAutomation, TtsWeatherManAutomation'),
        true,
        'usage footer lists available automations sorted'
    )
}

{
    // Empty registry still prints usage but notes there is nothing loaded
    const empty = createHarness(makeContainer([]))
    await empty.cmd.execute('   ')
    assertEqual(empty.printed[0].startsWith('Usage: /automations'), true, 'whitespace-only args also show usage')
    assertEqual(empty.printed[0].endsWith('(no automations loaded)'), true, 'usage notes empty registry')
}

{
    // Unknown subcommand reports the verb then falls back to full usage
    const unknown = createHarness(makeContainer([ambient, weatherman]))
    await unknown.cmd.execute('frobnicate x')
    assertEqual(unknown.printed[0], 'Unknown subcommand "frobnicate"', 'unknown subcommand error line')
    assertEqual(unknown.printed[1].startsWith('Usage: /automations'), true, 'unknown subcommand shows usage after error')
}

{
    // Missing container degrades gracefully instead of throwing
    const noContainer = createHarness(null)
    await noContainer.cmd.execute('list')
    assertEqual(noContainer.printed[0], '(AutomationContainer not available)', 'missing container notice')
}

// -- List view -------------------------------------------------------------------

console.log('\n\u2500\u2500 List view \u2500\u2500\n')

{
    // Single-entry tree keeps the exact original format
    const solo = new FakeRuleBasedAutomation('SoloAutomation', { rules: [{}] })
    solo.getTriggerTopics = () => ['zigbee:Lamp']
    const h = createHarness(makeContainer([solo]))
    await h.cmd.execute('list')
    const expected = [
        '\u2514\u2500 SoloAutomation',
        '\u2502   \u251c\u2500 status: [OK]',
        '\u2502   \u251c\u2500 type: ruleBased',
        '\u2502   \u251c\u2500 timer: every 45s',
        '\u2502   \u251c\u2500 triggers: zigbee:Lamp',
        '\u2502   \u2514\u2500 rules: 1',
    ].join('\n')
    assertEqual(h.printed[0], expected, 'single automation renders the classic tree')
}

{
    // Multiple entries keep branch prefixes and blank separators aligned; extra tokens ignored
    const h = createHarness(makeContainer([ambient, weatherman]))
    await h.cmd.execute('list extra junk is ignored')
    const lines = h.printed[0].split('\n')
    assertEqual(lines.length, 13, 'two automations produce header+props blocks with separator')
    assertEqual(lines[0], '\u251c\u2500 AmbientLightsAutomation', 'first entry uses intermediate branch prefix')
    assertEqual(lines[6], '', 'blank line separates entries')
    assertEqual(lines[7], '\u2514\u2500 TtsWeatherManAutomation', 'last entry uses final branch prefix')
    assertEqual(lines[11].includes('triggers: network:kyeno'), true, 'trigger topics are listed when present')
}

{
    // Empty registry keeps its original notice
    const h = createHarness(makeContainer([]))
    await h.cmd.execute('list')
    assertEqual(h.printed[0], '(no automations loaded)', 'empty list notice unchanged')
}

// -- Debug view ------------------------------------------------------------------

console.log('\n\u2500\u2500 Debug view \u2500\u2500\n')

{
    // Rule-based automation gets silence window plus per-rule condition summaries
    const h = createHarness(makeContainer([ambient, weatherman]))
    await h.cmd.execute('debug AmbientLightsAutomation')
    const expected = [
        '\u2514\u2500 AmbientLightsAutomation',
        '\u2502   \u251c\u2500 status: [OK]',
        '\u2502   \u251c\u2500 type: ruleBased',
        '\u2502   \u251c\u2500 timer: every 45s',
        '\u2502   \u251c\u2500 triggers: --',
        '\u2502   \u251c\u2500 silence: 2300-0600',
        '\u2502   \u251c\u2500 rules: 2',
        '\u2502   \u251c\u2500 rule 1: "Dawn cleanup" -- time-of-day=morning | illuminance>=400 [once/day]',
        '\u2502   \u2514\u2500 rule 2: "Dusk ambience" -- time-of-day=[evening|night]',
    ].join('\n')
    assertEqual(h.printed[0], expected, 'debug renders base props plus silence and per-rule detail')
}

{
    // Non-rule-based automation without rules falls back to config keys
    const h = createHarness(makeContainer([legacy]))
    await h.cmd.execute('debug LegacyAuto')
    const expected = [
        '\u2514\u2500 LegacyAuto',
        '\u2502   \u251c\u2500 status: [FAIL]',
        '\u2502   \u251c\u2500 type: base',
        '\u2502   \u251c\u2500 timer: disabled',
        '\u2502   \u251c\u2500 triggers: --',
        '\u2502   \u251c\u2500 rules: 0',
        '\u2502   \u2514\u2500 config keys: note',
    ].join('\n')
    assertEqual(h.printed[0], expected, 'debug shows FAIL status, base type and config keys fallback')
}

{
    // Unknown or missing names report the problem plus what is actually available
    const h = createHarness(makeContainer([ambient, weatherman]))
    let before = h.printed.length
    await h.cmd.execute('debug NopeAutomation')
    assertEqual(h.printed[before], 'Unknown automation "NopeAutomation"', 'unknown debug target error line')
    assertEqual(h.printed[before + 1], 'Available: AmbientLightsAutomation, TtsWeatherManAutomation', 'error lists available automations')
    before = h.printed.length
    await h.cmd.execute('debug')
    assertEqual(h.printed[before], 'Missing automation name', 'missing debug name hint')
}

// -- Run (manual trigger) ----------------------------------------------------------

console.log('\n\u2500\u2500 Run (manual trigger) \u2500\u2500\n')

const runContainer = makeContainer([ambient, weatherman])
const runHarness = createHarness(runContainer)

await runHarness.cmd.execute('run AmbientLightsAutomation')
assertEqual(runHarness.printed[0], 'Running "AmbientLightsAutomation" (trigger: manual)...', 'run announces target and reason')
assertEqual(runHarness.printed[1], 'Done -- see log window for "Auto:AmbientLightsAutomation" details.', 'run completion hint points to logs')
assertEqual(runContainer.calls.length, 1, 'exactly one dispatch recorded')
assertEqual(runContainer.calls[0].name, 'AmbientLightsAutomation', 'dispatch targets the resolved name')
assertEqual(JSON.stringify(runContainer.calls[0].data), JSON.stringify({ trigger: 'manual' }), 'execute() receives { trigger: "manual" }')
assertEqual(ambient.lastTriggerData.trigger, 'manual', 'instance saw the manual trigger reason')

{
    // Case-insensitive lookup still resolves to the canonical registered name
    await runHarness.cmd.execute('run ttsweathermanautomation')
    assertEqual(runContainer.calls.length, 2, 'lowercase input still dispatches')
    assertEqual(runContainer.calls[1].name, 'TtsWeatherManAutomation', 'canonical name used for dispatch')
}

{
    // Unknown or missing names never reach the engine
    const before = runContainer.calls.length
    let pBefore = runHarness.printed.length
    await runHarness.cmd.execute('run NopeAutomation')
    assertEqual(runContainer.calls.length, before, 'unknown automation is not dispatched')
    assertEqual(runHarness.printed[pBefore], 'Unknown automation "NopeAutomation"', 'unknown run target error line')
    assertEqual(runHarness.printed[pBefore + 1], 'Available: AmbientLightsAutomation, TtsWeatherManAutomation', 'error lists available automations')
    pBefore = runHarness.printed.length
    await runHarness.cmd.execute('run')
    assertEqual(runContainer.calls.length, before, 'missing name does not dispatch')
    assertEqual(runHarness.printed[pBefore], 'Missing automation name', 'missing run name hint')
}

// -- Condition summary formatting ---------------------------------------------------

console.log('\n\u2500\u2500 Condition summary formatting \u2500\u2500\n')

assertEqual(AutomationsCmd.formatConditionSummary(null), '', 'null conditions yield empty summary')
assertEqual(AutomationsCmd.formatConditionSummary(undefined), '', 'undefined conditions yield empty summary')
assertEqual(AutomationsCmd.formatConditionSummary({ illuminance: { gte: 400 } }), 'illuminance>=400', 'gte bound renders as >=')
assertEqual(AutomationsCmd.formatConditionSummary({ temperature: { lt: 5, lte: 9 } }), 'temperature<5 | temperature<=9', 'multiple bounds join with pipe separator')
assertEqual(
    AutomationsCmd.formatConditionSummary({ 'time-of-day': ['morning', 'evening'], season: 'winter' }),
    'time-of-day=[morning|evening] | season=winter',
    'arrays and scalars mix in one summary'
)
assertEqual(AutomationsCmd.formatConditionSummary({ presence: { kyeno: true } }), 'presence={"kyeno":true}', 'non-range objects fall back to JSON')

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)
