/**
 * Command completion tests.
 * Behavioral coverage for the tab-completion stack: CommandCompleter tokenization and its use of
 * terminal-kit's autoComplete() helper (verb pools, alias handling, case-insensitive matching with
 * original-casing output, common-prefix extension, ambiguity alternatives), each command's
 * completeNextToken() grammar against stub containers, the CommandBase no-op default, and an
 * end-to-end pass through the real auto-discovered registry.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandCompleter from '../src/ui/completion/commandCompleter.js'
import CommandContainer from '../src/ui/commands/container/commandContainer.js'
import CommandBase from '../src/ui/commands/base/commandBase.js'
import AutomationCmd from '../src/ui/commands/automationCmd.js'
import InteractionCmd from '../src/ui/commands/interactionCmd.js'
import DeviceCmd from '../src/ui/commands/deviceCmd.js'
import ConfigCmd from '../src/ui/commands/configCmd.js'
import WinCmd from '../src/ui/commands/winCmd.js'
import channels from '../src/ui/channels.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'

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

function assertArrayEqual(actual, expected, label) {
    const ok = Array.isArray(actual) && actual.length === expected.length
        && actual.every((v, i) => v === expected[i])
    if (ok) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
        failed++
    }
}

// -- Stub fixtures ---------------------------------------------------------------

/** Fake command whose completeNextToken mirrors the automations/interaction grammar. */
const fakeCmd = {
    completeNextToken(tokens) {
        if (!tokens || tokens.length === 0) return ['list', 'debug', 'run']
        const sub = String(tokens[0]).toLowerCase()
        if (sub === 'run' || sub === 'debug') return ['ttsWeatherManAutomation', 'bedroomRollersAutomation']
        return null
    },
}

/** Registry exposing two verbs plus an alias, shaped like CommandContainer's introspection API. */
const fakeRegistry = {
    getAllInfo: () => [
        { name: 'ai', description: '', takesArgs: false, aliases: [] },
        { name: 'automation', description: '', takesArgs: true, aliases: [] },
        { name: 'quit', description: '', takesArgs: false, aliases: ['exit', 'q'] },
    ],
    getCommand: (v) => ({ ai: {}, automation: fakeCmd })[String(v).toLowerCase()] ?? null,
}

const completer = new CommandCompleter(fakeRegistry)

// -- Verb completion ---------------------------------------------------------------

console.log('\n\u2500\u2500 Verb completion \u2500\u2500\n')

{
    const r = completer.complete('/automa', 6)
    assertEqual(r?.text, 'automation', '/automa<Tab> completes the unique verb')
    assertEqual(r?.tokenStart, 1, 'splice start sits after the slash so it is preserved in place')
}

{
    const r = completer.complete('auto', 4)
    assertEqual(r?.text, 'automation', 'bare verb form completes against the same pool')
    assertEqual(r?.tokenStart, 0, 'bare form splices from column zero')
}

{
    const r = completer.complete('/e', 2)
    assertEqual(r?.text, 'exit', 'aliases participate in first-token completion')
}

{
    const r = completer.complete('/a', 2)
    assertArrayEqual(r?.alternatives, ['ai', 'automation'], 'ambiguous prefix reports every match for cycling')
    assertEqual(r?.text, 'ai', 'first alternative offered as immediate visible result')
}

{
    assertEqual(completer.complete('/zzz', 3), null, 'unknown verb yields no completion')
    assertEqual(completer.complete('', 0), null, 'empty line yields no completion')
    assertEqual(completer.complete('   ', 3), null, 'whitespace-only line yields no completion')
}

// -- Argument completion -----------------------------------------------------------

console.log('\n\u2500\u2500 Argument completion \u2500\u2500\n')

{
    const r = completer.complete('/automation ', 12)
    assertArrayEqual(r?.alternatives, ['list', 'debug', 'run'], 'empty next token after verb offers subcommands')
}

{
    const r = completer.complete('/automation run TtsWea', 19)
    assertEqual(r?.text, 'ttsWeatherManAutomation', 'case-insensitive match returns original casing')
    assertEqual(r?.tokenStart, 16, 'splice start lands at the beginning of the typed name')
}

{
    // Two names sharing a longer prefix: first Tab extends to the common part...
    const c2 = new CommandCompleter({
        getAllInfo: () => [{ name: 'x', description: '', takesArgs: true, aliases: [] }],
        getCommand: (v) => v === 'x' ? { completeNextToken() { return ['ttsWeatherMan', 'ttsWeatherForecast'] } } : null,
    })
    const r1 = c2.complete('x ttsWe', 7)
    assertEqual(r1?.text, 'ttsWeather', 'shared extension completes to the longest common part')
    const r2 = c2.complete('x ttsWeather', 12)
    assertArrayEqual(r2?.alternatives, ['ttsWeatherMan', 'ttsWeatherForecast'], 'further ambiguity exposes both full names for cycling')
}

{
    const r = completer.complete('/automation run ttsWeatherManAutomation', 39)
    assertEqual(r, null, 'already-complete token is a no-op instead of re-applying itself')
}

// -- CommandBase default -----------------------------------------------------------

console.log('\n\u2500\u2500 CommandBase default \u2500\u2500\n')

{
    // CommandBase is abstract by construction, so probe its hook through a minimal subclass
    class PlainCmd extends CommandBase { static name = 'plain' }
    assertEqual(new PlainCmd({}).completeNextToken(['anything']), null, 'base hook offers nothing by default so un-overridden commands keep Tab inert')
}

