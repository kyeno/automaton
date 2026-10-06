import { config } from 'dotenv'
config()

'use strict'

/**
 * Regression tests for the MQTT semantic-deduplication contract AND its per-subscription opt-out.
 *
 * Background: SMQTTService drops "semantic duplicate" messages within a 300ms window (keyed per topic),
 * where the signature keeps only SEMANTIC_KEYS fields. Chat-style payloads such as {"text":"hi"} carry no
 * semantic keys, so their signature collapses to "{}" -- meaning two DIFFERENT prompts sent close together
 * would be dropped as duplicates. The AI Bridge channel needs subscribe(topic, cb, { dedupe:false }) to bypass
 * this for non-idempotent input. These tests pin down BOTH sides of that contract against the REAL dispatcher:
 *   A) default subscribers still dedupe constant-signature duplicates (pre-existing behavior preserved);
 *   B) a { dedupe:false } subscriber delivers every message even when signatures are identical;
 *   C) opting one topic out does NOT disable dedupe on unrelated topics (isolation);
 *   D) wildcard patterns honor the opt-out too.
 *
 * Drives the real init/connect/dispatch path with an injected fake client (no live broker needed).
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
        console.log(`  ✓ ${message}`)
    } else {
        failCount++
        console.error(`  ✗ FAIL: ${message}`)
    }
}

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
function deliver(fake, topic, obj) {
    fake.emit('message', topic, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testDefaultSubStillDedupes(fake) {
    console.log('\n── A) default subscriber still drops constant-signature duplicates ──')
    const got = []
    MqttService.subscribe('zigbee2mqtt/DevA', (_t, m) => got.push(m))
    deliver(fake, 'zigbee2mqtt/DevA', { state: 'ON' })
    deliver(fake, 'zigbee2mqtt/DevA', { state: 'ON', linkquality: 99 }) // same semantic sig -> deduped
    assert(got.length === 1, `first delivered, semantic duplicate dropped (got ${got.length})`)
    assert(got[0] === '{"state":"ON"}', `delivered payload is the first one (got ${JSON.stringify(got[0])})`)
}

async function testNoDedupeDeliversDistinctPrompts(fake) {
    console.log('\n── B) {dedupe:false} delivers distinct prompts that share an empty signature ──')
    const chat = []
    MqttService.subscribe('automaton/ai/request', (_t, m) => chat.push(m), { dedupe: false })
    deliver(fake, 'automaton/ai/request', { text: 'hello' })   // sig "{}"
    deliver(fake, 'automaton/ai/request', { text: 'world' })   // sig "{}" -- would be deduped without opt-out
    assert(chat.length === 2, `both distinct prompts delivered despite identical signature (got ${chat.length})`)
    assert(chat[0].includes('hello') && chat[1].includes('world'), 'payloads preserved in order')
}

async function testIsolationBetweenTopics(fake) {
    console.log('\n── C) opting one topic out does NOT disable dedupe on unrelated topics ──')
    // Control: same constant-signature payload shape, but a DEFAULT subscriber -> second must be dropped.
    const ctrl = []
    MqttService.subscribe('zigbee2mqtt/chatcontrol', (_t, m) => ctrl.push(m))
    deliver(fake, 'zigbee2mqtt/chatcontrol', { text: 'a' })   // sig "{}"
    deliver(fake, 'zigbee2mqtt/chatcontrol', { text: 'b' })   // sig "{}" -> deduped (default behavior intact)
    assert(ctrl.length === 1, `unrelated default topic still dedupes (got ${ctrl.length})`)

    // A fresh normal device topic also keeps working end-to-end after all the no-dedupe activity above.
    const dev = []
    MqttService.subscribe('zigbee2mqtt/DevB', (_t, m) => dev.push(m))
    deliver(fake, 'zigbee2mqtt/DevB', { state: 'OFF' })
    deliver(fake, 'zigbee2mqtt/DevB', { state: 'OFF' })       // exact duplicate -> deduped
    assert(dev.length === 1, `normal device topic unaffected by other topics' opt-out (got ${dev.length})`)
}

async function testWildcardHonorsOptOut(fake) {
    console.log('\n── D) wildcard patterns honor the {dedupe:false} opt-out ──')
    const ev = []
    MqttService.subscribe('automaton/ai/#', (_t, m) => ev.push(m), { dedupe: false })
    deliver(fake, 'automaton/ai/events', { type: 'interaction', device: 'X' })   // sig "{}"
    deliver(fake, 'automaton/ai/events', { type: 'interaction', device: 'Y' })   // sig "{}" -> delivered via wildcard
    assert(ev.length === 2, `wildcard no-dedupe subscriber delivers both frames (got ${ev.length})`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
    console.log('=== MQTT Dedupe Contract + Opt-Out Tests (real SMQTTService dispatcher) ===\n')

    const fake = createFakeMqttClient()
    await MqttService.init({ connectFn: () => fake })

    try {
        await testDefaultSubStillDedupes(fake)
        await testNoDedupeDeliversDistinctPrompts(fake)
        await testIsolationBetweenTopics(fake)
        await testWildcardHonorsOptOut(fake)
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exit(1)
    } finally {
        try { await MqttService.disconnect() } catch { /* best-effort teardown */ }
    }

    console.log(`\n══════════════════════════════════════`)
    console.log(`  Results: ${passCount} passed, ${failCount} failed`)
    console.log(`══════════════════════════════════════`)
    process.exit(failCount > 0 ? 1 : 0)
}

main()