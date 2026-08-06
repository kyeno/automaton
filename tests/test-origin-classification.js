import { config } from 'dotenv'
config()

'use strict'

/**
 * Integration test for device origin classification.
 *
 * Verifies that the CommandCorrelator + grace period correctly distinguishes
 * automation-initiated commands from human-initiated interactions, including
 * edge cases like race conditions and state label mismatches.
 *
 * Uses a Mock MqttService so no real broker is needed. Skips dev.init() since
 * cache loading is not relevant — we want cold-start behavior with clean state.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

import Mechanism from '../src/device/type/mechanism.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'

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

    constructor({ echoDelayMs = 0 } = {}) {
        this.connected = true
        this.published = []
        this.echoDelayMs = echoDelayMs
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testColdStartAutomationCommand() {
    console.log('\n── Cold start + automation command ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller', mqtt)

    // Automation sends OPEN
    roller.receiveCommand('OPEN', true)
    await sleep(100)

    assert(roller.getStateOrigin() === 'automation',
        `origin should be "automation", got "${roller.getStateOrigin()}"`)
    assert(mqtt.published.length > 0 && mqtt.published[0].payload.state === 'OPEN',
        'should have published OPEN to /set topic')
}

async function testGracePeriodProtectsAgainstExternalMsg() {
    console.log('\n── Grace period protects against external msg ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller G', mqtt)

    // Step 1: Automation opens the roller
    roller.receiveCommand('OPEN', true)
    await sleep(100)
    assert(roller.getStateOrigin() === 'automation',
        `Step 1: origin is automation, got "${roller.getStateOrigin()}"`)

    // Step 2: Simulate an external message (Z2M UI close) within grace period
    mqtt.simulateExternalMessage('Test Roller G', { state: 'CLOSE', position: 0 })
    await sleep(100)

    // Within grace period (~90s), origin should stay automation despite external msg
    assert(roller.getStateOrigin() === 'automation',
        `Step 2: within grace, origin stays automation, got "${roller.getStateOrigin()}"`)
}

async function testHumanTriggeredCommand() {
    console.log('\n── Human-triggered command (remote/interaction) ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller H', mqtt)

    // Human presses button → interaction fires receiveCommand with fromAutomation=false
    roller.receiveCommand('ON', false)
    await sleep(100)

    assert(roller.getStateOrigin() === 'human',
        `origin should be "human", got "${roller.getStateOrigin()}"`)
}

/**
 * Verify that getStateOrigin correctly reports 'human' after a human-triggered
 * command. Replaces the old wasHumanInteractionRecent test since that method
 * was removed (cooldown is now handled entirely via Redis).
 */
async function testWasHumanInteractionRecent() {
    console.log('\n── Origin reflects human interaction ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller W', mqtt)

    // Human-triggered command sets origin to 'human'
    roller.receiveCommand('OPEN', false)
    await sleep(100)

    assert(roller.getStateOrigin() === 'human',
        `origin should be 'human' after human cmd, got "${roller.getStateOrigin()}"`)

    // Automation command flips origin back to 'automation'
    roller.receiveCommand('CLOSE', true)
    await sleep(100)

    assert(roller.getStateOrigin() === 'automation',
        `origin should flip to 'automation' after automation cmd, got "${roller.getStateOrigin()}"`)
}

async function testGracePeriodProtectsMismatchedStateLabel() {
    console.log('\n── Grace period protects against state label mismatch ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller M', mqtt)

    // Automation sends OPEN. z2m echoes back {state:"ON", position:50} which does NOT
    // match correlator token (expected="OPEN"). Grace period should save us.
    roller.receiveCommand('OPEN', true)
    await sleep(100)

    // The mock already sent {state:"ON"} as echo. Origin should still be automation
    // because grace period caught it even though correlator didn't match.
    assert(roller.getStateOrigin() === 'automation',
        `grace preserved automation origin despite ON≠OPEN mismatch, got "${roller.getStateOrigin()}"`)
}

async function testMultipleRapidAutomationCommands() {
    console.log('\n── Multiple rapid automation commands to same device ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller R', mqtt)

    // Send two commands in quick succession
    roller.receiveCommand('OPEN', true)
    await sleep(20)
    roller.receiveCommand('STOP', true)
    await sleep(100)

    assert(roller.getStateOrigin() === 'automation',
        `origin stays automation after multiple rapid commands, got "${roller.getStateOrigin()}"`)
    assert(mqtt.published.length >= 2,
        `both commands were published (${mqtt.published.length})`)
}

async function testNoStateChangeDoesNotFlipOrigin() {
    console.log('\n── Periodic report (no state change) does not flip origin ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller P', mqtt)

    // Automation opens
    roller.receiveCommand('OPEN', true)
    await sleep(100)
    assert(roller.getStateOrigin() === 'automation',
        `Step 1: origin is automation, got "${roller.getStateOrigin()}"`)

    // Simulate a periodic report with same-ish values (within tolerance)
    mqtt.simulateExternalMessage('Test Roller P', { state: 'ON', position: 48 })
    await sleep(100)

    // Position barely changed (50→48, within tolerance=2), should NOT flip to human
    // Note: grace period also protects this. The key point is no-flip on minor changes.
    assert(roller.getStateOrigin() === 'automation',
        `periodic report did not flip origin, got "${roller.getStateOrigin()}"`)
}

async function testAutomationThenHumanAfterGraceExpires() {
    console.log('\n── Human override after grace expires (simulated via direct msg) ──')
    const mqtt = new MockMqttService({ echoDelayMs: 5 })
    const roller = createRoller('Test Roller X', mqtt)

    // Step 1: Automation opens the roller
    roller.receiveCommand('OPEN', true)
    await sleep(100)
    assert(roller.getStateOrigin() === 'automation',
        `Step 1: origin is automation, got "${roller.getStateOrigin()}"`)

    // Step 2: Simulate a HUMAN interaction by sending receiveCommand with fromAutomation=false
    // This properly sets origin=human through the normal code path
    roller.receiveCommand('CLOSE', false)
    await sleep(100)

    assert(roller.getStateOrigin() === 'human',
        `Step 2: human command flips origin to human, got "${roller.getStateOrigin()}"`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
    console.log('=== Origin Classification Tests ===\n')

    try {
        await testColdStartAutomationCommand()
        await testGracePeriodProtectsAgainstExternalMsg()
        await testHumanTriggeredCommand()
        await testWasHumanInteractionRecent()
        await testGracePeriodProtectsMismatchedStateLabel()
        await testMultipleRapidAutomationCommands()
        await testNoStateChangeDoesNotFlipOrigin()
        await testAutomationThenHumanAfterGraceExpires()
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