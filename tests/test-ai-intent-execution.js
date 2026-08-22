import { config } from 'dotenv'
config()

'use strict'

/**
 * AI malformed tool-call recovery -- end-to-end regression test.
 *
 * Replays the production failure where a small model returned pseudo-calls as text
 * (`set_device_state{action:OPEN,device_name:...}`) and the "catch" machinery malfunctioned:
 *   - unquoted multi-word device names were truncated to their first word -> bogus
 *     "not found" results sent back to the model for devices that actually exist
 *   - failed attempts were invisible in chat (no ai:deviceInteraction event on error paths)
 *   - conversation replay was structurally invalid (orphan role:'tool' message with no matching
 *     assistant tool_calls / tool_call_id pair)
 *
 * Stubs OpenAiProvider.chat with scripted responses, registers offline devices, runs the real
 * processMessage() loop, and pins all three behaviors. No network or MQTT required; if Redis is
 * running, any pre-existing conversation cache entry is saved and restored around the run.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

// Minimal env so provider construction succeeds even outside a fully configured checkout
process.env['AI_API_URL'] = process.env['AI_API_URL'] || 'http://localhost:11434/v1'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import EventBus from '../src/service/eventBus.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import I18nLoader from '../src/service/i18nLoader.js'
import Mechanism from '../src/device/type/mechanism.js'
import Sensor from '../src/device/type/sensor.js'
import OpenAiProvider from '../src/ai/providers/openaiProvider.js'
import AiAssistant from '../src/ai/aiAssistant.js'

const CONVERSATION_KEY = 'ai:conversation:default'

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

console.log('\n── AI malformed tool-call recovery ──\n')

await ConfigService.init()
LoggerService.init()

try { await CacheService.init() } catch { /* Redis optional for this test */ }

await I18nLoader.init()

// Register offline devices -- name resolution is what's under test. No MQTT wiring needed:
// receiveCommand degrades to a logged warning without a broker and the tool result still reports "sent".
function registerDevice(name, DeviceClass) {
    const id = name.toLowerCase().replace(/\s+/g, '_')
    const deviceData = { id, ieee_address: id, friendly_name: name }
    const dev = new (DeviceClass.default || DeviceClass)(name, id, deviceData)
    Object.assign(DeviceContainer.getAll(), { [name]: dev })
}
registerDevice('Salon Roleta Okno Lewe', Mechanism)
registerDevice('Salon Roleta Okno Prawe', Mechanism)
registerDevice('Balkon Temperatura', Sensor)

// Save any pre-existing conversation cache so the run does not clobber live chat state
let savedCache = null
if (CacheService.isConnected()) {
    try {
        const existing = await CacheService.get(CONVERSATION_KEY)
        if (existing !== undefined && existing !== null) savedCache = existing
    } catch { savedCache = null }
}

// Capture UI interaction events (what AiWindow renders as /me lines)
const events = []
const unsubEvents = EventBus.subscribe('ai:deviceInteraction', (payload) => events.push(payload))

// Scripted model responses -- exact pseudo-call strings from the production log
const scripted = []
OpenAiProvider.prototype.chat = async function () { return scripted.shift() }

await AiAssistant.init()
assert(AiAssistant.isAvailable(), 'AI assistant available with stubbed provider (needs AI_API_URL + configured model)')

/**
 * Reset the conversation, script the model's replies, and drive one real processMessage() turn.
 * @param {string} userText - User message to send
 * @param {Array<Object>} modelResponses - Ordered assistant messages the stub returns
 * @returns {Promise<{reply: string, messages: Array<Object>}>} Final reply + non-system history
 */
async function runTurn(userText, modelResponses) {
    AiAssistant.clearConversation()
    events.length = 0
    scripted.length = 0
    for (const r of modelResponses) scripted.push(r)
    const reply = await AiAssistant.processMessage(userText)
    return { reply, messages: AiAssistant.getMessages().filter(m => m.role !== 'system') }
}

