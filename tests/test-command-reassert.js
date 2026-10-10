/**
 * Re-assert / unverified-state regression tests (doc/ht-lights-bug.md).
 *
 * Reproduces the 2026-10-09 home-theater incident end to end and pins the fix:
 *
 *   Device layer
 *   - A plug that executes an automation command but never reports it (zigbee2mqtt stays
 *     silent, periodic reports keep claiming the OLD state) used to leave the cached state
 *     "proven" -- so the next restore ON was dropped as a no-op and the lamps stayed dark.
 *     Now an expired-without-confirmation command marks the cached state UNVERIFIED, and a
 *     later command is dispatched instead of suppressed. Self-limiting: dispatching it
 *     registers a fresh token, so at most one extra publish per unconfirmed command.
 *   - A stale (unchanged) periodic report must NOT resolve that doubt; a genuine state
 *     change must.
 *   - The MQTT-spam guarantee stays intact for healthy devices: a confirmed redundant
 *     command is still suppressed.
 *   - `receiveCommand(..., {bypassNoOpSuppression: true})` forces a command onto the wire.
 *
 *   Rule engine
 *   - Forced runs (`/automation force`, `invoke_automation: {force: true}` hand-offs) pass
 *     the bypass through; natural runs do not.
 *   - A rule flagged `reassert_state: true` passes it through on a natural run, scoped to
 *     the targets that rule actually contributes to.
 *
 * Uses a Mock MqttService so no broker is needed; devices skip init() so cache loading is
 * irrelevant (cold-start behaviour with clean state, same idiom as test-origin-classification).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import Mechanism from '../src/device/type/mechanism.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
import DualSwitch from '../src/device/type/dualswitch.js'
import DualDimmer from '../src/device/type/dualdimmer.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0

/** @param {boolean} condition @param {string} label */
function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

/** @param {number} ms */
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Mock MqttService (same shape as test-origin-classification.js)
// ---------------------------------------------------------------------------

class MockMqttService {
    #callbacks = new Map()

    /** @param {{autoEcho?: boolean}} [opts] */
    constructor({ autoEcho = false } = {}) {
        this.connected = true
        this.published = []
        this.autoEcho = autoEcho
    }

    getPrefix() { return 'zigbee2mqtt' }

    isConnected() { return this.connected }

