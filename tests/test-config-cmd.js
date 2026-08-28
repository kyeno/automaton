/**
 * /config command tests.
 * Behavioral coverage for the /config subcommand dispatcher: GNU-style usage help on bare
 * invocation, full main-config dump via "debug", and live overrides via "set" that go through
 * the same validation as startup -- valid values commit, invalid ones are reported line-by-line
 * without crashing or mutating. Both "debug" and "set" operate on the main config file only.
 * Also covers the ConfigBase validator/crasher split directly (validate() vs ensureValidated(),
 * validateOverride() dry-run semantics).
 *
 * The command runs against the REAL ConfigService (init'd once, like test-config-overrides.js)
 * so name resolution, YAML value typing and schema checks are exercised end-to-end.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6379'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ConfigCmd from '../src/ui/commands/configCmd.js'
import ConfigBase from '../src/service/config/configBase.js'
import ConfigService from '../src/service/configService.js'

let passed = 0
let failed = 0

/**
 * Assert strict equality, recording pass/fail with a human-readable label.
 * @param {*} actual - Actual value
 * @param {*} expected - Expected value
 * @param {string} label - Test label
 */
function assertEqual(actual, expected, label) {
    if (actual === expected) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
        failed++
    }
}

/**
 * Assert a truthy condition, recording pass/fail with a human-readable label.
 * @param {boolean} condition - Assertion outcome
 * @param {string} label - Test label
 */
function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

/**
 * Assert that an async factory rejects and its message contains a needle.
 * @param {Function} promiseFactory - Zero-arg function returning a Promise (or throwing)
 * @param {string} label - Test label
 * @param {string} needle - Substring expected in the rejection message
 */
async function expectReject(promiseFactory, label, needle) {
    try {
        await promiseFactory()
        console.error(`  \u2717 ${label} -- expected rejection but resolved`)
        failed++
    } catch (e) {
        const msg = String(e?.message ?? e)
        if (!needle || msg.includes(needle)) {
            console.log(`  \u2713 ${label}`)
            passed++
        } else {
            console.error(`  \u2717 ${label} -- unexpected message: ${msg}`)
            failed++
        }
    }
}

// -- Real-stack harness ------------------------------------------------------

await ConfigService.init([])

/** Instantiate a ConfigCmd wired to the real service plus a recording print context. */
function createHarness() {
    const printed = []
    const ctx = { print: (text) => printed.push(String(text)), configService: ConfigService }
    return { cmd: new ConfigCmd(ctx), printed }
}

/** Concatenate every captured output chunk for substring assertions. */
const allOutput = (h) => h.printed.join('\n')

console.log('\n\u2500\u2500 Usage help \u2500\u2500\n')

{
    // Bare invocation renders GNU-style usage; main config path named explicitly
    const bare = createHarness()
    await bare.cmd.execute('')
    assertEqual(bare.printed[0].split('\n')[0], 'Usage: /config <subcommand> [args]', 'usage header line')
    assertEqual(bare.printed[0].includes('debug'), true, 'usage lists "debug" subcommand')
    assertEqual(bare.printed[0].includes('set <path>'), true, 'usage shows set with parameter-path syntax')
    assert(!bare.printed[0].includes('<file>'), 'no file token remains in usage text')
    assertEqual(bare.printed[0].includes('Main config: etc/automaton.yaml'), true, 'main config file named explicitly')
    assertEqual(bare.printed[0].includes('Loaded: main'), true, 'loaded section names still listed')
}
{
    const ws = createHarness()
    await ws.cmd.execute('   ')
    assertEqual(ws.printed[0].startsWith('Usage: /config'), true, 'whitespace-only args also show usage')
}
{
    const unknown = createHarness()
    await unknown.cmd.execute('frobnicate x')
    assertEqual(unknown.printed[0], 'Unknown subcommand "frobnicate"', 'unknown subcommand error line')
    assertEqual(unknown.printed[1].startsWith('Usage: /config'), true, 'unknown subcommand shows usage after error')
}

console.log('\n\u2500\u2500 debug: main config dump \u2500\u2500\n')

{
    // Bare "debug" dumps the MAIN config in full -- metadata header + every live value
    const dump = createHarness()
    await dump.cmd.execute('debug')
    const out = allOutput(dump)
    assert(out.includes('validator: yes'), 'metadata reports validator presence for main')
    assert(out.includes('etc/automaton.yaml'), 'metadata shows the resolved main file path')
    assert(out.includes('locale:'), 'dump contains the locale block')
    assert(out.includes('time_format:'), 'nested keys rendered in the dump')
    assert(/"1[24]h"/.test(out), 'scalar values visible as JSON-quoted text')
}
{
    // Stray arguments are rejected with a hint instead of being treated as a section name
    const stray = createHarness()
    await stray.cmd.execute('debug automaton.yaml')
    assertEqual(stray.printed[0], 'Usage: /config debug   -- no arguments needed; dumps the main config in full', 'stray args show argument-less usage')
}

console.log('\n\u2500\u2500 set: validated live overrides \u2500\u2500\n')

const timeFormatBefore = ConfigService.get('locale.time_format')