try {
    // ── Scenario A: two unquoted multi-word set calls (exact production-log replay) ────────
    {
        const { reply, messages } = await runTurn('Odsłoń rolety w dużym pokoju.', [
            { role: 'assistant', content: 'set_device_state{action:OPEN,device_name:Salon Roleta Okno Lewe}\n' +
                'set_device_state{action:OPEN,device_name:Salon Roleta Okno Prawe}' },
            { role: 'assistant', content: 'Rolety odsłonięte.' }
        ])

        assert(reply === 'Rolety odsłonięte.', 'final prose returned to caller')

        const asstA = messages.find(m => Array.isArray(m.tool_calls))
        assert(!!asstA && asstA.tool_calls.length === 2, 'assistant message carries synthesized tool_calls (x2)')

        const expectedNames = ['Salon Roleta Okno Lewe', 'Salon Roleta Okno Prawe']
        for (let i = 0; i < Math.min(asstA?.tool_calls?.length ?? 0, 2); i++) {
            let args = {}
            try { args = JSON.parse(asstA.tool_calls[i].function.arguments || '{}') } catch {}
            assert(args.device_name === expectedNames[i], `synth call[${i}] keeps the full unquoted name`)
            assert(asstA.tool_calls[i].function.name === 'set_device_state' && args.action === 'OPEN',
                `synth call[${i}] inferred set_device_state/OPEN`)
        }

        const toolsA = messages.filter(m => m.role === 'tool')
        assert(toolsA.length === 2, 'one tool-result message per intent (not one combined blob)')
        for (let i = 0; i < Math.min(toolsA.length, 2); i++) {
            assert(asstA?.tool_calls?.[i]?.id != null && toolsA[i].tool_call_id === asstA.tool_calls[i].id,
                `tool[${i}] references its synthesized call id`)
            let parsed = null
            try { parsed = JSON.parse(toolsA[i].content) } catch {}
            assert(!!parsed && typeof parsed === 'object' && !Array.isArray(parsed),
                `tool[${i}] content is a single valid JSON document`)
            if (parsed) {
                assert(parsed.device === expectedNames[i] && parsed.status === 'sent' && !parsed.error,
                    `tool[${i}] reports success for ${expectedNames[i]} (no bogus "not found")`)
            }
        }

        const evA = events.slice(-2)
        assert(evA.length === 2 && evA.every(e => e.ok !== false), 'both attempts surfaced to chat (no failure flag)')
        assert(evA[0]?.device === expectedNames[0] && evA[1]?.device === expectedNames[1],
            'interaction events carry the full device names')
        assert(evA[0]?.action === 'OPEN' && evA[1]?.action === 'OPEN', 'interaction events carry the requested action')

        // The exact payload shape that goes back to the provider on the next iteration
        const apiMsgs = AiAssistant.stripInternalFields(AiAssistant.getMessages())
        let structuralOk = true
        const declaredIds = new Set()
        for (const m of apiMsgs) {
            if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) declaredIds.add(tc.id)
            }
            if (m.role === 'tool' && !declaredIds.has(m.tool_call_id)) structuralOk = false
        }
        assert(structuralOk, 'API replay is structurally valid: every tool message references a declared call id')
    }

    // ── Scenario B: unknown device -> structured error + visible ok:false event ───────────
    {
        const { reply, messages } = await runTurn('Jaka jest temperatura na podwórku?', [
            { role: 'assistant', content: 'get_device_state{device_name:Podwórko Temperatura}' },
            { role: 'assistant', content: 'Nie znalazłem takiego czujnika.' }
        ])

        assert(reply === 'Nie znalazłem takiego czujnika.', 'final prose returned after failed attempt')

        const asstB = messages.find(m => Array.isArray(m.tool_calls))
        let argsB = {}
        try { argsB = JSON.parse(asstB?.tool_calls?.[0]?.function?.arguments || '{}') } catch {}
        assert(argsB.device_name === 'Podwórko Temperatura', 'no-action intent keeps the full unquoted name')
        assert(asstB?.tool_calls?.[0]?.function?.name === 'get_device_state', 'action-less intent inferred as get_device_state')

        const toolB = messages.filter(m => m.role === 'tool')[0]
        let parsedB = null
        try { parsedB = JSON.parse(toolB?.content) } catch {}
        assert(!!parsedB && typeof parsedB.error === 'string' && /not found/i.test(parsedB.error),
            'error result is structured JSON describing the failure')
        assert(parsedB?.device === 'Podwórko Temperatura', 'error payload names the attempted device (structured field)')

        const evB = events.slice(-1)[0]
        assert(evB?.ok === false, 'failed attempt emits an ok:false interaction event (visible in chat)')
        assert(evB?.device === 'Podwórko Temperatura' && evB?.tool === 'json_intent',
            'failure event carries the requested device and origin label')
    }

    // ── Scenario C: existing sensor resolves from an unquoted multi-word name ─────────────
    {
        const { reply, messages } = await runTurn('Jaka jest temperatura na zewnątrz?', [
            { role: 'assistant', content: 'get_device_state{device_name:Balkon Temperatura}' },
            { role: 'assistant', content: 'Temperatura na balkonie to 18 stopni.' }
        ])

        assert(reply === 'Temperatura na balkonie to 18 stopni.', 'final prose returned after successful read')

        const toolC = messages.filter(m => m.role === 'tool')[0]
        let parsedC = null
        try { parsedC = JSON.parse(toolC?.content) } catch {}
        assert(!!parsedC && !parsedC.error && parsedC.device === 'Balkon Temperatura',
            'read result names the resolved device without error')
        assert(parsedC !== null && parsedC.state !== undefined, 'read result includes a state object for the model')

        const evC = events.slice(-1)[0]
        assert(evC?.ok !== false && evC?.device === 'Balkon Temperatura' && evC?.action === 'STATE',
            'successful read surfaces as a STATE interaction event')
    }
} finally {
    unsubEvents()
    if (CacheService.isConnected()) {
        // Restore whatever was in the conversation cache before this test ran
        try {
            if (savedCache != null) await CacheService.set(CONVERSATION_KEY, savedCache, 900)
            else await CacheService.delete(CONVERSATION_KEY)
        } catch { /* best-effort cleanup */ }
    }
}

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)