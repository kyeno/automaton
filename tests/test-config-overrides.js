/**
 * Config override (--config-override / -c) tests.
 *
 * Covers the raw-value parser, strict application semantics on the main config
 * (unknown parameters rejected, typed values applied), nginx-style fatal schema
 * validation, and end-to-end CLI behavior including the friendly CRITICAL ERROR
 * exit path used when startup fails before any service is up (code review D9).
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

import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import ConfigService from '../src/service/configService.js'

const ROOT = resolve(import.meta.dirname, '..')

let passed = 0
let failed = 0

/**
 * Record a pass/fail assertion result.
 * @param {boolean} condition - Assertion outcome
 * @param {string} label - Human-readable test label
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

console.log('\n\u2500\u2500 parseConfigOverride unit tests \u2500\u2500\n')

{
    const r = ConfigService.parseConfigOverride('locale.language: en_US')
    assert(r.path === 'locale.language' && r.value === 'en_US', 'simple string pair parsed')
}
{
    const r = ConfigService.parseConfigOverride('ai.temperature: 0.7')
    assert(typeof r.value === 'number' && r.value === 0.7, 'numeric value keeps its number type')
}
{
    const r = ConfigService.parseConfigOverride('ai.strip_ai_formatting: true')
    assert(r.value === true, 'boolean value typed correctly')
}
{
    const r = ConfigService.parseConfigOverride('automation.human_interaction_cooldown_ms: "90s"')
    assert(r.value === '90s', 'quoted duration stays a string')
}
{
    const r = ConfigService.parseConfigOverride('paths.configs: { network: etc/device/network.yaml }')
    assert(r.value !== null && typeof r.value === 'object' && r.value.network === 'etc/device/network.yaml', 'inline object accepted for subtree overrides')
}
await expectReject(() => ConfigService.parseConfigOverride(''), 'empty value rejected', 'expected format')
await expectReject(() => ConfigService.parseConfigOverride('no-colon-here'), 'bare string without colon rejected', 'single "key.path: value"')
await expectReject(() => ConfigService.parseConfigOverride('a: 1\nb: 2'), 'multiple keys in one flag rejected', 'repeat the -c/--config-override flag')
await expectReject(() => ConfigService.parseConfigOverride('.leading.dot: x'), 'empty dot segment rejected', 'segments between dots must not be empty')
await expectReject(() => ConfigService.parseConfigOverride('locale.language:'), 'trailing colon (empty value) rejected explicitly', 'has an empty value')

console.log('\n\u2500\u2500 Strict application on main config \u2500\u2500\n')

await ConfigService.init(['locale.language: en_US', 'ai.temperature: 0.7'])
assert(ConfigService.get('locale.language') === 'en_US', 'string override applied to main section')
const temp = ConfigService.get('ai.temperature')
assert(temp === 0.7 && typeof temp === 'number', 'numeric override applied with type preserved')

await expectReject(() => ConfigService.init(['locale.langauge: xx']), 'unknown parameter rejected (typo guard)', 'Unknown config parameter')
await expectReject(() => ConfigService.init(['totally.unknown.param: x']), 'top-level unknown param lists valid top-level keys', 'Valid top-level parameters')
await expectReject(() => ConfigService.init(['locale.time_format: 13h']), 'bad enum value aborts startup (strict validation)', 'expected one of [12h, 24h]')
await expectReject(() => ConfigService.init(['a: 1\nb: 2', 'c: 3\nd: 4']), 'all malformed flags reported together', 'Invalid --config-override value(s)')
assert(ConfigService.get('locale.language') === 'en_US', 'failed init attempts leave previous good state intact')

console.log('\n\u2500\u2500 End-to-end CLI behavior \u2500\u2500\n')

/**
 * Run the real CLI in a child process and capture exit code + combined output.
 * @param {string[]} args - Arguments after node src/main.js
 * @param {Record<string, string>} [extraEnv] - Extra env vars to set
 * @param {string[]} [dropVars] - Env vars removed from the inherited environment
 * @returns {{ code: number, out: string }} Exit status plus stdout+stderr text
 */
function runCli(args, extraEnv = {}, dropVars = []) {
    const env = { ...process.env }
    for (const k of dropVars) delete env[k]
    Object.assign(env, extraEnv)
    const res = spawnSync(process.execPath, ['src/main.js', ...args], { cwd: ROOT, env, encoding: 'utf8' })
    return { code: res.status ?? -1, out: String(res.stdout || '') + String(res.stderr || '') }
}

{
    const r = runCli(['--no-ui', '-c', 'locale.time_format: 13h'])
    assert(r.code !== 0 && /CRITICAL ERROR/.test(r.out), `invalid enum value exits non-zero via CRITICAL ERROR path (code=${r.code})`)
    assert(/time_format/.test(r.out), 'error output names the offending parameter')
}
{
    // Regression guard for wrapper word-splitting ("key:" arriving as a bare token):
    // it must fail with an explicit empty-value message, not a confusing type error.
    const r = runCli(['--no-ui', '-c', 'locale.language:'])
    assert(r.code !== 0 && /empty value/.test(r.out), 'bare "key:" override reports explicit empty-value error')
    assert(!/got object/.test(r.out), '...and never surfaces as the misleading "got object" type error')
}
{
    const r = runCli(['--no-ui', '--config-override', 'totally.unknown.param: x'])
    assert(r.code !== 0 && /Unknown config parameter/.test(r.out), 'unknown parameter aborts startup before any service starts')
}
{
    // D9 regression: pre-service init failures must use the friendly error path too.
    const r = runCli(['--no-ui'], {}, ['REDIS_URL'])
    assert(r.code !== 0 && /REDIS_URL/.test(r.out) && /CRITICAL ERROR/.test(r.out), 'missing required env var dies via CRITICAL ERROR path (D9 fixed)')
}

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)
