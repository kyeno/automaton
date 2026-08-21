import { config } from 'dotenv'
config()

'use strict'

/**
 * Regression tests for the deferred-publish contract of the REAL MQTT service pipeline.
 *
 * Background: DeviceBase defers all attribution side-effects (correlator token
 * registration, origin stamping, cooldown writes) into an `onPublish` hook stored at
 * `options.meta.onPublish`. SMQTTService must invoke that hook exactly once at the
 * moment the queued message is actually handed to the underlying client -- previously
 * #drainQueue read `entry.meta?.onPublish` while publish() stored hooks under
 * `entry.options.meta`, so the hooks never fired against a real broker and every
 * automation-driven state change fell back to "human". These tests drive the actual
 * publish -> queue -> drain loop with an injected fake client (no live broker needed),
 * pinning down this contract end-to-end.
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

// Bootstrap config + logger so service code works without full app startup
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 3000) {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`)
        await sleep(5)
    }
}

/**
 * Minimal stand-in for an mqtt.js MqttClient -- only the surface SMQTTService uses:
 * on/emit events, publish, subscribe/unsubscribe, end, destroy, listenerCount and
 * setMaxListeners. Emits 'connect' asynchronously right after creation so that
 * init()'s #connect promise resolves exactly like a real broker handshake would.
 */
function createFakeMqttClient() {
    const handlers = {}
    const client = {
        connected: true,
        published: [], // { topic, payload, options } in drain order
        publish(topic, payload, options) {
            this.published.push({ topic, payload, options })
        },
        on(event, handler) {
            ;(handlers[event] ??= []).push(handler)
            return this
        },
        emit(event, ...args) {
            for (const h of [...(handlers[event] || [])]) h(...args)
            return this
        },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testHookFiresExactlyOnceOnDrain(fake) {
    console.log('\n── onPublish hook fires exactly once when a queued message drains ──')
    let fired = 0
    MqttService.publish('zigbee2mqtt/Salon Pilot Roleta Lewa/set', JSON.stringify({ position: 40 }), {
        meta: { onPublish: () => fired++ }
    })

    await waitFor(() => fired >= 1, 'onPublish hook invocation')
    assert(fired === 1, `hook invoked exactly once (got ${fired})`)

    const call = fake.published.find(c => c.topic.endsWith('/set'))
    assert(call !== undefined, 'underlying client received the publish')
    assert(call?.payload === '{"position":40}', `payload passed through unchanged (got ${JSON.stringify(call?.payload)})`)
    assert(!call || !('meta' in (call.options ?? {})),
        `caller metadata stripped before reaching mqtt.js (options=${JSON.stringify(call?.options)})`)
}

async function testEachPublishFiresItsOwnHookInOrder(fake) {
    console.log('\n── multiple publishes each fire their own hook exactly once, in order ──')
    const order = []
    for (let i = 0; i < 3; i++) {
        MqttService.publish(`zigbee2mqtt/seq${i}/set`, `{"seq":${i}}`, {
            meta: { onPublish: () => order.push(i) }
        })
    }

    await waitFor(() => order.length >= 3, 'all three hooks to fire')
    // Any double-fired hook would show up as a duplicate entry here.
    assert(JSON.stringify(order) === JSON.stringify([0, 1, 2]),
        `hooks fired once each, FIFO order (got [${order.join(',')}])`)
}

async function testThrowingHookDoesNotBreakQueue(fake) {
    console.log('\n── a throwing hook is contained and the queue keeps draining ──')
    let afterFired = false
    MqttService.publish('zigbee2mqtt/boom/set', '{"x":1}', {
        meta: { onPublish: () => { throw new Error('kaboom') } }
    })
    await sleep(50) // let this drain pass process (and log) the failure

    MqttService.publish('zigbee2mqtt/after/set', '{"y":2}', {
        meta: { onPublish: () => { afterFired = true } }
    })
    await waitFor(() => afterFired, 'hook of the publish enqueued after the failing one')
    assert(afterFired, 'subsequent publishes still drained and their hooks ran')
    const boomCall = fake.published.find(c => c.topic === 'zigbee2mqtt/boom/set')
    const afterCall = fake.published.find(c => c.topic === 'zigbee2mqtt/after/set')
    assert(!!boomCall && !!afterCall, 'both messages reached the underlying client')
}

async function testPublishWithoutOptionsStillWorks(fake) {
    console.log('\n── publish without options still drains cleanly ──')
    MqttService.publish('zigbee2mqtt/plain/set', '{"z":3}')
    await waitFor(() => fake.published.some(c => c.topic === 'zigbee2mqtt/plain/set'),
        'option-less publish to reach the client')
    const call = fake.published.find(c => c.topic === 'zigbee2mqtt/plain/set')
    assert(!call || !('meta' in (call.options ?? {})),
        `no metadata leaked into mqtt.js options (options=${JSON.stringify(call?.options)})`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
    console.log('=== MQTT Publish Hook Contract Tests (real SMQTTService queue/drain pipeline) ===\n')

    const fake = createFakeMqttClient()
    // Inject a fake client factory so we drive the real init/connect/queue/drain path.
    await MqttService.init({ connectFn: () => fake })

    try {
        await testHookFiresExactlyOnceOnDrain(fake)
        await testEachPublishFiresItsOwnHookInOrder(fake)
        await testThrowingHookDoesNotBreakQueue(fake)
        await testPublishWithoutOptionsStillWorks(fake)
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