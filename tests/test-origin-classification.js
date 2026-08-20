import { config } from 'dotenv'
config()

'use strict'

/**
 * Integration tests for device origin classification.
 *
 * Policy under test: ONLY autonomous rule-engine actions are attributed as
 * "automation". Every other actor -- physical remotes, YAML interactions,
 * Home Assistant / z2m UI, unmodeled wall switches, AND AI chat commands --
 * counts as human interaction. These tests verify:
 *   - rule-engine command echoes keep origin=automation (echo + continuation)
 *   - human-directed commands flip origin to human immediately at dispatch time
 *     and start the Redis cooldown (stale automation tokens cancelled)
 *   - motion contradicting an active command (wall-switch reversal) flips to human
 *   - slow but progressing travel stays automation end-to-end
 *   - automated STOP settles as automation; later movement is human
 *   - stalled automated motion (no progress) trips the watchdog -> human
 *   - non-actuator devices never participate in origin tracking
 *
 * Uses a Mock MqttService so no real broker is needed. Devices skip init() so
 * cache loading is irrelevant — we want cold-start behavior with clean state.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

import Mechanism from '../src/device/type/mechanism.js'
import DummyDevice from '../src/device/type/dummy.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

// Bootstrap config + logger so device code works without full app startup
await ConfigService.init()
LoggerService.init()

// ---------------------------------------------------------------------------
// Mock MqttService
// ---------------------------------------------------------------------------

class MockMqttService {
    #callbacks = new Map()

    constructor({ echoDelayMs = 0, autoEcho = true } = {}) {
        this.connected = true
        this.published = []
        this.echoDelayMs = echoDelayMs
        this.autoEcho = autoEcho
    }

    getPrefix() { return 'zigbee2mqtt' }

    isConnected() { return this.connected }

    subscribe(topic, callback) {
        this.#callbacks.set(topic, callback)
        return () => { this.#callbacks.delete(topic) }
    }

    publish(topic, payloadStr, options) {
        const parsed = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr
        this.published.push({ topic, payload: parsed })

        // Fire meta.onPublish callback so correlator registration + origin assignment
        // happen just like in production (deferred to actual publish time).
        const onPublishCb = options?.meta?.onPublish
        setTimeout(() => {
            if (typeof onPublishCb === 'function') onPublishCb()
        }, 0)

        if (!this.autoEcho) return

        // Extract device name from topic "zigbee2mqtt/<name>/set"
        const match = topic.match(/^([\w-]+)\s*\/\s*(.+?)\s*\/\s*set$/)
        if (!match) return

        const [, prefix, deviceName] = match
        const echoTopic = `${prefix}/${deviceName}`

        // Simulate zigbee2mqtt echoing the state back after a short delay
        setTimeout(() => {
            const cb = this.#callbacks.get(echoTopic)
            if (!cb) return

            let echoPayload
            if ('state' in parsed) {
                const st = String(parsed.state).toUpperCase()
                // Roller shutters report ON instead of OPEN sometimes
                if (st === 'OPEN') {
                    echoPayload = { state: 'ON', position: 50 }
                } else if (st === 'CLOSE') {
                    echoPayload = { state: 'OFF', position: 10 }
                } else {
                    echoPayload = { state: st }
                }
            } else if ('position' in parsed) {
                echoPayload = { state: 'STOP', position: parsed.position }
            } else {
                echoPayload = parsed
            }

            cb(echoTopic, JSON.stringify(echoPayload))
        }, this.echoDelayMs)
    }

    /**
     * Simulate an external source (Z2M UI, wall switch, physical button) publishing
     * a state update on the device topic. This bypasses /set and goes directly to
     * the state topic that our subscription listens on.
     */
    simulateExternalMessage(deviceName, payload) {
        const topic = `zigbee2mqtt/${deviceName}`
        const cb = this.#callbacks.get(topic)
        if (!cb) return
        cb(topic, JSON.stringify(payload))
    }

    reset() {
        this.published = []
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passCount = 0
let failCount = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  [PASS] ${label}`)
        passCount++
    } else {
        console.error(`  [FAIL] ${label}`)
        failCount++
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Create a roller mechanism with mock MQTT service.
 * Does NOT call init() — we want cold-start behavior without cache dependencies.
 */
function createRoller(name, mockMqtt) {
    // Use slugified name as ID (same convention as production config)
    const id = name.toLowerCase().replace(/\s+/g, '_')
    const dev = new Mechanism(name, id, {})
    // Skip dev.init() to avoid Redis/LoggerService dependency; origin starts at "unknown"
    dev.setMqttService(mockMqtt)
    return dev
}

/**
 * Roller variant with a fast motion-stall watchdog so the stall tests do not
 * have to wait for the real default timeout.
 */
class FastWatchdogRoller extends Mechanism {
    getMotionStallTimeoutMs() {
        return 300
    }
}

function createFastRoller(name, mockMqtt) {
    const id = name.toLowerCase().replace(/\s+/g, '_')
    const dev = new FastWatchdogRoller(name, id, {})
    dev.setMqttService(mockMqtt)
    return dev
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testColdStartAutomationCommand() {
    console.log('\n── Cold start + rule-engine command ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller', mqtt)

    // Rule engine sends OPEN
    roller.receiveCommand('OPEN', DeviceCommandSource.AUTOMATION)
    await sleep(100)

    assert(roller.getStateOrigin() === 'automation',
        `origin should be "automation", got "${roller.getStateOrigin()}"`)
    assert(mqtt.published.length > 0 && mqtt.published[0].payload.state === 'OPEN',
        'should have published OPEN to /set topic')
}

async function testCloseEchoConsumedAsAutomation() {
    console.log('\n── Terminal echo of CLOSE consumed as automation ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createRoller('Test Roller C', mqtt)
    await roller.setCachedState({ position: 60 }, { origin: 'unknown' })

    roller.receiveCommand('CLOSE', DeviceCommandSource.AUTOMATION)
    await sleep(20)

    // z2m reports the shutter reaching the closed end (terminal threshold match)
    mqtt.simulateExternalMessage('Test Roller C', { state: 'OFF', position: 8 })
    await sleep(50)

    assert(roller.getStateOrigin() === 'automation',
        `closed-end echo keeps origin automation, got "${roller.getStateOrigin()}"`)

    // Any LATER change with no active token is human interaction.
    mqtt.simulateExternalMessage('Test Roller C', { state: 'ON', position: 30 })
    await sleep(50)
    assert(roller.getStateOrigin() === 'human',
        `post-echo external change flips to human, got "${roller.getStateOrigin()}"`)
}

async function testHumanDirectedCommandIsHumanImmediately() {
    console.log('\n── Human-directed command sets origin + cooldown at dispatch time ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createRoller('Test Roller H', mqtt)

    let cooldownWrites = 0
    // The singleton instance is frozen -- spy via its class prototype instead.
    const proto = Object.getPrototypeOf(CacheService)
    const originalSet = proto.setHumanCooldown
    proto.setHumanCooldown = async function (...args) {
        cooldownWrites++
        return originalSet.apply(this, args)
    }

    try {
        // Remote press / AI chat tool call -> explicit HUMAN provenance
        roller.receiveCommand('OPEN', DeviceCommandSource.HUMAN)
        await sleep(100)

        assert(roller.getStateOrigin() === 'human',
            `origin should be "human" immediately after dispatch, got "${roller.getStateOrigin()}"`)
        assert(cooldownWrites >= 1,
            `cooldown written at dispatch time (got ${cooldownWrites} writes)`)
    } finally {
        proto.setHumanCooldown = originalSet
    }
}

async function testAiChatStopCancelsPendingAutomationToken() {
    console.log('\n── Regression: in-flight automation CLOSE + human STOP stays human ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createRoller('Test Roller A', mqtt)
    await roller.setCachedState({ position: 45 }, { origin: 'unknown' })

    // Step 1: rule engine starts closing the shutter
    roller.receiveCommand('CLOSE', DeviceCommandSource.AUTOMATION)
    await sleep(20)
    assert(roller.getStateOrigin() === 'automation',
        `Step 1: origin is automation while command in flight, got "${roller.getStateOrigin()}"`)

    // Step 2: person stops it via remote/AI before any motion report arrives.
    // This must cancel the pending CLOSE token and flip origin NOW.
    roller.receiveCommand('STOP', DeviceCommandSource.HUMAN)
    await sleep(20)
    assert(roller.getStateOrigin() === 'human',
        `Step 2: human STOP flips origin to human immediately, got "${roller.getStateOrigin()}"`)

    // Step 3: z2m finally reports the (stale) close outcome. With a stale token this
    // would have matched the CLOSE alias and been misclassified as automation.
    mqtt.simulateExternalMessage('Test Roller A', { state: 'OFF' })
    await sleep(50)
    assert(roller.getStateOrigin() === 'human',
        `Step 3: stale automation echo NOT re-attributed, got "${roller.getStateOrigin()}"`)
}

async function testWallSwitchReversalMidTravelFlipsToHuman() {
    console.log('\n── Wall-switch reversal during automated travel ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createRoller('Test Roller W', mqtt)
    await roller.setCachedState({ position: 10 }, { origin: 'unknown' })

    roller.receiveCommand('OPEN', DeviceCommandSource.AUTOMATION)
    await sleep(20)

    // Normal forward motion of our own command -> continuation, stays automation
    mqtt.simulateExternalMessage('Test Roller W', { position: 35 })
    await sleep(20)
    assert(roller.getStateOrigin() === 'automation',
        `forward progress keeps origin automation (pos=35), got "${roller.getStateOrigin()}"`)

    mqtt.simulateExternalMessage('Test Roller W', { position: 60 })
    await sleep(20)
    assert(roller.getStateOrigin() === 'automation',
        `forward progress keeps origin automation (pos=60), got "${roller.getStateOrigin()}"`)

    // Person presses the wall switch against us: motion reverses vs our OPEN.
    mqtt.simulateExternalMessage('Test Roller W', { position: 54 })
    await sleep(50)
    assert(roller.getStateOrigin() === 'human',
        `reversed motion flips to human immediately, got "${roller.getStateOrigin()}"`)
}

async function testSlowCreepTravelStaysAutomation() {
    console.log('\n── Slow travel with sub-tolerance steps stays automation ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createRoller('Test Roller S', mqtt)
    await roller.setCachedState({ position: 10 }, { origin: 'unknown' })

    roller.receiveCommand('OPEN', DeviceCommandSource.AUTOMATION)
    await sleep(20)

    // Each step is within jitter tolerance of the previous one but steadily
    // approaches the target -- must count as continuation, not stall/conflict.
    for (const pos of [11, 12, 13, 14]) {
        mqtt.simulateExternalMessage('Test Roller S', { position: pos })
        await sleep(20)
        assert(roller.getStateOrigin() === 'automation',
            `slow creep keeps origin automation at pos=${pos}, got "${roller.getStateOrigin()}"`)
    }
}

async function testStopCommandSettlesAsAutomationThenExternalIsHuman() {
    console.log('\n── Automated STOP settles as automation; later movement is human ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createRoller('Test Roller T', mqtt)
    await roller.setCachedState({ position: 80 }, { origin: 'unknown' })

    roller.receiveCommand('STOP', DeviceCommandSource.AUTOMATION)
    await sleep(20)

    // Motor inertia drift after our own STOP -> continuation, then settled -> echo
    mqtt.simulateExternalMessage('Test Roller T', { position: 78 })
    await sleep(20)
    assert(roller.getStateOrigin() === 'automation',
        `inertia drift after automated STOP stays automation (pos=78), got "${roller.getStateOrigin()}"`)

    mqtt.simulateExternalMessage('Test Roller T', { position: 77 })
    await sleep(50)
    assert(roller.getStateOrigin() === 'automation',
        `settled stop consumed as automation echo (pos=77), got "${roller.getStateOrigin()}"`)

    // Later manual movement with no active token -> human.
    mqtt.simulateExternalMessage('Test Roller T', { position: 60 })
    await sleep(50)
    assert(roller.getStateOrigin() === 'human',
        `later external movement flips to human, got "${roller.getStateOrigin()}"`)
}

async function testToggleWildcardConsumesExactlyOneFlip() {
    console.log('\n── TOGGLE wildcard consumes exactly one state flip ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const light = createRoller('Test Light TG', mqtt)

    light.receiveCommand('TOGGLE', DeviceCommandSource.AUTOMATION)
    await sleep(100)
    assert(light.getStateOrigin() === 'automation',
        `toggle echo keeps origin automation, got "${light.getStateOrigin()}"`)

    // A second change after the wildcard was consumed is a genuine interaction.
    mqtt.simulateExternalMessage('Test Light TG', { state: 'OFF' })
    await sleep(50)
    assert(light.getStateOrigin() === 'human',
        `second flip classified as human, got "${light.getStateOrigin()}"`)
}

async function testPeriodicReportDoesNotFlipOrigin() {
    console.log('\n── Periodic report (no meaningful change) does not flip origin ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createRoller('Test Roller P', mqtt)
    await roller.setCachedState({ position: 10 }, { origin: 'unknown' })

    roller.receiveCommand('OPEN', DeviceCommandSource.AUTOMATION)
    await sleep(20)

    mqtt.simulateExternalMessage('Test Roller P', { position: 35 })
    await sleep(20)
    assert(roller.getStateOrigin() === 'automation',
        `forward progress keeps automation, got "${roller.getStateOrigin()}"`)

    // z2m re-advertises the same state periodically -- must NOT be human input.
    mqtt.simulateExternalMessage('Test Roller P', { position: 35 })
    await sleep(50)
    assert(roller.getStateOrigin() === 'automation',
        `periodic identical report did not flip origin, got "${roller.getStateOrigin()}"`)
}

async function testUnmatchedLabelDuringTravelPreservesOrigin() {
    console.log('\n── Unmatched label-only change during travel preserves origin ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createRoller('Test Roller U', mqtt)
    await roller.setCachedState({ position: 10 }, { origin: 'unknown' })

    roller.receiveCommand('OPEN', DeviceCommandSource.AUTOMATION)
    await sleep(20)

    mqtt.simulateExternalMessage('Test Roller U', { position: 35 })
    await sleep(20)

    // Label-only report that does not confirm our OPEN command (no position data):
    // keep current attribution while the expectation is still alive -- the watchdog
    // decides later if motion truly stalled.
    mqtt.simulateExternalMessage('Test Roller U', { state: 'OFF' })
    await sleep(50)
    assert(roller.getStateOrigin() === 'automation',
        `unmatched label inside active window keeps automation, got "${roller.getStateOrigin()}"`)
}

async function testStalledMotionWatchdogFlipsToHuman() {
    console.log('\n── Stalled automated motion trips watchdog -> human ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createFastRoller('Test Roller SW', mqtt)   // stall timeout 300ms
    await roller.setCachedState({ position: 10 }, { origin: 'unknown' })

    roller.receiveCommand('OPEN', DeviceCommandSource.AUTOMATION)
    await sleep(60)
    assert(roller.getStateOrigin() === 'automation',
        `origin automation while command in flight, got "${roller.getStateOrigin()}"`)

    // No progress reports at all (e.g., wall-switch STOP on an unmodeled device):
    // the watchdog must flip to human after the stall window elapses.
    await sleep(450)
    assert(roller.getStateOrigin() === 'human',
        `stalled motion flips to human via watchdog, got "${roller.getStateOrigin()}"`)
}

async function testMovingDeviceDoesNotTripWatchdog() {
    console.log('\n── Moving device past stall window does NOT trip watchdog ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const roller = createFastRoller('Test Roller MW', mqtt)   // stall timeout 300ms
    await roller.setCachedState({ position: 10 }, { origin: 'unknown' })

    roller.receiveCommand('OPEN', DeviceCommandSource.AUTOMATION)
    await sleep(60)

    // Steady forward progress re-arms the watchdog each time; total elapsed is well
    // beyond the 300ms stall window without any flip. Check shortly after the last
    // report (within one fresh watchdog period).
    for (const pos of [20, 30, 40, 50]) {
        mqtt.simulateExternalMessage('Test Roller MW', { position: pos })
        await sleep(80)
    }
    await sleep(100)
    assert(roller.getStateOrigin() === 'automation',
        `progressing motion never trips watchdog, got "${roller.getStateOrigin()}"`)
}

async function testNonMechanismDevicesDoNotTrackOrigin() {
    console.log('\n── Non-actuator devices do not participate in origin tracking ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5, autoEcho: false })
    const dummy = new DummyDevice('Test Dummy D', 'test_dummy_d', {})
    dummy.setMqttService(mqtt)

    // A state change on a non-mechanism device must NOT be classified as human.
    mqtt.simulateExternalMessage('Test Dummy D', { state: 'ON' })
    await sleep(50)
    assert(dummy.getStateOrigin() === 'unknown',
        `dummy device origin stays unknown, got "${dummy.getStateOrigin()}"`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
    console.log('=== Origin Classification Tests (policy: only rule-engine actions are automation) ===\n')

    try {
        await testColdStartAutomationCommand()
        await testCloseEchoConsumedAsAutomation()
        await testHumanDirectedCommandIsHumanImmediately()
        await testAiChatStopCancelsPendingAutomationToken()
        await testWallSwitchReversalMidTravelFlipsToHuman()
        await testSlowCreepTravelStaysAutomation()
        await testStopCommandSettlesAsAutomationThenExternalIsHuman()
        await testToggleWildcardConsumesExactlyOneFlip()
        await testPeriodicReportDoesNotFlipOrigin()
        await testUnmatchedLabelDuringTravelPreservesOrigin()
        await testStalledMotionWatchdogFlipsToHuman()
        await testMovingDeviceDoesNotTripWatchdog()
        await testNonMechanismDevicesDoNotTrackOrigin()
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exit(1)
    }

    console.log(`\n══════════════════════════════════════`)
    console.log(`  Results: ${passCount} passed, ${failCount} failed`)
    console.log(`══════════════════════════════════════`)
    process.exit(failCount > 0 ? 1 : 0)
}

main()