    /** @param {string} topic @param {Function} callback */
    subscribe(topic, callback) {
        this.#callbacks.set(topic, callback)
        return () => { this.#callbacks.delete(topic) }
    }

    /** @param {string} topic @param {string|Object} payloadStr @param {Object} [options] */
    publish(topic, payloadStr, options) {
        const parsed = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr
        this.published.push({ topic, payload: parsed })

        const onPublishCb = options?.meta?.onPublish
        setTimeout(() => {
            if (typeof onPublishCb === 'function') onPublishCb()
        }, 0)

        if (!this.autoEcho) return

        const match = topic.match(/^([\w-]+)\s*\/\s*(.+?)\s*\/\s*set$/)
        if (!match) return
        const [, prefix, deviceName] = match
        const echoTopic = `${prefix}/${deviceName}`
        setTimeout(() => {
            const cb = this.#callbacks.get(echoTopic)
            if (!cb) return
            const echoPayload = 'state' in parsed
                ? { state: String(parsed.state).toUpperCase() }
                : parsed
            cb(echoTopic, JSON.stringify(echoPayload))
        }, 5)
    }

    /** Simulate a report arriving from zigbee2mqtt (NOT an echo of our own publish).
     * @param {string} deviceName @param {Object} payload */
    simulateExternalMessage(deviceName, payload) {
        const cb = this.#callbacks.get(`zigbee2mqtt/${deviceName}`)
        if (!cb) return
        cb(`zigbee2mqtt/${deviceName}`, JSON.stringify(payload))
    }
}

// ---------------------------------------------------------------------------
// Device helpers
// ---------------------------------------------------------------------------

/** Plug with a tiny echo window so "expired without confirmation" is testable quickly.
 *  Note CommandCorrelator.register() floors every token at 1 s, so this only trims the
 *  configured default down to that floor. */
class FastEchoPlug extends Mechanism {
    /** @returns {number} Echo window in milliseconds */
    getInstantEchoWindowMs() { return 1 }
}

/** How long a test waits for an unconfirmed token to run out (register() floors at 1 s). */
const TOKEN_EXPIRY_WAIT_MS = 1100

/** @param {string} name @param {MockMqttService} mockMqtt */
function createPlug(name, mockMqtt) {
    const id = name.toLowerCase().replace(/\s+/g, '_')
    const dev = new FastEchoPlug(name, id, {})
    dev.setMqttService(mockMqtt)
    return dev
}

// ---------------------------------------------------------------------------
// A. Device layer -- the incident itself
// ---------------------------------------------------------------------------

console.log('\n── A. Unverified state survives a stale report, so the restore is dispatched ──\n')
{
    const mqtt = new MockMqttService({ autoEcho: false })
    const plug = createPlug('Kitchen Plug', mqtt)

    //  The device is lit: a report lands, cache = ON.
    mqtt.simulateExternalMessage('Kitchen Plug', { state: 'ON' })
    assert(plug.getStateLast()?.state === 'ON', 'cache seeded to ON by a device report')

    //  Dark mode: automation switches the plug OFF. It executes on the device, but the
    //  device never reports back (the exact failure from the incident).
    plug.receiveCommand('OFF', DeviceCommandSource.AUTOMATION)
    await sleep(10)
    assert(mqtt.published.length === 1 && mqtt.published[0].payload.state === 'OFF',
        'dark-mode OFF reaches the wire')

    //  Echo window runs out with no confirmation.
    await sleep(TOKEN_EXPIRY_WAIT_MS)

    //  The plug keeps advertising its stale pre-command value (power is really 0 -- the
    //  relay did move). An unchanged report is NOT evidence that the command failed.
    mqtt.simulateExternalMessage('Kitchen Plug', { state: 'ON' })
    await sleep(10)

    //  Player goes offline -> forced restore sends ON. This used to be dropped as
    //  "Command \"ON\" suppressed: device already at target state".
    plug.receiveCommand('ON', DeviceCommandSource.AUTOMATION)
    await sleep(10)
    const ons = mqtt.published.filter((p) => p.payload.state === 'ON')
    assert(ons.length === 1, 'restore ON is dispatched instead of suppressed (incident regression)')

    //  Self-limiting: the restore consumed the marker, so no unbounded flood follows from a
    //  single unconfirmed command.
    assert(mqtt.published.length === 2, 'exactly one extra publish per unconfirmed command')
}

console.log('\n── B. A genuine state change resolves the doubt ──\n')
{
    const mqtt = new MockMqttService({ autoEcho: false })
    const plug = createPlug('Hallway Plug', mqtt)

    mqtt.simulateExternalMessage('Hallway Plug', { state: 'ON' })
    plug.receiveCommand('OFF', DeviceCommandSource.AUTOMATION)
    await sleep(TOKEN_EXPIRY_WAIT_MS)   //  OFF expires unconfirmed -> state unverified

    //  Now the device really reports the new state: independent evidence, marker cleared.
    mqtt.simulateExternalMessage('Hallway Plug', { state: 'OFF' })
    await sleep(10)

    //  Redundant OFF against a CONFIRMED cache must be suppressed again.
    plug.receiveCommand('OFF', DeviceCommandSource.AUTOMATION)
    await sleep(10)
    assert(mqtt.published.length === 1, 'confirmed state suppresses a redundant command again')
}

console.log('\n── C. Spam guarantee intact for healthy devices ──\n')
{
    const mqtt = new MockMqttService({ autoEcho: true })
    const plug = createPlug('Healthy Plug', mqtt)

    mqtt.simulateExternalMessage('Healthy Plug', { state: 'ON' })
    await sleep(10)

    //  A real command the device confirms via echo -- the cache is proven again.
    plug.receiveCommand('OFF', DeviceCommandSource.AUTOMATION)
    await sleep(40)
    assert(mqtt.published.length === 1, 'OFF reaches the wire on a healthy device')
    assert(plug.getStateLast()?.state === 'OFF', 'echo confirms the OFF -> cache proven')

    //  Re-asserting the same state is a genuine no-op and must stay suppressed.
    plug.receiveCommand('OFF', DeviceCommandSource.AUTOMATION)
    await sleep(20)
    assert(mqtt.published.length === 1, 'redundant OFF stays suppressed once the state is confirmed')

    plug.receiveCommand('OFF', DeviceCommandSource.AUTOMATION)
    await sleep(20)
    assert(mqtt.published.length === 1, 'repeated redundant OFFs keep being suppressed')
}

console.log('\n── D. Explicit bypass option ──\n')
{
    const mqtt = new MockMqttService({ autoEcho: true })
    const plug = createPlug('Bypass Plug', mqtt)

    mqtt.simulateExternalMessage('Bypass Plug', { state: 'ON' })
    await sleep(10)

    plug.receiveCommand('ON', DeviceCommandSource.AUTOMATION, { bypassNoOpSuppression: true })
    await sleep(10)
    assert(mqtt.published.length === 1 && mqtt.published[0].payload.state === 'ON',
        'bypassNoOpSuppression forces the command onto the wire despite a matching cache')
}


// ---------------------------------------------------------------------------
// E. Rule engine -- who gets to bypass
// ---------------------------------------------------------------------------

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'automaton-reassert-test-'))

