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

async function main() {
    console.log('=== AiBridgeMonitor Tests (real MqttService dispatcher + stubbed AI) ===\n')

    const fake = createFakeMqttClient()
    await MqttService.init({ connectFn: () => fake })
    await AiBridgeMonitor.init()

    try {
        // A) JSON prompt -> user echo then assistant reply --------------------------
        console.log('-- A) JSON prompt produces ordered transcript frames --')
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'hello bridge' }))
        await sleep(80)
        let messages = framesFor(fake, 'automaton/ai/message')
        assert(messages.length === 2, `two message frames published (got ${messages.length})`)
        assert(messages[0]?.role === 'user' && messages[0]?.content === 'hello bridge', 'first frame is the user echo')
        assert(messages[1]?.role === 'assistant' && messages[1]?.content === 'ECHO: hello bridge', 'second frame carries the assistant reply')
        assert(typeof messages[0]?.ts === 'number' && typeof messages[1]?.ts === 'number', 'frames carry epoch-ms timestamps')
        assert((messages[1]?.ts ?? 0) >= (messages[0]?.ts ?? 0), 'assistant frame never precedes its user echo')

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
        deliver(fake, 'automaton/ai/request', '')
        deliver(fake, 'automaton/ai/request', '{"text":"   "}')
        deliver(fake, 'automaton/ai/request', '[1,2,3]')
        await sleep(80)
        assert(fake.published.length === beforeEmpty, `no frames for empty payloads (published ${fake.published.length - beforeEmpty})`)

        // E) AI unavailable -> dropped ---------------------------------------------------
        console.log('-- E) prompt dropped while the AI assistant is unavailable --')
        aiAvailableFlag = false
        const beforeUnavailable = fake.published.length
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'anyone there?' }))
        await sleep(80)
        assert(fake.published.length === beforeUnavailable, 'unavailable AI never fabricates a reply frame')
        aiAvailableFlag = true

        // F) identical back-to-back prompts both answered (dedupe opt-out end to end) ---
        console.log('-- F) repeated identical prompts are NOT deduped away --')
        fake.published.length = 0
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'same prompt' }))
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'same prompt' }))
        await sleep(150)
        messages = framesFor(fake, 'automaton/ai/message')
        assert(messages.filter((f) => f.role === 'user').length === 2, `both user echoes delivered despite identical signature (got ${messages.filter((f) => f.role === 'user').length})`)
        assert(messages.filter((f) => f.role === 'assistant').length === 2, 'both assistant replies published')

        // G) device-interaction events mirrored onto the event topic ---------------------
        console.log('-- G) ai:deviceInteraction mirrors onto <base>/event --')
        fake.published.length = 0
        EventBus.emit('ai:deviceInteraction', { device: 'Salon Light', action: 'OFF', tool: 'native', ok: true })
        await sleep(80)
        const events = framesFor(fake, 'automaton/ai/event')
        assert(events.length === 1, `one event frame published (got ${events.length})`)
        assert(events[0]?.type === 'interaction' && events[0]?.device === 'Salon Light' && events[0]?.action === 'OFF' && events[0]?.ok === true, 'event frame carries interaction payload')
        assert(typeof events[0]?.ts === 'number', 'event frame carries a timestamp')

        // H) stop() tears down -------------------------------------------------------------
        console.log('-- H) stop() silences both directions --')
        AiBridgeMonitor.stop()
        const beforeStop = fake.published.length
        deliver(fake, 'automaton/ai/request', JSON.stringify({ text: 'too late now' }))
        EventBus.emit('ai:deviceInteraction', { device: 'X', action: 'ON', tool: 'native', ok: true })
        await sleep(80)
        assert(fake.published.length === beforeStop, 'no frames after stop()')
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exitCode = 1
    } finally {
        assistantProto.isAvailable = originalIsAvailable
        assistantProto.processMessage = originalProcessMessage
        try { await MqttService.disconnect() } catch { /* best-effort teardown */ }
    }

    console.log(`\nResults: ${passCount} passed, ${failCount} failed`)
    process.exit(failCount > 0 ? 1 : 0)
}

main()
