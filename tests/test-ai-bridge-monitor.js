import { config } from 'dotenv'
config()

'use strict'

/**
 * Focused tests for AiBridgeMonitor -- the MQTT channel that feeds external prompts into
 * the shared AI conversation (contract: _debug/ai-bridge-mqtt-channel.md).
 *
 * Drives the REAL MqttService dispatcher with an injected fake client (no live broker)
 * and a stubbed AiAssistant prototype (no LLM), then pins down:
 *   A) JSON prompt ({text}) -> user echo frame followed by assistant reply frame on <base>/message
 *   B) plain-string payloads accepted verbatim
 *   C) field aliases .prompt / .message honored
 *   D) empty / whitespace-only prompts produce no frames at all
 *   E) prompts arriving while the AI is unavailable are dropped (no fabricated replies)
 *   F) identical back-to-back prompts both get answered (dedupe opt-out end to end)
 *   G) ai:deviceInteraction events mirror onto <base>/event when forward_events is on
 *   H) stop() tears everything down cleanly
 *   I) the turn is surfaced on the EventBus transcript channels the AI window renders, and
 *      UI-originated turns are mirrored back onto <base>/message without looping
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import MqttService from '../src/service/mqttService.js'
import EventBus from '../src/service/eventBus.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import AiBridgeMonitor from '../src/monitor/aiBridgeMonitor.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

let passCount = 0
let failCount = 0

function assert(condition, message) {
    if (condition) {
        passCount++
        console.log(`  PASS ${message}`)
    } else {
        failCount++
        console.error(`  FAIL ${message}`)
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Minimal stand-in for an mqtt.js MqttClient -- only the surface SMQTTService uses. */
function createFakeMqttClient() {
    const handlers = {}
    const client = {
        connected: true,
        published: [],
        publish(topic, payload, options) { this.published.push({ topic, payload, options }) },
        on(event, handler) { ;(handlers[event] ??= []).push(handler); return this },
        emit(event, ...args) { for (const h of [...(handlers[event] || [])]) h(...args); return this },
        listenerCount() { return 0 },
        setMaxListeners() {},
        removeListener() {},
        subscribe(_topic, cb) { if (typeof cb === 'function') queueMicrotask(() => cb(null)); return this },
        unsubscribe(_topic, cb) { if (typeof cb === 'function') queueMicrotask(() => cb()); return this },
        end(forceOrCb, maybeCb) {
            const cb = typeof forceOrCb === 'function' ? forceOrCb : maybeCb
            if (typeof cb === 'function') queueMicrotask(() => cb())
            return this
        },
        destroy() {}
    }
    // Fire the connect event after the current synchronous stack unwinds.
    setImmediate(() => client.emit('connect'))
    return client
}

/** Simulate an inbound MQTT message reaching the single dispatcher. */
function deliver(fake, topic, payload) {
    fake.emit('message', topic, Buffer.from(payload))
}

/** Frames published to a given topic, parsed as JSON objects. */
function framesFor(fake, topic) {
    return fake.published
        .filter((entry) => entry.topic === topic)
        .map((entry) => JSON.parse(entry.payload))
}

// AiAssistant is a frozen singleton instance -- patch its PROTOTYPE instead.
const assistantProto = Object.getPrototypeOf(AiAssistant)
const originalIsAvailable = assistantProto.isAvailable
const originalProcessMessage = assistantProto.processMessage
let aiAvailableFlag = true
assistantProto.isAvailable = function () { return aiAvailableFlag }
assistantProto.processMessage = async function (text) { return `ECHO: ${text}` }

// Capture the EventBus transcript the AI window renders (src/ui/windows/aiWindow.js subscribes
// to exactly these two channels: <remote>/<you> for the prompt, <AI> for the reply).
const transcript = []
const unsubTranscript = [
    EventBus.subscribe('ai:userMessage', (p) => transcript.push({ channel: 'user', ...p })),
    EventBus.subscribe('ai:assistantMessage', (p) => transcript.push({ channel: 'assistant', ...p }))
]

/** Transcript events recorded since index `from`. */
function transcriptSince(from) {
    return transcript.slice(from)
}

