import { config } from 'dotenv'
config()

'use strict'

/**
 * Tests for the WeatherMan use_ai config flag (routeReport() pipeline decision).
 *
 * Pins down:
 *   A) use_ai omitted (default ON) + AI available -> routes through AI
 *   B) use_ai: false + AI available -> speaks directly, skips LLM entirely
 *   C) use_ai omitted + AI unavailable -> degrades to direct TTS (existing behavior)
 *   D) use_ai: true explicit + AI available -> routes through AI (same as default)
 *
 * Drives the exposed routeReport() seam against a stubbed AiAssistant -- no MQTT,
 * devices, or live LLM needed.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'

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
    if (condition) { console.log(`  PASS ${label}`); passed++ }
    else { console.error(`  FAIL ${label}`); failed++ }
}

// Setup -- real bundle via init()
const wm = new TtsWeatherManAutomation()
await wm.init()
wm.config = { ...wm.config, add_proverb: false }

// Stub AiAssistant on its prototype.
const assistantProto = Object.getPrototypeOf(AiAssistant)
const originalIsAvailable = assistantProto.isAvailable
const originalProcessMessage = assistantProto.processMessage
let aiAvailableFlag = true
assistantProto.isAvailable = function () { return aiAvailableFlag }
assistantProto.processMessage = async function (text) { return 'AI REWRITTEN: ' + text.slice(0, 40) }

// Capture events.
const seen = { system: [], periodic: [], tts: [] }
const unsubs = [
    EventBus.subscribe('ai:systemMessage', p => seen.system.push(p)),
    EventBus.subscribe('ai:periodicResponse', p => seen.periodic.push(p)),
    EventBus.subscribe('tts:speak', p => seen.tts.push(p))
]
function resetSeen() { seen.system.length = 0; seen.periodic.length = 0; seen.tts.length = 0 }

async function main() {
    console.log('=== WeatherMan use_ai flag Tests ===\n')

    try {
        // A) default (use_ai omitted) + AI available -> routes through AI ---------------
        console.log('-- A) default ON + AI available -> AI pipeline --')
        delete wm.config.use_ai   // simulate key absent from yaml
        aiAvailableFlag = true
        resetSeen()
        await wm.routeReport('It is warm outside.', {}, {})
        assert(seen.periodic.length === 1, `routed through AI (got ${seen.periodic.length} periodic responses)`)
        assert(seen.tts.length === 0, 'no direct TTS on the AI path')
        assert(seen.system.length === 1 && seen.system[0].text.includes('warm'), 'system message shows the full prompt')

        // B) use_ai: false + AI available -> speaks directly ------------------------------
        console.log('-- B) use_ai:false forces direct TTS even with healthy AI --')
        wm.config = { ...wm.config, use_ai: false }
        aiAvailableFlag = true
        resetSeen()
        await wm.routeReport('It is cold inside.', {}, {})
        assert(seen.periodic.length === 0, 'AI was NOT called when use_ai=false')
        assert(seen.tts.length === 1, `direct TTS fired (got ${seen.tts.length})`)
        assert(typeof seen.tts[0]?.text === 'string' && seen.tts[0].text.includes('cold'), 'spoken text contains the core report')

        // C) default ON + AI unavailable -> degrades to direct TTS -------------------------
        console.log('-- C) default ON + AI down -> graceful degradation --')
        delete wm.config.use_ai
        aiAvailableFlag = false
        resetSeen()
        await wm.routeReport('Wind picking up.', {}, {})
        assert(seen.periodic.length === 0, 'no AI response when assistant is down')
        assert(seen.tts.length >= 1, `degraded to direct TTS (got ${seen.tts.length} tts events)`)

        // D) explicit use_ai: true + AI available -> same as default -----------------------
        console.log('-- D) explicit use_ai:true behaves identically to default --')
        wm.config = { ...wm.config, use_ai: true }
        aiAvailableFlag = true
        resetSeen()
        await wm.routeReport('Rain expected tonight.', {}, {})
        assert(seen.periodic.length === 1, 'explicit true routes through AI')
        assert(seen.tts.length === 0, 'no direct TTS duplicate')
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exitCode = 1
    } finally {
        for (const unsub of unsubs) unsub()
        assistantProto.isAvailable = originalIsAvailable
        assistantProto.processMessage = originalProcessMessage
        try { wm.stop() } catch { /* best-effort */ }
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
}

main()
