/**
 * Semantic-key dedupe coverage for soil moisture.
 *
 * SMQTTService drops inbound messages whose semantic signature -- the SEMANTIC_KEYS subset of
 * the payload -- repeats within a 300 ms window per topic. Soil probes report soil_moisture,
 * so that key must be part of the signature: with it absent, two genuinely different moisture
 * readings arriving close together collapse to the same empty signature and the second reading
 * is silently dropped, so the gardener automation never sees the drop that matters.
 *
 * Covers: distinct soil_moisture readings delivered, an identical reading deduped, a real drop
 * delivered after a same-value battery blip, non-semantic-only changes still deduped (the rule
 * stays key-based, not blanket), and a control actuator topic behaving exactly as before.
 *
 * Drives the real init/connect/dispatch path with an injected fake client (no live broker).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { config } from 'dotenv'
config()

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import MqttService from '../src/service/mqttService.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 FAIL: ${label}`)
        failed++
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
    setImmediate(() => client.emit('connect'))
    return client
}

/** Simulate an inbound MQTT message reaching the single dispatcher. */
function deliver(fake, topic, obj) {
    fake.emit('message', topic, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)))
}

//  Each scenario owns its topic: the dedupe window is per topic, so scenarios never
//  depend on wall-clock spacing between them.

function testDistinctMoistureDelivered(fake) {
    console.log('\n\u2500\u2500 A) distinct soil_moisture readings are delivered \u2500\u2500\n')
    const got = []
    MqttService.subscribe('zigbee2mqtt/Probe A', (_t, m) => got.push(m))
    deliver(fake, 'zigbee2mqtt/Probe A', { soil_moisture: 45, linkquality: 90 })
    deliver(fake, 'zigbee2mqtt/Probe A', { soil_moisture: 44, linkquality: 90 })
    assert(got.length === 2, `both moisture readings delivered (got ${got.length})`)
    assert(got[1]?.includes('"soil_moisture":44'), 'the second reading is the one that arrives')
}

function testIdenticalMoistureDeduped(fake) {
    console.log('\n\u2500\u2500 B) the same soil_moisture within the window is deduped \u2500\u2500\n')
    const got = []
    MqttService.subscribe('zigbee2mqtt/Probe B', (_t, m) => got.push(m))
    deliver(fake, 'zigbee2mqtt/Probe B', { soil_moisture: 44 })
    deliver(fake, 'zigbee2mqtt/Probe B', { soil_moisture: 44, linkquality: 30 })
    assert(got.length === 1, `repeat of the same moisture value dropped (got ${got.length})`)
}

function testBatteryBlipThenRealDrop(fake) {
    console.log('\n\u2500\u2500 C) battery blip at the same level stays quiet, the next drop speaks \u2500\u2500\n')
    const got = []
    MqttService.subscribe('zigbee2mqtt/Probe C', (_t, m) => got.push(m))
    deliver(fake, 'zigbee2mqtt/Probe C', { soil_moisture: 30, battery: 97 })
    deliver(fake, 'zigbee2mqtt/Probe C', { soil_moisture: 30, battery: 96 })
    deliver(fake, 'zigbee2mqtt/Probe C', { soil_moisture: 21, battery: 96 })
    assert(got.length === 2, `same-moisture battery blip dropped, real drop delivered (got ${got.length})`)
    assert(got[1]?.includes('"soil_moisture":21'), 'the delivered frame is the real drop')
}

function testNonSemanticOnlyStaysDeduped(fake) {
    console.log('\n\u2500\u2500 D) non-semantic-only traffic keeps deduping (rule stays key-based) \u2500\u2500\n')
    const got = []
    MqttService.subscribe('zigbee2mqtt/Probe D', (_t, m) => got.push(m))
    deliver(fake, 'zigbee2mqtt/Probe D', { linkquality: 90 })
    deliver(fake, 'zigbee2mqtt/Probe D', { linkquality: 40 })
    assert(got.length === 1, `linkquality-only change deduped (got ${got.length})`)

    //  Control: a plain actuator topic behaves exactly as before soil_moisture joined the set.
    const dev = []
    MqttService.subscribe('zigbee2mqtt/Plug Control', (_t, m) => dev.push(m))
    deliver(fake, 'zigbee2mqtt/Plug Control', { state: 'ON' })
    deliver(fake, 'zigbee2mqtt/Plug Control', { state: 'ON', linkquality: 12 })
    deliver(fake, 'zigbee2mqtt/Plug Control', { state: 'OFF' })
    assert(dev.length === 2, `actuator topic unaffected (got ${dev.length})`)
}

/** Pressure-only changes must not disappear before the numeric history recorder sees them. */
function testPressureDelivered(fake) {
    const got = []
    MqttService.subscribe('zigbee2mqtt/Barometer', (_topic, message) => got.push(message))
    deliver(fake, 'zigbee2mqtt/Barometer', { pressure: 1000 })
    deliver(fake, 'zigbee2mqtt/Barometer', { pressure: 1000.2 })
    deliver(fake, 'zigbee2mqtt/Barometer', { pressure: 1000.2, linkquality: 12 })
    assert(got.length === 2, 'pressure changes pass the semantic filter; identical pressure is deduped')
}

async function main() {
    console.log('=== MQTT Semantic-Key Dedupe Tests (soil_moisture) ===\n')

    const fake = createFakeMqttClient()
    await MqttService.init({ connectFn: () => fake })

    try {
        testPressureDelivered(fake)
        testDistinctMoistureDelivered(fake)
        testIdenticalMoistureDeduped(fake)
        testBatteryBlipThenRealDrop(fake)
        testNonSemanticOnlyStaysDeduped(fake)
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exit(1)
    } finally {
        try { await MqttService.disconnect() } catch { /* best-effort teardown */ }
    }

    console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550')
    console.log(`  Results: ${passed} passed, ${failed} failed`)
    console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550')
    process.exit(failed > 0 ? 1 : 0)
}

main()