async function main() {
    console.log('=== AiBridgeMonitor Tests (real MqttService dispatcher + stubbed AI) ===\n')

    const fake = createFakeMqttClient()
    await MqttService.init({ connectFn: () => fake })
    await AiBridgeMonitor.init()

    try {
        // A) JSON prompt -> user echo then assistant reply --------------------------
        console.log('-- A) JSON prompt produces ordered transcript frames --')
        const beforeA = transcript.length
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'hello bridge' }))
        await sleep(80)
        let messages = framesFor(fake, 'automaton/ai/message')
        assert(messages.length === 2, `two message frames published (got ${messages.length})`)
        assert(messages[0]?.role === 'user' && messages[0]?.content === 'hello bridge', 'first frame is the user echo')
        assert(messages[1]?.role === 'assistant' && messages[1]?.content === 'ECHO: hello bridge', 'second frame carries the assistant reply')
        assert(typeof messages[0]?.ts === 'number' && typeof messages[1]?.ts === 'number', 'frames carry epoch-ms timestamps')
        assert((messages[1]?.ts ?? 0) >= (messages[0]?.ts ?? 0), 'assistant frame never precedes its user echo')
        assert(messages.every((f) => f.source === 'mqtt'), 'frames carry mqtt provenance')

        const uiA = transcriptSince(beforeA)
        assert(uiA.length === 2, `prompt and reply surfaced on the UI transcript channels (got ${uiA.length})`)
        assert(uiA[0]?.channel === 'user' && uiA[0]?.text === 'hello bridge' && uiA[0]?.source === 'mqtt', 'prompt emitted as ai:userMessage with mqtt provenance')
        assert(uiA[1]?.channel === 'assistant' && uiA[1]?.text === 'ECHO: hello bridge' && uiA[1]?.source === 'mqtt', 'reply emitted as ai:assistantMessage with mqtt provenance')

        // B) plain-string payload ----------------------------------------------------
        console.log('-- B) plain string payloads accepted verbatim --')
        fake.published.length = 0
        deliver(fake, 'automaton/ai/request', 'what time is it?')
        await sleep(80)
        messages = framesFor(fake, 'automaton/ai/message')
        assert(messages.length === 2, `plain-string prompt produced both frames (got ${messages.length})`)
        assert(messages[0]?.content === 'what time is it?' && messages[1]?.content === 'ECHO: what time is it?', 'raw text round-trips unchanged')

        // C) field aliases ------------------------------------------------------------
        console.log('-- C) .prompt and .message aliases honored --')
        for (const [alias, expected] of [['prompt', 'via prompt alias'], ['message', 'via message alias']]) {
            fake.published.length = 0
            deliver(fake, 'automaton/ai/request', JSON.stringify({ [alias]: expected }))
            await sleep(80)
            const got = framesFor(fake, 'automaton/ai/message')
            assert(got[0]?.content === expected && got[1]?.content === `ECHO: ${expected}`, `.\${alias} alias accepted (${JSON.stringify(got.map((f) => f.content))})`)
        }

        // D) empty prompts skipped -----------------------------------------------------
        console.log('-- D) empty / whitespace-only prompts produce nothing --')
        const beforeEmpty = fake.published.length
        const beforeEmptyEvents = transcript.length
        deliver(fake, 'automaton/ai/request', '')
        deliver(fake, 'automaton/ai/request', '{"text":"   "}')
        deliver(fake, 'automaton/ai/request', '[1,2,3]')
        await sleep(80)
        assert(fake.published.length === beforeEmpty, `no frames for empty payloads (published ${fake.published.length - beforeEmpty})`)
        assert(transcript.length === beforeEmptyEvents, 'no UI transcript events for empty payloads')

        // E) AI unavailable -> dropped ---------------------------------------------------
        console.log('-- E) prompt dropped while the AI assistant is unavailable --')
        aiAvailableFlag = false
        const beforeUnavailable = fake.published.length
        const beforeUnavailableEvents = transcript.length
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'anyone there?' }))
        await sleep(80)
        assert(fake.published.length === beforeUnavailable, 'unavailable AI never fabricates a reply frame')
        assert(transcript.length === beforeUnavailableEvents, 'unavailable AI never surfaces a dropped prompt in the UI')
        aiAvailableFlag = true

        // F) identical back-to-back prompts both answered (dedupe opt-out end to end) ---
        console.log('-- F) repeated identical prompts are NOT deduped away --')
        fake.published.length = 0
        const beforeF = transcript.length
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'same prompt' }))
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'same prompt' }))
        await sleep(150)
        messages = framesFor(fake, 'automaton/ai/message')
        assert(messages.filter((f) => f.role === 'user').length === 2, `both user echoes delivered despite identical signature (got ${messages.filter((f) => f.role === 'user').length})`)
        assert(messages.filter((f) => f.role === 'assistant').length === 2, 'both assistant replies published')
        assert(transcriptSince(beforeF).length === 4, 'both turns surfaced in the UI transcript')

        // G) device-interaction events mirrored onto the event topic ---------------------
        console.log('-- G) ai:deviceInteraction mirrors onto <base>/event --')
        fake.published.length = 0
        EventBus.emit('ai:deviceInteraction', { device: 'Salon Light', action: 'OFF', tool: 'native', ok: true })
        await sleep(80)
        const events = framesFor(fake, 'automaton/ai/event')
        assert(events.length === 1, `one event frame published (got ${events.length})`)
        assert(events[0]?.type === 'interaction' && events[0]?.device === 'Salon Light' && events[0]?.action === 'OFF' && events[0]?.ok === true, 'event frame carries interaction payload')
        assert(typeof events[0]?.ts === 'number', 'event frame carries a timestamp')

        // I) UI-originated turns mirror onto the message topic ---------------------------
        console.log('-- I) UI turns mirror onto <base>/message, bridge echoes never loop --')
        fake.published.length = 0
        transcript.length = 0
        EventBus.emit('ai:userMessage', { text: 'typed at the keyboard', source: 'ui' })
        EventBus.emit('ai:assistantMessage', { text: 'typed reply', source: 'ui' })
        await sleep(80)
        messages = framesFor(fake, 'automaton/ai/message')
        assert(messages.length === 2, `both UI frames published (got ${messages.length})`)
        assert(messages[0]?.role === 'user' && messages[0]?.source === 'ui' && messages[0]?.content === 'typed at the keyboard', 'UI prompt published as a user frame')
        assert(messages[1]?.role === 'assistant' && messages[1]?.source === 'ui', 'UI reply published as an assistant frame')

        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'no loop please' }))
        await sleep(80)
        messages = framesFor(fake, 'automaton/ai/message')
        assert(messages.length === 4, `bridge turn adds exactly its own two frames (got ${messages.length})`)
        assert(messages.filter((f) => f.source === 'mqtt').length === 2, 'bridge echoes are never re-published by the UI mirror')
        assert(transcript.filter((e) => e.source === 'ui').length === 2, 'mirror consumes UI events only')

        EventBus.emit('ai:userMessage', { text: '   ', source: 'ui' })
        EventBus.emit('ai:assistantMessage', { text: 'boom', source: 'ui', error: true })
        await sleep(80)
        assert(framesFor(fake, 'automaton/ai/message').length === 4, 'blank and error UI lines are never published')

        // G) inbound prompts are sanitized before they reach the transcript ----------
        console.log('-- G) hostile prompt text is sanitized on the way in --')
        {
            // Emoji, CJK, an ANSI clear-screen sequence, a bidi isolate mark, forged
            // line breaks and Cyrillic: everything outside the language allowlist must
            // be gone, the allowed script must survive, and the result must be one line.
            const hostile = 'turn \u001B[2J on \u{1F600} the \u4F60 lamp\u202E\n\tsilently \u041F\u0440\u0438\u0432\u0435\u0442'
            deliver(fake, 'automaton/ai/request', JSON.stringify({ text: hostile }))
            await sleep(80)

            const sanitized = framesFor(fake, 'automaton/ai/message').at(-2)?.content ?? ''
            assert(sanitized.length > 0, 'sanitized prompt still delivered')
            assert(!sanitized.includes('\u001B'), 'terminal control sequence stripped')
            assert(!sanitized.includes('\u{1F600}'), 'emoji stripped')
            assert(!sanitized.includes('\u4F60'), 'out-of-alphabet script stripped')
            assert(!sanitized.includes('\u202E'), 'bidi isolate mark stripped')
            assert(!sanitized.includes('\n') && !sanitized.includes('\t'), 'forged line breaks collapsed')
            assert(sanitized.includes('\u041F\u0440\u0438\u0432\u0435\u0442'), 'allowed script survives')
            assert(sanitized.startsWith('turn on the lamp'), 'remaining words kept in order')
        }

        // H) stop() tears down -------------------------------------------------------------
        console.log('-- H) stop() silences both directions --')
        AiBridgeMonitor.stop()
        const beforeStop = fake.published.length
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'too late now' }))
        EventBus.emit('ai:deviceInteraction', { device: 'X', action: 'ON', tool: 'native', ok: true })
        EventBus.emit('ai:userMessage', { text: 'typed after stop', source: 'ui' })
        await sleep(80)
        assert(fake.published.length === beforeStop, 'no frames after stop() (inbound, events and UI mirror all silent)')

        // Nested bridge settings govern enablement, custom topics and event forwarding.
        ConfigService.section('main').set('ai.bridge', { enabled: false, topic_base: 'test/nested', forward_events: false })
        await AiBridgeMonitor.init()
        deliver(fake, 'test/nested/request', JSON.stringify({ text: 'disabled nested bridge' }))
        assert(fake.published.length === beforeStop, 'ai.bridge.enabled=false keeps the bridge disabled')
        ConfigService.section('main').set('ai.bridge.enabled', true)
        await AiBridgeMonitor.init()
        deliver(fake, 'test/nested/request', JSON.stringify({ text: 'custom nested topic' }))
        await sleep(80)
        assert(framesFor(fake, 'test/nested/message').length === 2, 'ai.bridge.topic_base routes both transcript frames')
        const nestedCount = fake.published.length
        EventBus.emit('ai:deviceInteraction', { device: 'X', action: 'ON' })
        assert(fake.published.length === nestedCount, 'ai.bridge.forward_events=false suppresses event forwarding')
        AiBridgeMonitor.stop()
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exitCode = 1
    } finally {
        for (const unsub of unsubTranscript) unsub()
        assistantProto.isAvailable = originalIsAvailable
        assistantProto.processMessage = originalProcessMessage
        try { await MqttService.disconnect() } catch { /* best-effort teardown */ }
    }

    console.log(`\nResults: ${passCount} passed, ${failCount} failed`)
    process.exit(failCount > 0 ? 1 : 0)
}

main()