// -- Real command overrides --------------------------------------------------------

console.log('\n\u2500\u2500 Real command overrides \u2500\u2500\n')

{
    // AutomationCmd: subcommands first, then registered automation names after run/debug/force
    const container = { getNames: () => ['bedroomRollersAutomation', 'ttsWeatherManAutomation'] }
    const cmd = new AutomationCmd({ print() {}, automationContainer: container })
    assertArrayEqual(cmd.completeNextToken([]), ['list', 'debug', 'run', 'force'], '/automation<Tab> lists its subcommands')
    assertArrayEqual(cmd.completeNextToken(['run']), ['bedroomRollersAutomation', 'ttsWeatherManAutomation'], '/automation run <TAB> offers automation names from the container hook')
    assertArrayEqual(cmd.completeNextToken(['debug']), ['bedroomRollersAutomation', 'ttsWeatherManAutomation'], '/automation debug <TAB> offers the same name pool')
    assertArrayEqual(cmd.completeNextToken(['force']), ['bedroomRollersAutomation', 'ttsWeatherManAutomation'], '/automation force <TAB> offers the same name pool as run')
    assertEqual(cmd.completeNextToken(['bogus']), null, 'unknown subcommand position offers nothing')
    assertEqual(new AutomationCmd({ print() {} }).completeNextToken(['run']), null, 'missing container degrades to no completion instead of throwing')
}

{
    // InteractionCmd mirrors the automations grammar against its own registry
    const container = { getNames: () => ['kitchenLightsInteraction'] }
    const cmd = new InteractionCmd({ print() {}, interactionContainer: container })
    assertArrayEqual(cmd.completeNextToken([]), ['list', 'debug', 'run'], '/interaction<Tab> lists its subcommands')
    assertArrayEqual(cmd.completeNextToken(['run']), ['kitchenLightsInteraction'], '/interaction run <TAB> offers registered interaction names')
    assertEqual(cmd.completeNextToken(['nope']), null, 'positions without a known grammar offer nothing')
}

{
    // DeviceCmd merges Zigbee and network registries for the debug target slot
    const ctx = {
        print() {},
        deviceContainer: { getNames: ({ includeBridge } = {}) => (includeBridge === false ? ['officeBulb', 'hallSensor'] : ['bridge', 'officeBulb']) },
        networkPresence: { getDeviceNames: () => ['nas', 'printer'] },
    }
    const cmd = new DeviceCmd(ctx)
    assertArrayEqual(cmd.completeNextToken([]), ['list', 'debug'], '/device<Tab> lists its subcommands')
    assertArrayEqual(cmd.completeNextToken(['debug']), ['hallSensor', 'nas', 'officeBulb', 'printer'], '/device debug <TAB> merges both registries sorted, bridge excluded')
    assertEqual(new DeviceCmd({ print() {} }).completeNextToken(['debug']), null, 'missing services degrade to no completion instead of throwing')
}

{
    // ConfigCmd: subcommands first, then section names as path prefixes after set
    const service = { listSections: () => [{ name: 'main' }, { name: 'network' }] }
    const cmd = new ConfigCmd({ print() {}, configService: service })
    assertArrayEqual(cmd.completeNextToken([]), ['debug', 'set', 'reload'], '/config<Tab> lists its subcommands')
    assertArrayEqual(cmd.completeNextToken(['set']), ['main', 'network'], '/config set <TAB> offers loaded section names as path prefixes')
    assertEqual(cmd.completeNextToken(['debug']), null, 'subcommands without further arguments offer nothing more')
    const throwing = new ConfigCmd({ print() {}, configService: { listSections: () => { throw new Error('boom') } } })
    assertEqual(throwing.completeNextToken(['set']), null, 'a failing config service degrades to no completion instead of throwing')
}

{
    // WinCmd: window ids plus numeric shortcuts from the channel registry
    const originalGetAll = channels.getAll
    try {
        channels.getAll = () => [
            { id: 'ai', shortcut: 3 },
            { id: 'device', shortcut: 4 },
        ]
        const cmd = new WinCmd({ print() {} })
        assertArrayEqual(cmd.completeNextToken([]), ['3', '4', 'ai', 'device'], '/win<Tab> offers both ids and shortcut digits sorted')
        assertEqual(cmd.completeNextToken(['x']), null, 'no deeper argument position exists for /win')
    } finally {
        channels.getAll = originalGetAll
    }
}

// -- Real registry integration -----------------------------------------------------

console.log('\n\u2500\u2500 Real registry integration \u2500\u2500\n')

{
    // Drive the default completer (real CommandContainer singleton) through its own verb pool.
    // Bootstrapping env+config+logger follows the sibling suites so load-time diagnostics can log.
    process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
    process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
    process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6379'
    await ConfigService.init()
    LoggerService.init()
    await CommandContainer.init({ print() {} })

    const real = new CommandCompleter()   // defaults to the CommandContainer singleton

    const verbs = real.complete('/automa', 6)
    assertEqual(verbs?.text, 'automation', '/automa<Tab> resolves against the live command registry')

    const q = real.complete('/q', 2)
    assertArrayEqual(q?.alternatives ?? null, ['q', 'quit'], 'alias "q" and verb "quit" both surface as cycleable alternatives')

    const unknown = real.complete('/definitelyNotACommand', 21)
    assertEqual(unknown, null, 'unregistered verbs still yield no completion in the live registry')
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)