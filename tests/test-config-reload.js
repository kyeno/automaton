/**
 * /config reload tests.
 * Behavioral coverage for the manual config-reload path end-to-end against the REAL
 * ConfigService + real etc/ files: successful swap picking up edited values, failed
 * validation leaving everything untouched (two-phase safe swap), .dist template fallback
 * re-evaluation on reload, section add/drop driven by paths.configs, runtime-override
 * ledger reporting, relevance gating of i18n/TTS/AI refreshes (skipped when uninitialized,
 * refreshed with correct state when initialized -- including per-locale tts.yaml / ai.yaml
 * content edits under an UNCHANGED language), window-buffer clearing through ctx, and
 * channel-cache reset so ui.windows changes are picked up without a restart.
 *
 * Also unit-tests ConfigBase.refresh() directly (value pickup, error propagation,
 * active-file promotion over its .dist template).
 *
 * The main YAML is backed up once at start and restored after every mutating case
 * (try/finally) so each scenario starts from pristine disk state.
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

import PROJECT_ROOT from '../src/lib/projectRoot.js'
import ConfigCmd from '../src/ui/commands/configCmd.js'
import ConfigBase from '../src/service/config/configBase.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import I18nLoader from '../src/service/i18nLoader.js'
import TtsService from '../src/service/ttsService.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import channels from '../src/ui/channels.js'

let passed = 0
let failed = 0

/** Assert strict equality, recording pass/fail with a human-readable label. */
function assertEqual(actual, expected, label) {
    if (actual === expected) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
        failed++
    }
}

/** Assert a truthy condition, recording pass/fail with a human-readable label. */
function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

// -- Real-stack harness ------------------------------------------------------

await ConfigService.init([])
// Bootstrap logger so service log calls work in unit-test mode (same pattern as sibling suites)
LoggerService.init()

const MAIN_YAML = path.join(PROJECT_ROOT, 'etc', 'automaton.yaml')
const originalYaml = fs.readFileSync(MAIN_YAML, 'utf8')

/** Write the pristine YAML back to disk and re-swap it into live sections. */
async function restoreConfig() {
    fs.writeFileSync(MAIN_YAML, originalYaml)
    await ConfigService.reload()
}

/** Rewrite only the active "language:" line; commented-out variants are left untouched. */
function withLanguage(yamlText, lang) {
    return yamlText.split('\n').map((line) => (/^\s*language:\s/.test(line) ? `  language: ${lang}` : line)).join('\n')
}

// The suite must work whichever locale automaton.yaml currently configures -- both bundles
// ship under etc/i18n/ and the switch cases pick their target dynamically from here.
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')
const i18nDirs = fs.readdirSync(I18N_ROOT).filter((d) => fs.statSync(path.join(I18N_ROOT, d)).isDirectory())
assert(i18nDirs.length >= 2, 'at least two i18n bundles available for switch testing')

/** Instantiate a ConfigCmd wired to the real service plus a recording print context. */
function createHarness(extraCtx = {}) {
    const printed = []
    const ctx = { print: (text) => printed.push(String(text)), configService: ConfigService, ...extraCtx }
    return { cmd: new ConfigCmd(ctx), printed }
}

/** Concatenate every captured output chunk for substring assertions. */
const allOutput = (h) => h.printed.join('\n')

console.log('\n\u2500\u2500 ConfigBase.refresh() unit behavior \u2500\u2500\n')