/**
 * Write a YAML config into the temp dir and return its path.
 * @param {string} file - File name inside the temp dir
 * @param {string[]} lines - YAML source lines
 * @returns {string} Absolute path
 */
function writeConfig(file, lines) {
    const path = join(TEST_CONFIG_DIR, file)
    writeFileSync(path, lines.join('\n') + '\n')
    return path
}

/** Mechanism that records the dispatch options it was called with (no MQTT needed). */
class RecordingMechanism extends Mechanism {
    /**
     * @param {string} name - Device display name
     */
    constructor(name) {
        super(name, `test-id-${name.replace(/\s+/g, '-')}`, {})
        this.calls = []
    }

    /**
     * @param {*} payload - Command payload
     * @param {*} source - Command origin tag
     * @param {Object} [options] - Dispatch modifiers
     */
    receiveCommand(payload, source, options = {}) {
        this.calls.push({ payload, source, options })
    }

    /** No cached state -> cooldown check fails open. @returns {null} */
    getStateLast() { return null }

    /** Unknown origin -> cooldown check fails open. @returns {'unknown'} */
    getStateOrigin() { return 'unknown' }

    /** Never updated -> cooldown check fails open. @returns {null} */
    getStateLastAt() { return null }
}

let caseSeq = 0

/** Minimal concrete automation over the real base-class dispatch path. */
class TestReassertAutomation extends RuleBasedAutomationBase {
    /**
     * @param {string} configPath - Path to a YAML config file
     */
    constructor(configPath) {
        super({ name: `TestReassert${++caseSeq}`, configPath })
    }

    /**
     * Apply the first declared command for this target key.
     * @param {*} device - Resolved mechanism
     * @param {string} targetKey - Target key from the rule map
     * @param {{}[]} matchingRules - Matched rules
     * @returns {{payload?: *, skip?: boolean}} Command payload or explicit skip
     */
    resolveCommand(device, targetKey, matchingRules) {
        for (const rule of matchingRules) {
            const cmd = rule.targets?.[targetKey]
            if (cmd !== undefined) return { payload: cmd }
        }
        return { skip: true }
    }
}

/**
 * Register a device in the live container under its friendly name.
 * @param {string} name - Friendly name
 * @param {Object} dev - Device instance
 * @returns {Object} The registered device
 */
function register(name, dev) {
    Object.assign(DeviceContainer.getAll(), { [name]: dev })
    return dev
}