{
    // Invalid enum value -- reported with startup wording, NOT applied, no crash
    const bad = createHarness()
    await bad.cmd.execute('set locale.time_format 13h')
    const out = allOutput(bad)
    assert(out.includes('expected one of [12h, 24h]'), 'schema violation reported verbatim')
    assert(out.includes('Change NOT applied'), 'explicit not-applied marker printed')
    assertEqual(ConfigService.get('locale.time_format'), timeFormatBefore, 'live data untouched after rejected set')
}
{
    // Wrong type (string where a number is expected)
    const wrongType = createHarness()
    await wrongType.cmd.execute('set ai.max_tokens hot')
    const out = allOutput(wrongType)
    assert(out.includes('Invalid type for "ai.max_tokens"'), 'type mismatch flagged by the dry run')
    assert(!out.includes('Applied ['), 'no confirmation line on failure')
}
{
    // Unknown parameter -- typo guard plus top-level hint
    const unk = createHarness()
    await unk.cmd.execute('set frobnicate.x 5')
    const out = allOutput(unk)
    assert(out.includes('Unknown config parameter "frobnicate.x"'), 'unknown path reported without crashing')
    assert(out.includes('Valid top-level parameters') && out.includes('locale'), 'top-level keys hinted')
}
{
    // Missing value token
    const noVal = createHarness()
    await noVal.cmd.execute('set locale.language')
    assertEqual(noVal.printed[0], 'Missing value for "locale.language"', 'missing value detected before parsing')
    assert(allOutput(noVal).includes('Usage: /config set'), 'usage hint follows the error')
}
{
    // Bare "set" with nothing after it
    const bareSet = createHarness()
    await bareSet.cmd.execute('set')
    assertEqual(bareSet.printed[0], 'Usage: /config set <parameter.path> <value...>', 'bare set shows usage hint')
}
{
    // Valid override -- committed through the startup mutation path on the main config
    const maxTokensBefore = ConfigService.get('ai.max_tokens')
    const ok = createHarness()
    await ok.cmd.execute('set ai.max_tokens 256')
    const out = allOutput(ok)
    assert(out.includes('Applied [main] ai.max_tokens'), 'confirmation names section and parameter')
    const oldShown = maxTokensBefore === undefined ? '(unset)' : JSON.stringify(maxTokensBefore)
    assert(out.includes(oldShown) && out.includes(`-> ${JSON.stringify(256)}`), 'old -> new values shown')
    assert(ConfigService.get('ai.max_tokens') === 256, 'override visible via ConfigService.get()')
    assert(out.includes('(runtime only'), 'persistence caveat printed')
}

console.log('\n\u2500\u2500 ConfigBase validator/crasher split \u2500\u2500\n')

/** Minimal main-config document satisfying src/validators/main.js required keys. */
const goodDocLines = () => [
    'locale:', '  language: en_US', '  time_format: "24h"',
    'ai:', '  model: m', '  max_tokens: 8', '  temperature: 0.3',
    'logger: {}',
    'ui:', '  status_bar:', '    lines: [x]',
    '  windows:', '    - id: logs', '      channel: log', '      title: Logs', '      shortcut: 1',
]

{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-cfg-'))
    const file = path.join(dir, 'good.yaml')
    fs.writeFileSync(file, goodDocLines().join('\n') + '\n')

    // Section name "main" pulls in the real src/validators/main.js schema
    const base = new ConfigBase(file, 'main')
    assertEqual(base.filePath, file, 'filePath getter exposes the loaded path')
    assertEqual(base.sectionName, 'main', 'sectionName getter works')

    const clean = await base.validate()
    assert(Array.isArray(clean) && clean.length === 0, 'validate() returns [] on clean data without throwing')

    // Dry run flags a wrong type and leaves live data untouched
    const dry = await base.validateOverride({ path: 'ai.temperature', value: 'hot' })
    assert(dry.problems.length > 0 && dry.problems[0].includes('Invalid type for "ai.temperature"'), 'dry-run reports the schema violation')
    assertEqual(base.get('ai.temperature'), 0.3, 'live data untouched by failed dry run')

    // A valid dry run commits cleanly through applyOverrides
    const okDry = await base.validateOverride({ path: 'ai.temperature', value: 0.9 })
    assert(okDry.problems.length === 0, 'valid override passes the dry run')
    await base.applyOverrides([{ path: 'ai.temperature', value: 0.9 }])
    assertEqual(base.get('ai.temperature'), 0.9, 'commit applies after a clean dry run')

    // Unknown parameter still gets the typo guard + top-level hint in dry-run form
    const unk = await base.validateOverride({ path: 'frobnicate.x', value: 1 })
    assert(unk.problems.some((p) => p.startsWith('Unknown config parameter')), 'unknown path reported without throwing')
    assert(Array.isArray(unk.validTopLevel) && unk.validTopLevel.includes('locale'), 'top-level hint available to callers')

    fs.rmSync(dir, { recursive: true, force: true })
}
{
    // ensureValidated() keeps its fatal contract for startup (validator/crasher split intact)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-cfg-'))
    const file = path.join(dir, 'bad.yaml')
    const badLines = goodDocLines().map((l) => l.replace('"24h"', '"13h"'))
    fs.writeFileSync(file, badLines.join('\n') + '\n')
    const bad = new ConfigBase(file, 'main')

    const errs = await bad.validate()
    assert(errs.length > 0 && errs.some((e) => e.includes('expected one of [12h, 24h]')), 'validate() collects problems instead of crashing')
    await expectReject(async () => { await bad.ensureValidated() }, 'ensureValidated() still throws for the startup path', 'Config validation failed')

    fs.rmSync(dir, { recursive: true, force: true })
}

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)