{
    // refresh() picks up edited values; parse errors propagate instead of half-swapping
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-reload-'))
    const file = path.join(dir, 'scratch.yaml')
    fs.writeFileSync(file, 'a:\n  b: 1\n')

    const base = new ConfigBase(file, 'scratch')   // no validator registered for this name
    assertEqual(base.get('a.b'), 1, 'initial value loaded at construction')

    fs.writeFileSync(file, 'a:\n  b: 2\n')
    base.refresh()
    assertEqual(base.get('a.b'), 2, 'refresh() re-reads the file and swaps data in place')

    fs.writeFileSync(file, 'a: *nope\n')   // unresolved alias -- guaranteed parse error for this YAML lib
    let threw = false
    try { base.refresh() } catch { threw = true }
    assert(threw, 'refresh() throws on a broken file so callers can abort before swapping')

    // .dist fallback re-evaluates every call: an active file promoted over its template wins again
    fs.rmSync(file)
    fs.writeFileSync(file + '.dist', 'k: distval\n')
    const templated = new ConfigBase(file, 'templated')
    assertEqual(templated.get('k'), 'distval', 'missing active file falls back to the .dist template')

    fs.writeFileSync(file, 'k: liveval\n')
    templated.refresh()
    assertEqual(templated.get('k'), 'liveval', 'hand-written active file is picked up by refresh() without restart')

    fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n\u2500\u2500 reload: report shape & usage help \u2500\u2500\n')

{
    // No-op reload against pristine config: clean report, nothing changed, ledger empty
    const r0 = await ConfigService.reload()
    assert(r0.ok === true, 'pristine reload reports ok')
    assert(Array.isArray(r0.reloaded) && r0.reloaded.includes('main'), 'report lists main as reloaded in place')
    assertEqual(r0.changed.length, 0, 'no relevance subtrees differ on a no-op reload')
    assertEqual(ConfigService.sessionOverrides().length, 0, 'override ledger starts empty')
}
{
    const bare = createHarness()
    await bare.cmd.execute('')
    assert(bare.printed[0].includes('reload'), 'usage help lists the "reload" subcommand')
}

console.log('\n\u2500\u2500 reload: successful swap + negative gates \u2500\u2500\n')

{
    // Edit ai.max_tokens on disk; reload must pick it up. Subsystems are NOT initialized yet
    // in this process, so none of them may be touched even though ai.* changed.
    const before = ConfigService.get('ai.max_tokens')
    const afterVal = (Number.isFinite(before) ? before : 1) + 7
    fs.writeFileSync(MAIN_YAML, originalYaml.replace(/max_tokens:\s*-?\d+/, `max_tokens: ${afterVal}`))

    try {
        const h = createHarness()
        await h.cmd.execute('reload')
        const out = allOutput(h)
        assert(out.includes('Config reloaded -- sections:') && out.includes('main'), 'success header names the reloaded section')
        assertEqual(ConfigService.get('ai.max_tokens'), afterVal, 'edited value is live after reload')
        assert(!out.includes('i18n'), 'uninitialized i18n not mentioned/touched for an ai.* change')
        assert(!out.includes('TTS now'), 'uninitialized TTS not refreshed for an ai.* change')
        assert(!out.includes('AI conversation'), 'uninitialized AI assistant not reset for an ai.* change')
    } finally {
        await restoreConfig()
    }
}
{
    // Failed validation: problems reported verbatim, live config byte-for-byte unchanged
    const snapBefore = { lang: ConfigService.get('locale.language'), mt: ConfigService.get('ai.max_tokens') }
    fs.writeFileSync(MAIN_YAML, originalYaml.replace(/time_format:\s*"12h"/, 'time_format: "13h"'))

    try {
        const h = createHarness()
        await h.cmd.execute('reload')
        const out = allOutput(h)
        assert(out.includes('FAILED'), 'failure banner printed')
        assert(out.includes('expected one of [12h, 24h]'), 'schema violation reported verbatim from the candidate')
        assertEqual(ConfigService.get('locale.language'), snapBefore.lang, 'live locale untouched after failed reload')
        assertEqual(ConfigService.get('ai.max_tokens'), snapBefore.mt, 'live ai block untouched after failed reload')
    } finally {
        await restoreConfig()
    }
}

console.log('\n\u2500\u2500 reload: .dist promotion & section add/drop \u2500\u2500\n')

{
    // Active file missing -> reload must fall back to automaton.yaml.dist and still succeed
    const backup = MAIN_YAML + '.test-bak'
    fs.renameSync(MAIN_YAML, backup)
    try {
        const h = createHarness()
        await h.cmd.execute('reload')
        const out = allOutput(h)
        assert(out.includes('Config reloaded -- sections:') && !out.includes('FAILED'), 'reload succeeds off the .dist template when active file is absent')
        assert(Boolean(ConfigService.section('main')), 'main section present in live set')
    } finally {
        if (fs.existsSync(backup)) fs.renameSync(backup, MAIN_YAML)
        await restoreConfig()
    }
}
{
    // paths.configs drives discovery on every reload: new entries added, removed ones dropped
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-reload-'))
    const t1 = path.join(dir, 'extraone.yaml')
    const t2 = path.join(dir, 'extratwo.yaml')
    fs.writeFileSync(t1, 'alpha: 1\n')
    fs.writeFileSync(t2, 'beta:\n  - 1\n')

    const withPaths = originalYaml + `\npaths:\n  configs:\n    extraone: "${t1}"\n    extratwo: "${t2}"\n`
    fs.writeFileSync(MAIN_YAML, withPaths)

    try {
        const h = createHarness()
        await h.cmd.execute('reload')
        const out = allOutput(h)
        assert(out.includes('+ added sections:') && out.includes('extraone') && out.includes('extratwo'), 'newly declared sections reported as added')
        assert(out.includes('- dropped section: network'), 'section no longer in paths.configs reported as dropped')
        assert(Boolean(ConfigService.section('extraone')), 'added section resolvable through the service')
        assertEqual(ConfigService.resolveSection('network'), null, 'dropped section gone from live set')
        assertEqual(ConfigService.section('extraone').get('alpha'), 1, 'added section data readable end-to-end')
    } finally {
        await restoreConfig()
        fs.rmSync(dir, { recursive: true, force: true })
    }
}
assert(Boolean(ConfigService.section('network')), 'discovered sections restored after final reload')

console.log('\n\u2500\u2500 reload: runtime overrides are discarded & reported \u2500\u2500\n')

{
    // /config set commits a live override; a later reload must report it as discarded
    const hSet = createHarness()
    await hSet.cmd.execute('set ai.temperature 0.42')
    assert(allOutput(hSet).includes('Applied [main] ai.temperature'), 'override committed via /config set')
    assert(ConfigService.sessionOverrides().includes('main.ai.temperature'), 'commit recorded in the session-override ledger')

    fs.writeFileSync(MAIN_YAML, originalYaml.replace(/temperature:\s*[\d.]+/, 'temperature: 0.77'))
    try {
        const h = createHarness()
        await h.cmd.execute('reload')
        const out = allOutput(h)
        assert(out.includes('runtime overrides discarded'), 'discarded-overrides line printed')
        assert(out.includes('ai.temperature'), 'the exact overridden parameter is named')
        assertEqual(ConfigService.get('ai.temperature'), 0.77, 'file value wins over the memory-only override')
        assertEqual(ConfigService.sessionOverrides().length, 0, 'ledger cleared after successful swap')
    } finally {
        await restoreConfig()
    }
}

console.log('\n\u2500\u2500 reload: locale switch with uninitialized subsystems (skip gates) \u2500\u2500\n')

{
    // None of i18n/TTS/AI have been init'd yet in this process -- a locale change must be
    // reported as skipped rather than crashing on half-built services. The switch direction
    // is derived from whatever locale is currently configured so the case stays valid either way.
    const rNotInit = await AiAssistant.resetConversation()
    assertEqual(rNotInit.reset, false, 'resetConversation() before init() is a safe no-op')

    const fromLang = String(ConfigService.get('locale.language'))
    const toLang = i18nDirs.find((d) => d !== fromLang) ?? null
    assert(toLang != null, 'a second i18n bundle exists for the skip-gate switch test')

    fs.writeFileSync(MAIN_YAML, withLanguage(originalYaml, toLang))
    try {
        const h = createHarness()
        await h.cmd.execute('reload')
        const out = allOutput(h)
        assert(out.includes('i18n skipped (not initialized yet)'), 'uninitialized i18n explicitly skipped')
        assert(out.includes('TTS skipped'), 'uninitialized TTS explicitly skipped')
        assert(!out.includes('AI conversation cleared'), 'uninitialized AI assistant left alone')
        assertEqual(ConfigService.get('locale.language'), toLang, 'config swap itself still applied')
    } finally {
        await restoreConfig()
    }
}

console.log('\n\u2500\u2500 reload: full subsystem refresh after initialization \u2500\u2500\n')

{
    // Initialize every dependent service against the pristine config, then switch locale AND
    // add a window definition in one edit -- everything affected must refresh coherently.
    process.env['TTS_API_URL'] = 'http://tts.test/v1'   // read at init()/refresh time, not import time

    // Both bundles must ship for this scenario; pin a known start (pl_PL) so the switch to
    // en_US below is deterministic whichever language automaton.yaml currently configures.
    assert(i18nDirs.includes('pl_PL') && i18nDirs.includes('en_US'), 'pl_PL + en_US bundles available for refresh testing')
    fs.writeFileSync(MAIN_YAML, withLanguage(originalYaml, 'pl_PL'))
    await ConfigService.reload()

    await I18nLoader.init()
    assertEqual(I18nLoader.getLocale(), 'pl_PL', 'i18n starts on the configured pl_PL bundle')
    assert(I18nLoader.isReady === true, 'isReady gate flips after init()')

    const rPreInit = await AiAssistant.resetConversation()
    assertEqual(rPreInit.reset, false, 'reset before AiAssistant.init() stays a no-op')
    await TtsService.init()
    assert(TtsService.isEnabled() === true, 'TTS enabled with template from the pl_PL directory')
    await AiAssistant.init()
    assert(AiAssistant.isReady() === true, 'AI assistant ready (provider may be null without API URL)')
    assertEqual(AiAssistant.getMessageCount(), 0, 'no conversational turns before the reload')
    assert(AiAssistant.getMessages()[0]?.role === 'system', 'context starts with the system prompt')

    const windowsBefore = channels.getAll().length
    assert(channels.isLoaded === true, 'channel cache primed for the reset assertion')

    const mutated = withLanguage(withLanguage(originalYaml, 'pl_PL'), 'en_US').replace(
        /(shortcut: 4\s*\n\s*readonly: false)/,
        '$1\n    - id: scratchwin\n      channel: "#scratch"\n      title: "Scratch"\n      shortcut: 9\n      readonly: false'
    )
    fs.writeFileSync(MAIN_YAML, mutated)

    try {
        const clearedCalls = []
        const h = createHarness({
            clearWindows: (ids) => { clearedCalls.push([...ids]); return ids.filter((id) => ['ai', 'tts'].includes(id)) },
        })
        await h.cmd.execute('reload')
        const out = allOutput(h)

        assert(out.includes('i18n switched to locale=en_US'), 'i18n bundle reloaded onto en_US')
        assertEqual(I18nLoader.getLocale(), 'en_US', 'getLocale() reflects the live switch')
        assertEqual(I18nLoader.getTimeFormat(), '12h', 'unchanged time_format preserved through the swap')

        // Data-driven expectation: read whichever voice the en_US bundle currently ships so the
        // suite survives voice swaps (and trailing comments) in etc/i18n/en_US/tts.yaml without
        // test churn. The value is the first non-quote/space/hash token after "model:".
        const enModel = String(/^model:\s*"?([^"\s#]+)"?/m.exec(
            fs.readFileSync(path.join(I18N_ROOT, 'en_US', 'tts.yaml'), 'utf8'))?.[1] ?? '')
        assert(Boolean(enModel), 'en_US tts.yaml exposes an active model for the switch assertion')
        assert(out.includes(`TTS now enabled, model=${enModel}`), 'TTS template followed the new locale directory')
        assert(TtsService.isEnabled() === true, 'TTS stays enabled after refreshConfig()')

        assert(out.includes('AI conversation cleared ('), 'AI conversation reset reported with message count')
        assertEqual(AiAssistant.getMessageCount(), 0, 'conversation back to zero user/assistant turns after reset')

        assert(clearedCalls.length === 1 && JSON.stringify(clearedCalls[0]) === JSON.stringify(['ai', 'tts']),
            'ctx.clearWindows invoked exactly once for ai+tts windows')
        assert(out.includes('windows cleared: ai, tts'), 'cleared window ids surfaced in output')

        assert(channels.getAll().length === windowsBefore + 1, 'channel cache re-read picked up the new window definition')
        assert(Boolean(channels.getById('scratchwin')), 'newly defined window resolvable via the channel manager')
    } finally {
        await restoreConfig()
    }
}