/** @param {RecordingMechanism} dev @returns {boolean|undefined} bypass flag of the last call */
function lastBypass(dev) {
    return dev.calls[dev.calls.length - 1]?.options?.bypassNoOpSuppression
}

console.log('\n── E. Rule engine dispatch flags ──\n')
{
    //  E1/E2: a plain rule -- natural run keeps the spam guarantee, forced run bypasses.
    const plain = register('Plain Plug', new RecordingMechanism('Plain Plug'))
    const cfgPlain = writeConfig('plain.yaml', [
        'rules:',
        "  - name: 'Restore lamps'",
        '    conditions:',
        '      hour: { gte: 0 }',
        '    targets:',
        '      Plain_Plug: ON'
    ])
    const autoPlain = new TestReassertAutomation(cfgPlain)
    await autoPlain.init()

    await autoPlain.execute({ trigger: 'timer' })
    assert(lastBypass(plain) === false, 'natural run dispatches WITHOUT the bypass')

    await autoPlain.execute({ trigger: 'HomeOfficeVideoAutomation', force: true })
    assert(lastBypass(plain) === true, 'forced run (player-gone hand-off) dispatches WITH the bypass')

    //  E3: reassert_state on a natural run.
    const flagged = register('Flagged Plug', new RecordingMechanism('Flagged Plug'))
    const cfgFlagged = writeConfig('flagged.yaml', [
        'rules:',
        "  - name: 'Restore lamps'",
        '    reassert_state: true',
        '    conditions:',
        '      hour: { gte: 0 }',
        '    targets:',
        '      Flagged_Plug: ON'
    ])
    const autoFlagged = new TestReassertAutomation(cfgFlagged)
    await autoFlagged.init()

    await autoFlagged.execute({ trigger: 'videoPlayer:htpc' })
    assert(lastBypass(flagged) === true,
        'reassert_state rule bypasses on a natural run (paused/stopped restore path)')

    //  E4: per-target scoping -- the flag of a rule that does NOT target a device must not
    //  leak onto that device.
    const owned = register('Owned Plug', new RecordingMechanism('Owned Plug'))
    const bystander = register('Bystander Plug', new RecordingMechanism('Bystander Plug'))
    const cfgScoped = writeConfig('scoped.yaml', [
        'rules:',
        "  - name: 'Restore lamps'",
        '    reassert_state: true',
        '    conditions:',
        '      hour: { gte: 0 }',
        '    targets:',
        '      Owned_Plug: ON',
        "  - name: 'Dim the rest'",
        '    conditions:',
        '      hour: { gte: 0 }',
        '    targets:',
        '      Bystander_Plug: OFF'
    ])
    const autoScoped = new TestReassertAutomation(cfgScoped)
    await autoScoped.init()

    await autoScoped.execute({ trigger: 'timer' })
    assert(lastBypass(owned) === true, 'reassert_state reaches the target of the flagged rule')
    assert(lastBypass(bystander) === false, 'reassert_state does NOT leak to other rules\' targets')
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F. Multi-channel echo matching + no-op suppression (dual switch / dimmer)
//    doc/ht-lights-bug.md "secondary finding #2" -- these devices used to leave every
//    automation token unconfirmed forever, which both defeated spam-suppression and kept
//    the unverified-state marker set permanently (the coupling with the re-assert fix).
// ---------------------------------------------------------------------------

console.log('\n── F. Multi-channel echo matching & no-op suppression ──\n')
{
    //  F1: a dual-switch ON now confirms via its suffixed report, so a redundant re-send is
    //  suppressed again (healthy device -> spam-safe), instead of expiring unconfirmed forever.
    const mqtt = new MockMqttService({ autoEcho: false })
    const sw = new DualSwitch('Ambient Switch', '0xamb', { channels: ['l1', 'l2'] })
    sw.setMqttService(mqtt)

    mqtt.simulateExternalMessage('Ambient Switch', { state_l1: 'OFF', state_l2: 'OFF' })
    await sleep(10)
    assert(sw.getStateLast()?.state_l1 === 'OFF', 'F1 cache seeded OFF/OFF by a suffixed report')

    sw.receiveCommand('ON', DeviceCommandSource.AUTOMATION)
    await sleep(20)
    assert(mqtt.published.length === 1 && mqtt.published[0].payload.state_l1 === 'ON' && mqtt.published[0].payload.state_l2 === 'ON',
        'F1 dual-switch ON fanned out to both channels')

    //  The device reports the combined state back -- suffixed fields only (what used to NEVER match).
    mqtt.simulateExternalMessage('Ambient Switch', { state_l1: 'ON', state_l2: 'ON' })
    await sleep(20)
    assert(sw.getStateOrigin() === 'automation', 'F1 own suffixed echo keeps origin=automation (confirmed, not human)')

    //  Now that the state is CONFIRMED, re-asserting the same state must be suppressed again.
    sw.receiveCommand('ON', DeviceCommandSource.AUTOMATION)
    await sleep(20)
    assert(mqtt.published.length === 1, 'F1 redundant multi-channel ON stays suppressed once its echo confirms')
}

{
    //  F2: a partial report (only one channel present) cannot prove the whole action landed, so it
    //  does NOT confirm the token; the next corrective command is dispatched rather than suppressed.
    const mqtt = new MockMqttService({ autoEcho: false })
    const sw = new DualSwitch('Partial Switch', '0xpar', { channels: ['l1', 'l2'] })
    sw.setMqttService(mqtt)

    mqtt.simulateExternalMessage('Partial Switch', { state_l1: 'OFF', state_l2: 'OFF' })
    await sleep(10)
    sw.receiveCommand('ON', DeviceCommandSource.AUTOMATION)
    await sleep(20)

    //  Only l1 reports back -- incomplete, so the no-op can't be proven from cache.
    mqtt.simulateExternalMessage('Partial Switch', { state_l1: 'ON' })
    await sleep(20)
    const before = mqtt.published.length
    sw.receiveCommand('ON', DeviceCommandSource.AUTOMATION)
    await sleep(20)
    assert(mqtt.published.length === before + 1, 'F2 partial report does not prove the no-op -> corrective ON is dispatched')
}

{
    //  F3: a dual-dimmer ON+brightness splits into two publishes; both correlate onto the STATE
    //  channels, so the suffixed state report confirms even though the brightness message registered last.
    const mqtt = new MockMqttService({ autoEcho: false })
    const dm = new DualDimmer('Ambient Dimmer', '0xdim', { channels: ['l1', 'l2'] })
    dm.setMqttService(mqtt)

    mqtt.simulateExternalMessage('Ambient Dimmer', { state_l1: 'OFF', state_l2: 'OFF' })
    await sleep(10)
    dm.receiveCommand({ state: 'ON', brightness: 80 }, DeviceCommandSource.AUTOMATION)
    await sleep(20)
    assert(mqtt.published.length === 2 && mqtt.published[0].payload.state_l1 === 'ON' && 'brightness_l1' in mqtt.published[1].payload,
        'F3 dimmer split into a state publish and a trailing brightness publish')

    //  The device reports its (state + level) back -- suffixed fields only.
    mqtt.simulateExternalMessage('Ambient Dimmer', { state_l1: 'ON', state_l2: 'ON', brightness_l1: 203, brightness_l2: 203 })
    await sleep(20)
    assert(dm.getStateOrigin() === 'automation', 'F3 dimmer echo confirms via STATE channels despite the trailing brightness token')

    //  Confirmed -> both sub-publishes of a redundant re-send are suppressed again.
    const before = mqtt.published.length
    dm.receiveCommand({ state: 'ON', brightness: 80 }, DeviceCommandSource.AUTOMATION)
    await sleep(20)
    assert(mqtt.published.length === before, 'F3 redundant dimmer ON+brightness stays suppressed once confirmed')
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)

