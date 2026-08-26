/**
 * Tests for ttsWeatherMan AI-pipeline degradation (routeThroughAi()).
 *
 * Pins the Aug-22 failure mode where a timed-out LLM left Window 3 looking dead while
 * raw base instructions were spoken via TTS with no explanation in chat:
 *   A) provider failure -> visible localized <system> notice + raw message spoken
 *      directly (jingle options still forwarded)
 *   B) empty-string reply -> treated as failure, same degraded path (no silent success)
 *   C/D) non-string/null and whitespace-only replies -> same guard
 *   E) healthy reply -> surfaced once via ai:periodicResponse, NO direct-TTS duplicate
 *      (the real AiAssistant already fired 'tts:speak' for that reply itself)
 *
 * Drives the exposed routeThroughAi() seam against a stubbed AiAssistant -- no MQTT,
 * devices, or live LLM needed; only the on-disk config/bundles are touched.
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
import path from 'node:path'
import { resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import EventBus from '../src/service/eventBus.js'
import I18nLoader from '../src/service/i18nLoader.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import TtsWeatherManAutomation from '../etc/automation/ttsWeatherManAutomation.js'

await ConfigService.init()
LoggerService.init()

const ROOT = resolve(import.meta.dirname, '..')

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
// Setup -- real bundle via init(), same approach as the other weatherman tests
// ---------------------------------------------------------------------------
const wm = new TtsWeatherManAutomation()
await wm.init()   // loads #bundle from the active locale + starts a harmless timer (stopped below)

const dir = I18nLoader.getLocale()
const bundle = yamlParse(fs.readFileSync(path.join(ROOT, 'etc/i18n', dir, 'weatherman.yaml'), 'utf8'))
console.log(`\n(using ${dir} weatherman bundle)\n`)

const expectedNotice = bundle.ai_fallback_notice
assert(typeof expectedNotice === 'string' && expectedNotice.trim().length > 0,
    'shipped bundle defines ai_fallback_notice (dist-sync keeps it in templates too)')

// Capture what would reach the UI / TTS server.
const seen = { system: [], periodic: [], tts: [] }
const unsubs = [
    EventBus.subscribe('ai:systemMessage', p => seen.system.push(p)),
    EventBus.subscribe('ai:periodicResponse', p => seen.periodic.push(p)),
    EventBus.subscribe('tts:speak', p => seen.tts.push(p))
]
function resetSeen() {
    seen.system.length = 0
    seen.periodic.length = 0
    seen.tts.length = 0
}

// AiAssistant is a frozen singleton instance -- patch its PROTOTYPE instead.
const assistantProto = Object.getPrototypeOf(AiAssistant)
const originalProcessMessage = assistantProto.processMessage
function stubAi(resultOrError) {
    assistantProto.processMessage = async function () {
        if (resultOrError instanceof Error) throw resultOrError
        return resultOrError
    }
}
function restoreAi() {
    assistantProto.processMessage = originalProcessMessage
}

console.log('\n── routeThroughAi() degradation paths ──\n')

try {
    const RAW = 'RAW REPORT TEXT'
    const JINGLES = { intro: 'a.wav', outro: 'b.wav' }

    // A. provider failure -> notice + raw TTS fallback -------------------------
    console.log('── A. AI failure falls back visibly ──')
    resetSeen()
    stubAi(new Error('Fetch timed out after 500ms'))
    await wm.routeThroughAi('PROMPT X', RAW, JINGLES)
    assert(seen.system.length === 1 && seen.system[0].text === expectedNotice,
        `visible <system> notice posted (${JSON.stringify(seen.system.map(s => s.text))})`)
    assert(seen.tts.length === 1 && seen.tts[0].text === RAW, 'raw report still spoken on the fallback path')
    assert(seen.tts[0]?.intro === 'a.wav' && seen.tts[0]?.outro === 'b.wav', 'jingle options forwarded with the fallback utterance')
    assert(seen.periodic.length === 0, 'no phantom periodic response when AI failed')
    // B. empty-string reply is a failure, not a silent success ------------------
    console.log('── B. empty reply degrades like a failure ──')
    resetSeen()
    stubAi('')
    await wm.routeThroughAi('PROMPT X', RAW, {})
    assert(seen.system.length === 1 && seen.system[0].text === expectedNotice, 'notice posted for empty reply')
    assert(seen.tts.length === 1 && seen.tts[0].text === RAW, 'raw report spoken instead of silence')
    assert(seen.periodic.length === 0, 'empty reply never surfaced as an "AI" line')

    // C/D. non-string and whitespace-only replies hit the same guard ------------
    console.log('── C/D. null + whitespace-only replies guarded ──')
    for (const [label, value] of [['null reply', null], ['whitespace reply', '   ']]) {
        resetSeen()
        stubAi(value)
        await wm.routeThroughAi('PROMPT X', RAW, {})
        assert(seen.system.length === 1 && seen.tts.length === 1 && seen.tts[0].text === RAW,
            `${label} -> notice + raw TTS fallback`)
    }

    // E. healthy reply -- single surface point, no double-speak ------------------
    console.log('── E. success path unchanged (no duplicate speech) ──')
    resetSeen()
    const NICE = 'Piękny raport pogody.'
    stubAi(NICE)
    await wm.routeThroughAi('PROMPT X', RAW, JINGLES)
    assert(seen.periodic.length === 1 && seen.periodic[0].text === NICE, 'rewritten report surfaced once in chat window')
    assert(seen.tts.length === 0, 'routeThroughAi does not re-speak a reply AiAssistant already voiced')
    assert(seen.system.length === 0, 'no failure notice on the happy path')
} finally {
    restoreAi()
    for (const unsub of unsubs) unsub()
    await wm.cleanup()   // stop the timer started by init() so the process can exit
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : '') + `\n${'═'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)