console.log('\n\u2500\u2500 reload: per-locale i18n file edits take effect without a language change \u2500\u2500\n')

{
    // Services are all initialized by this point (previous block). Each sub-case mutates shared
    // singletons, so every one starts and ends with caches reconciled against disk state --
    // otherwise a later case would legitimately detect the previous case's leftover drift.
    /** Re-sync i18n/TTS/AI caches against live config + on-disk bundles; no-op before init(). */
    async function reconcileAll() {
        if (I18nLoader.isReady) await I18nLoader.reload()
        if (TtsService.isReady()) await TtsService.refreshConfig()
        if (AiAssistant.isReady()) await AiAssistant.resetConversation()
    }
    await reconcileAll()

    const dir = I18nLoader.getLocale()
    assertEqual(I18nLoader.resolveLocaleDir(String(ConfigService.get('locale.language'))), dir,
        'config-resolved directory matches the cached active locale')

    // -- tts.yaml model edit under an UNCHANGED locale must refresh the live template --
    {
        const ttsPath  = path.join(I18N_ROOT, dir, 'tts.yaml')
        const original = fs.readFileSync(ttsPath, 'utf8')
        try {
            fs.writeFileSync(ttsPath, original.replace(/^model:\s*.*/m, 'model: "test-model-reload-sentinel"'))
            const h = createHarness()
            await h.cmd.execute('reload')
            const out = allOutput(h)
            assert(out.includes('TTS now enabled, model=test-model-reload-sentinel'),
                'edited tts.yaml model picked up by /config reload without a language change')
            assert(TtsService.isEnabled() === true, 'TTS stays enabled after in-place template swap')
            assert(!out.includes('AI conversation cleared'), 'a pure tts.yaml edit does not reset the AI conversation')
        } finally {
            fs.writeFileSync(ttsPath, original)
            await restoreConfig()
            await reconcileAll()
        }
    }

    // -- ai.yaml bundle edit under an UNCHANGED locale must re-prompt + reset the conversation --
    {
        const aiPath   = path.join(I18N_ROOT, dir, 'ai.yaml')
        const original = fs.readFileSync(aiPath, 'utf8')
        try {
            fs.writeFileSync(aiPath, original.replace(/devices_header:\s*"[^"]*"/, 'devices_header: "RELOAD-SENTINEL HEADER"'))
            const h = createHarness()
            await h.cmd.execute('reload')
            const out = allOutput(h)
            assert(out.includes('i18n bundle reloaded from disk'), 'bundle-only movement reported distinctly from a locale switch')
            assert(out.includes('AI conversation cleared ('), 'edited ai.yaml triggers the AI conversation reset without a language change')
            assert(AiAssistant.getMessages()[0]?.content?.includes('RELOAD-SENTINEL HEADER') === true,
                'fresh system prompt reflects the edited bundle header')
            assert(!out.includes('TTS now'), 'a pure ai.yaml edit does not touch the TTS template')
        } finally {
            fs.writeFileSync(aiPath, original)
            await restoreConfig()
            await reconcileAll()
        }
    }

    // -- no-op reload with everything initialized stays silent about subsystems --
    {
        const h = createHarness()
        await h.cmd.execute('reload')
        const out = allOutput(h)
        assert(out.includes('no i18n/TTS/AI-relevant settings changed'), 'pristine reload reports nothing relevant moved')
        assert(!out.includes('TTS now') && !out.includes('AI conversation cleared'),
            'initialized subsystems untouched by a no-op reload')
    }
}

assert(fs.readFileSync(MAIN_YAML, 'utf8') === originalYaml, 'etc/automaton.yaml restored byte-for-byte at end of suite')

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)