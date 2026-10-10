/**
 * DualSwitch / DualDimmer behavioral tests.
 * Covers command translation to zigbee2mqtt suffixed multi-channel payloads
 * (all-channel fan-out, per-channel targeting, unknown-channel rejection, legacy
 * fallback without channels), brightness percentage mapping against config
 * overrides / reported bounds / Zigbee defaults, and -- critically -- preservation
 * of YAML interaction routing for physical button presses so a wall switch keeps
 * routing its buttons through the shared interaction registry after being
 * reclassified from Remote to a dual switch mechanism. Also exercises the AI tool
 * dispatch path with the new channel/brightness parameters and suffix-aware state
 * filtering.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DualSwitch from '../src/device/type/dualswitch.js'
import DualDimmer from '../src/device/type/dualdimmer.js'
import Mechanism from '../src/device/type/mechanism.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import InteractionContainer from '../src/interaction/container/interactionContainer.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import ToolBuilder from '../src/ai/toolBuilder.js'
import MqttService from '../src/service/mqttService.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
import { slugify } from '../src/lib/string.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0

function assertEqual(actual, expected, label) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
        failed++
    }
}

function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

/** Minimal MQTT recorder -- captures publishes and fires meta.onPublish like SMQTTService drain does. */
class MockMqttService {
    constructor() { this.published = [] }
    getPrefix() { return 'zigbee2mqtt' }
    isConnected() { return true }
    publish(topic, payloadStr, options) {
        this.published.push({ topic, payload: typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr })
        const onPublishCb = options?.meta?.onPublish
        if (typeof onPublishCb === 'function') setTimeout(() => onPublishCb(), 0)
    }
    subscribe() {}
    reset() { this.published = [] }
}

const lastPublish = (mock) => mock.published[mock.published.length - 1] ?? null

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run fn with CacheService.setHumanCooldown spied (the singleton instance is frozen --
 * patch the class prototype instead); returns how many cooldown writes happened inside fn.
 */
async function countCooldownWrites(fn) {
    let writes = 0
    const proto = Object.getPrototypeOf(CacheService)
    const originalSet = proto.setHumanCooldown
    proto.setHumanCooldown = async function (...args) {
        writes++
        return originalSet.apply(this, args)
    }
    try {
        await fn()
    } finally {
        proto.setHumanCooldown = originalSet
    }
    return writes
}

// ---------------------------------------------------------------------------
console.log('\n── DualSwitch command translation ──\n')

{
    const sw = new DualSwitch('Wall Switch A', '0x1111', { channels: ['left', 'right'] })
    const mock = new MockMqttService()
    sw.setMqttService(mock)

    // Bare ON fans out to every configured channel in one combined payload.
    sw.receiveCommand('ON')
    assertEqual(lastPublish(mock)?.payload, { state_left: 'ON', state_right: 'ON' }, 'bare "ON" -> combined state_left/state_right payload')
    assert(lastPublish(mock)?.topic.endsWith('/Wall Switch A/set'), 'published on the device /set topic')

    // TOGGLE likewise targets all channels and is never redundancy-suppressed.
    mock.reset()
    sw.receiveCommand('TOGGLE')
    assertEqual(lastPublish(mock)?.payload, { state_left: 'TOGGLE', state_right: 'TOGGLE' }, '"TOGGLE" -> both channels toggled')

    // Per-channel object commands narrow scope after validation.
    mock.reset()
    sw.receiveCommand({ channel: 'left', state: 'OFF' })
    assertEqual(lastPublish(mock)?.payload, { state_left: 'OFF' }, '{channel:left,state:OFF} -> only state_left published')

    // Channel names are case-insensitive at the API boundary.
    mock.reset()
    sw.receiveCommand({ channel: 'RIGHT', state: 'ON' })
    assertEqual(lastPublish(mock)?.payload, { state_right: 'ON' }, 'uppercase channel name normalized to state_right')

    // Unknown channels warn + no-op instead of publishing garbage.
    mock.reset()
    sw.receiveCommand({ channel: 'middle', state: 'ON' })
    assertEqual(mock.published.length, 0, 'unknown channel dropped without publish')

    // States outside ON/OFF/TOGGLE (shutter vocabulary) are rejected on switches.
    mock.reset()
    sw.receiveCommand('OPEN')
    assertEqual(mock.published.length, 0, '"OPEN" not a valid switch command -- dropped')

    // Brightness is meaningless on non-dimmable dual switches.
    mock.reset()
    sw.receiveCommand({ brightness: 50 })
    assertEqual(mock.published.length, 0, 'brightness-only command dropped on plain DualSwitch')
}

{
    // No declared topology -> legacy single-state behavior keeps working.
    const bare = new DualSwitch('Bare Switch', '0x1234', {})
    const mock = new MockMqttService()
    bare.setMqttService(mock)
    bare.receiveCommand('ON')
    assertEqual(lastPublish(mock)?.payload, { state: 'ON' }, 'channel-less dual switch falls back to generic {state} payload')

// ---------------------------------------------------------------------------
console.log('\n── DualDimmer brightness mapping ──\n')

{
    // Config override on l1 ([54,254]); l2 has no override -> defaults [1,254].
    const dm = new DualDimmer('Dimmer A', '0x2222', { channels: ['l1', 'l2'], brightness_range: { l1: [54, 254] } })
    const mock = new MockMqttService()
    dm.setMqttService(mock)

    // 50% of [54..254] = 54 + 0.5*200 = 154
    dm.receiveCommand({ channel: 'l1', brightness: 50 })
    assertEqual(lastPublish(mock)?.payload, { brightness_l1: 154 }, '50% maps into config override range [54,254] -> level 154')

    // 100% of default [1..254] = 254; only the targeted channel is touched.
    mock.reset()
    dm.receiveCommand({ channel: 'l2', brightness: 100 })
    assertEqual(lastPublish(mock)?.payload, { brightness_l2: 254 }, '100% on unconfigured channel uses full Zigbee range -> 254')

    // All-channel dimming applies each channel's own bounds independently.
    mock.reset()
    dm.receiveCommand({ brightness: 50 })
    assertEqual(lastPublish(mock)?.payload, { brightness_l1: 154, brightness_l2: 128 }, 'all-channel 50% respects per-channel ranges (154 / 128)')

    // State + brightness are split into two sequential publishes (state first, then
    // brightness) because the Tuya/AVATTO converter drops combined payloads.
    mock.reset()
    dm.receiveCommand({ channel: 'l1', state: 'ON', brightness: 10 })
    assertEqual(mock.published.length, 2, 'state+brightness split into two sequential publishes')
    assertEqual(mock.published[0]?.payload, { state_l1: 'ON' }, 'first publish is state-only')
    assertEqual(mock.published[1]?.payload, { brightness_l1: 74 }, 'second publish is brightness-only (10% of [54,254] = 74)')
}

{
    // Device-reported bounds win over defaults when sane...
    const rep = new DualDimmer('Dimmer B', '0x3333', { channels: ['l1', 'l2'] })
    await rep.setCachedState({ min_brightness_l2: 1, max_brightness_l2: 100 })
    const mock = new MockMqttService()
    rep.setMqttService(mock)

    // 10% of [1..100] = round(1 + 9.9) = 11
    rep.receiveCommand({ channel: 'l2', brightness: 10 })
    assertEqual(lastPublish(mock)?.payload, { brightness_l2: 11 }, 'reported bounds [1,100] used -> level 11 at 10%')

    // ...but degenerate reported ranges (min == max) fall back to the full range.
    const deg = new DualDimmer('Degenerate Dimmer', '0x4444', { channels: ['l1'] })
    await deg.setCachedState({ min_brightness_l1: 54, max_brightness_l1: 54 })
    const mockD = new MockMqttService()
    deg.setMqttService(mockD)
    deg.receiveCommand({ channel: 'l1', brightness: 50 })
    assertEqual(lastPublish(mockD)?.payload, { brightness_l1: 128 }, 'degenerate 54/54 metadata ignored -> default range gives 128')
}

// ---------------------------------------------------------------------------
console.log('\n── SET_BRIGHTNESS sentinel & split-publish behavior ──\n')

{
    const dm = new DualDimmer('Dimmer A', '0x7777', { channels: ['l1', 'l2'], brightness_range: { l1: [54, 254] } })
    const mock = new MockMqttService()
    dm.setMqttService(mock)

    // The model learned the SET_BRIGHTNESS verb from our own log lines; it is
    // accepted as "brightness only, leave state alone" and published as a single
    // brightness payload (no state field).
    dm.receiveCommand({ action: 'SET_BRIGHTNESS', channel: 'l1', brightness: 50 })
    assertEqual(mock.published.length, 1, 'SET_BRIGHTNESS + brightness -> single brightness-only publish')
    assertEqual(lastPublish(mock)?.payload, { brightness_l1: 154 }, 'SET_BRIGHTNESS maps to brightness_l1 (50% of [54,254] = 154), no state field')

    // A bare SET_BRIGHTNESS with no brightness has nothing to apply -> dropped.
    mock.reset()
    dm.receiveCommand({ action: 'SET_BRIGHTNESS' })
    assertEqual(mock.published.length, 0, 'bare SET_BRIGHTNESS (no brightness) dropped without publish')

    // ON + brightness splits into two sequential publishes: state first, then brightness.
    mock.reset()
    dm.receiveCommand({ action: 'ON', channel: 'l1', brightness: 50 })
    assertEqual(mock.published.length, 2, 'ON + brightness split into two sequential publishes')
    assertEqual(mock.published[0]?.payload, { state_l1: 'ON' }, 'ON + brightness: first publish is state-only')
    assertEqual(mock.published[1]?.payload, { brightness_l1: 154 }, 'ON + brightness: second publish is brightness-only')

    // The sentinel also works via the `state` key (not just `action`).
    mock.reset()
    dm.receiveCommand({ state: 'SET_BRIGHTNESS', channel: 'l2', brightness: 100 })
    assertEqual(mock.published.length, 1, 'state:SET_BRIGHTNESS + brightness -> single brightness-only publish')
    assertEqual(lastPublish(mock)?.payload, { brightness_l2: 254 }, 'state:SET_BRIGHTNESS maps to brightness_l2 (100% of [1,254] = 254)')
}

// ---------------------------------------------------------------------------
console.log('\n── Per-channel brightness maps ──\n')

{
    const dm = new DualDimmer('Dimmer A', '0x5555', { channels: ['l1', 'l2'], brightness_range: { l1: [54, 254] } })
    const mock = new MockMqttService()
    dm.setMqttService(mock)

    // Per-channel map: state ON to both mapped channels first, then per-channel levels.
    dm.receiveCommand({ state: 'ON', brightness: { l1: 50, l2: 25 } })
    assertEqual(mock.published.length, 2, 'per-channel map splits into state + brightness publishes')
    assertEqual(mock.published[0]?.payload, { state_l1: 'ON', state_l2: 'ON' }, 'state publish covers both mapped channels')
    assertEqual(mock.published[1]?.payload, { brightness_l1: 154, brightness_l2: 64 }, 'per-channel levels: 50% of [54,254]=154, 25% of [1,254]=64')

    // Positional aliases (ONE/TWO) resolve inside the map too.
    mock.reset()
    dm.receiveCommand({ state: 'ON', brightness: { ONE: 100, TWO: 0 } })
    assertEqual(mock.published[1]?.payload, { brightness_l1: 254, brightness_l2: 1 }, 'ONE/TWO aliases resolve in the map (254 / 1)')

    // Partial map: only the mapped channels are touched, state included.
    mock.reset()
    dm.receiveCommand({ state: 'ON', brightness: { l2: 25 } })
    assertEqual(mock.published[0]?.payload, { state_l2: 'ON' }, 'partial map: state only on the mapped channel')
    assertEqual(mock.published[1]?.payload, { brightness_l2: 64 }, 'partial map: brightness only on the mapped channel')

    // SET_BRIGHTNESS + per-channel map -> single brightness-only publish (state untouched).
    mock.reset()
    dm.receiveCommand({ action: 'SET_BRIGHTNESS', brightness: { l1: 50, l2: 25 } })
    assertEqual(mock.published.length, 1, 'SET_BRIGHTNESS + map -> single brightness-only publish')
    assertEqual(lastPublish(mock)?.payload, { brightness_l1: 154, brightness_l2: 64 }, 'map levels published without state fields')

    // Unknown channel in the map -> whole command dropped.
    mock.reset()
    dm.receiveCommand({ state: 'ON', brightness: { l1: 50, l3: 25 } })
    assertEqual(mock.published.length, 0, 'unknown channel in the map dropped without publish')

    // Out-of-range value in the map -> whole command dropped.
    mock.reset()
    dm.receiveCommand({ state: 'ON', brightness: { l1: 50, l2: 150 } })
    assertEqual(mock.published.length, 0, 'out-of-range value in the map dropped without publish')

    // Empty map -> nothing to apply, dropped.
    mock.reset()
    dm.receiveCommand({ state: 'ON', brightness: {} })
    assertEqual(mock.published.length, 0, 'empty map dropped without publish')

    // A map plus an explicit single-channel key is ambiguous -> dropped.
    mock.reset()
    dm.receiveCommand({ channel: 'l1', state: 'ON', brightness: { l1: 50, l2: 25 } })
    assertEqual(mock.published.length, 0, 'channel key + per-channel map is ambiguous and dropped')
}

// ---------------------------------------------------------------------------
console.log('\n── Channel alias resolution (ONE/TWO vocabulary) ──\n')

{
    const sw = new DualSwitch('Wall Switch A', '0x1111', { channels: ['left', 'right'] })
    const mock = new MockMqttService()
    sw.setMqttService(mock)

    // Positional aliases map by declaration order: ONE -> first channel, TWO -> second.
    sw.receiveCommand({ channel: 'ONE', state: 'ON' })
    assertEqual(lastPublish(mock)?.payload, { state_left: 'ON' }, 'channel ONE -> first declared channel (left)')

    mock.reset()
    sw.receiveCommand({ channel: 'TWO', state: 'OFF' })
    assertEqual(lastPublish(mock)?.payload, { state_right: 'OFF' }, 'channel TWO -> second declared channel (right)')

    // Numeric aliases and mixed case work too.
    mock.reset()
    sw.receiveCommand({ channel: '2', state: 'TOGGLE' })
    assertEqual(lastPublish(mock)?.payload, { state_right: 'TOGGLE' }, 'numeric alias "2" -> second channel')

    mock.reset()
    sw.receiveCommand({ channel: 'One', state: 'ON' })
    assertEqual(lastPublish(mock)?.payload, { state_left: 'ON' }, 'mixed-case "One" -> first channel')

    // Raw wire names keep working as identity aliases.
    mock.reset()
    sw.receiveCommand({ channel: 'right', state: 'ON' })
    assertEqual(lastPublish(mock)?.payload, { state_right: 'ON' }, 'raw wire name still accepted')

    // A positional alias beyond the declared topology is rejected.
    const sw3 = new DualSwitch('Single Channel', '0x9999', { channels: ['l1'] })
    const mock3 = new MockMqttService()
    sw3.setMqttService(mock3)
    sw3.receiveCommand({ channel: 'TWO', state: 'ON' })
    assertEqual(mock3.published.length, 0, 'TWO on a single-channel device dropped without publish')
}

// ---------------------------------------------------------------------------
console.log('\n── DualSwitch button routing via the interaction registry ──\n')

{
    // Self-contained regression coverage for the Remote->DualSwitch reclassification: no production
    // YAML is loaded. We register one synthetic, neutrally-named interaction through the same factory
    // used for discovered configs, wire two target outlets to mock MQTT recorders, and verify the
    // routing/debounce contract generically -- which outlet each action drives is arbitrary; only that
    // the registry routes it correctly matters.
    const SWITCH_NAME = 'Test Wall Switch'
    const OUTLET_A = 'Outlet A'
    const OUTLET_B = 'Outlet B'

    const outletA = new Mechanism(OUTLET_A, '0xaaaa', {})
    const outletB = new Mechanism(OUTLET_B, '0xbbbb', {})
    const mockA = new MockMqttService()
    const mockB = new MockMqttService()
    outletA.setMqttService(mockA)
    outletB.setMqttService(mockB)
    Object.assign(DeviceContainer.getAll(), { [OUTLET_A]: outletA, [OUTLET_B]: outletB })

    InteractionContainer.registerInteractionConfig({
        name: slugify(SWITCH_NAME),
        actions: [
            { type: 'single_right', targets: [{ device: OUTLET_A, command: 'TOGGLE' }] },
            { type: 'double_right', targets: [{ device: OUTLET_B, command: 'TOGGLE' }] }
        ]
    })
    assert(InteractionContainer.getInteraction(slugify(SWITCH_NAME)) !== null, 'synthetic interaction registered under the slugified switch name')

    // The wall switch itself -- a DualSwitch (the reclassified mechanism keeps this routing path).
    const sw = new DualSwitch(SWITCH_NAME, '0xcccc', { channels: ['left', 'right'] })
    sw.setMqttService(new MockMqttService())

    const pressAction = async (action) => {
        sw.handleMqttMessage({ topic: `zigbee2mqtt/${SWITCH_NAME}`, message: JSON.stringify({ action }) })
        await new Promise((r) => setTimeout(r, 50))
    }

    // Single right -> exactly its bound outlet toggles; the other outlet is untouched.
    await pressAction('single_right')
    assertEqual(lastPublish(mockA)?.payload, { state: 'TOGGLE' }, 'single_right routes to its bound outlet via the registry')
    assertEqual(mockB.published.length, 0, 'single_right does not touch the unbound outlet')

    // Double right -> exactly its (other) bound outlet toggles. (Wait past the deliberate 800ms
    // per-instance debounce window -- same protection Remote applies today.)
    mockA.reset(); mockB.reset()
    await new Promise((r) => setTimeout(r, 900))
    await pressAction('double_right')
    assertEqual(lastPublish(mockB)?.payload, { state: 'TOGGLE' }, 'double_right routes to its bound outlet via the registry')
    assertEqual(mockA.published.length, 0, 'double_right does not touch the unbound outlet')

    // Unmapped actions are ignored without crashing or dispatching anything.
    mockA.reset(); mockB.reset()
    await new Promise((r) => setTimeout(r, 900))
    await pressAction('triple_left')
    assertEqual(mockA.published.length + mockB.published.length, 0, 'unmapped action type dispatches nothing')

    // The switch report itself is still cached through the mechanism path (same as Remote did).
    assert(sw.getStateLast()?.action === 'triple_left', 'button reports are still cached via super.handleMqttMessage')

    // Debounce: rapid duplicate presses within the window route only once.
    const debounced = new DualSwitch(SWITCH_NAME, '0xcccc', { channels: ['left', 'right'] })
    debounced.setMqttService(new MockMqttService())
    mockA.reset()
    debounced.handleMqttMessage({ topic: `zigbee2mqtt/${SWITCH_NAME}`, message: JSON.stringify({ action: 'single_right' }) })
    debounced.handleMqttMessage({ topic: `zigbee2mqtt/${SWITCH_NAME}`, message: JSON.stringify({ action: 'single_right' }) })
    await new Promise((r) => setTimeout(r, 50))
    assertEqual(mockA.published.length, 1, 'rapid double event within debounce window routes exactly once')
}
}

// ---------------------------------------------------------------------------
console.log('\n── AI tool dispatch (channel/brightness params) ──\n')

{
    // Register a live dual dimmer in the device registry for name resolution.
    const aiDimmer = new DualDimmer('Dimmer A', '0x5555', { channels: ['l1', 'l2'], brightness_range: { l1: [54, 254] } })
    const mockAI = new MockMqttService()
    aiDimmer.setMqttService(mockAI)
    Object.assign(DeviceContainer.getAll(), { 'Dimmer A': aiDimmer })

    // Native function-call shape with the positional channel vocabulary -> mapped suffixed payload.
    const result1 = JSON.parse(await ToolBuilder.execute({
        function: { name: 'set_device_state', arguments: JSON.stringify({ device_name: 'dimmer a', channel: 'ONE', brightness: 50 }) }
    }))
    assertEqual(result1.status, 'sent', 'tool call reports sent status')
    assertEqual(lastPublish(mockAI)?.payload, { brightness_l1: 154 }, 'AI channel ONE + brightness reaches device as mapped brightness_l1=154')

    // The second positional channel maps to the second wire channel.
    mockAI.reset()
    await ToolBuilder.execute({
        function: { name: 'set_device_state', arguments: JSON.stringify({ device_name: 'dimmer a', channel: 'TWO', brightness: 100 }) }
    })
    assertEqual(lastPublish(mockAI)?.payload, { brightness_l2: 254 }, 'AI channel TWO reaches device as brightness_l2=254')

    // Unknown channel (beyond the ONE/TWO enum, e.g. from a loose parser) returns
    // an honest error to the model instead of a silent drop.
    mockAI.reset()
    const badResult = JSON.parse(await ToolBuilder.execute({
        function: { name: 'set_device_state', arguments: JSON.stringify({ device_name: 'dimmer a', channel: 'MIDDLE', state: 'ON' }) }
    }))
    assert(typeof badResult.error === 'string' && badResult.error.includes('Unknown channel'), 'unknown channel returns honest error to the model')
    assertEqual(mockAI.published.length, 0, 'unknown channel published nothing')

    // TOGGLE action now allowed by schema and fanned out across all channels.
    const aiSwitch = new DualSwitch('Wall Switch A', '0x6666', { channels: ['left', 'right'] })
    const mockAISw = new MockMqttService()
    aiSwitch.setMqttService(mockAISw)
    Object.assign(DeviceContainer.getAll(), { 'Wall Switch A': aiSwitch })

    await ToolBuilder.execute({
        function: { name: 'set_device_state', arguments: JSON.stringify({ device_name: 'wall switch a', action: 'TOGGLE' }) }
    })
    assertEqual(lastPublish(mockAISw)?.payload, { state_left: 'TOGGLE', state_right: 'TOGGLE' }, 'bare AI TOGGLE fans out to both switch channels')

    // Text-intent path (small models): loose pseudo-call with the positional
    // channel vocabulary survives parsing and normalization.
    const intents = ToolBuilder.parseJsonIntent('set_device_state(device_name:"Dimmer A", channel:two, brightness:80)')
    assert(intents !== null && intents.length === 1, 'loose text intent parsed into one record')
    if (intents?.length === 1) {
        assertEqual(intents[0].channel, 'TWO', 'text intent normalizes channel to positional TWO')
        assertEqual(intents[0].brightness, 80, 'text intent preserves brightness field')
    }

    // get_device_state must expose per-channel fields under the positional
    // vocabulary (state_one/brightness_one) with brightness in percent, while
    // stripping noise. Stub the cache read so this tests the filter, not Redis.
    const aiState = { state_l1: 'ON', brightness_l1: 180, linkquality: 99, last_seen: new Date().toISOString() }
    aiDimmer.getCachedState = async () => ({ stateLast: aiState, stateLastAt: new Date().toISOString(), stateOrigin: 'human' })
    const readResult = JSON.parse(await ToolBuilder.execute({
        function: { name: 'get_device_state', arguments: JSON.stringify({ device_name: 'dimmer a' }) }
    }))
    assert(readResult.state?.state_one === 'ON', 'AI state view renames state_l1 -> state_one')
    assert(!('state_l1' in (readResult.state ?? {})), 'wire-suffixed key not leaked into AI state view')
    // 180 in [54..254] -> round((180-54)/200*100) = 63%
    assertEqual(readResult.state?.brightness_one, 63, 'AI state view converts raw level to percent via channel range')
    assert(!('linkquality' in (readResult.state ?? {})), 'noise fields still stripped from AI state view')
}

// ---------------------------------------------------------------------------
console.log('\n── Origin tracking & human-interaction detection ──\n')

{
    // A) Human-directed command on a dual switch: inherited Mechanism machinery must
    //    still mark origin human immediately at publish time and start the Redis
    //    cooldown -- payload shape (suffixed fan-out) must not matter here.
    const swH = new DualSwitch('Wall Switch A', '0xh1', { channels: ['left', 'right'] })
    swH.setMqttService(new MockMqttService())
    const writesA = await countCooldownWrites(async () => {
        swH.receiveCommand('TOGGLE')
        await sleep(30) // let meta.onPublish fire -> cancelAll + writeHumanCooldown
    })
    assertEqual(swH.getStateOrigin(), 'human', 'HUMAN command on dual switch marks origin human at dispatch')
    assert(writesA >= 1, `HUMAN command wrote the automation cooldown (${writesA} writes)`)
}

{
    // B) Physical flip of one channel is detected as human interaction even though the
    //    report only carries suffixed fields (the #didStateChange regression fix).
    const swB = new DualSwitch('Lazienka Wlacznik', '0xb1', { channels: ['left', 'right'] })
    swB.setMqttService(new MockMqttService())
    await swB.setCachedState({ state_left: 'ON', state_right: 'OFF' }, { origin: 'automation' })

    const writesB = await countCooldownWrites(async () => {
        swB.handleMqttMessage({ topic: 'zigbee2mqtt/Lazienka Wlacznik', message: JSON.stringify({ state_left: 'OFF', state_right: 'OFF' }) })
        await sleep(30)
    })
    assertEqual(swB.getStateOrigin(), 'human', 'physical left-channel flip classified as HUMAN despite suffixed-only payload')
    assert(writesB >= 1, `channel flip started the automation cooldown (${writesB} writes)`)

    // Brightness variant on a dimmer: a real level change counts...
    const dmB = new DualDimmer('Dimmer A', '0xb2', { channels: ['l1', 'l2'] })
    dmB.setMqttService(new MockMqttService())
    await dmB.setCachedState({ brightness_l1: 180 }, { origin: 'automation' })
    const writesB2 = await countCooldownWrites(async () => {
        dmB.handleMqttMessage({ topic: 'zigbee2mqtt/Dimmer A', message: JSON.stringify({ brightness_l1: 90 }) })
        await sleep(30)
    })
    assertEqual(dmB.getStateOrigin(), 'human', 'brightness_l1 change (180 -> 90) classified as HUMAN')
    assert(writesB2 >= 1, `brightness change started the cooldown (${writesB2} writes)`)

    // ...but bridge jitter within tolerance does NOT read as input.
    const dmC = new DualDimmer('Dimmer B', '0xb3', { channels: ['l1', 'l2'] })
    dmC.setMqttService(new MockMqttService())
    await dmC.setCachedState({ brightness_l1: 180 }, { origin: 'automation' })
    const writesC = await countCooldownWrites(async () => {
        dmC.handleMqttMessage({ topic: 'zigbee2mqtt/Dimmer B', message: JSON.stringify({ brightness_l1: 179 }) })
        await sleep(30)
    })
    assertEqual(dmC.getStateOrigin(), 'automation', 'jitter-sized brightness delta stays automation (no false human mark)')
    assertEqual(writesC, 0, 'jitter-sized delta wrote no cooldown')
}

{
    // C) Button action reports on a dual switch keep parity with plain wall switches:
    //    an event payload against a cached suffixed state counts as interaction...
    const swD = new DualSwitch('Wall Switch B', '0xd1', { channels: ['left', 'right'] })
    swD.setMqttService(new MockMqttService())
    await swD.setCachedState({ state_left: 'ON', state_right: 'OFF' }, { origin: 'automation' })
    const writesD = await countCooldownWrites(async () => {
        swD.handleMqttMessage({ topic: 'zigbee2mqtt/Wall Switch B', message: JSON.stringify({ action: 'single_right' }) })
        await sleep(30)
    })
    assertEqual(swD.getStateOrigin(), 'human', 'button press report classified as HUMAN (parity with plain switches)')
    assert(writesD >= 1, `button press started the cooldown (${writesD} writes)`)

    // ...while an identical periodic re-advertisement adds nothing.
    const writesE = await countCooldownWrites(async () => {
        swD.handleMqttMessage({ topic: 'zigbee2mqtt/Wall Switch B', message: JSON.stringify({ action: 'single_right' }) })
        await sleep(30)
    })
    assertEqual(writesE, 0, 'identical periodic report wrote no additional cooldown')
}

{
    // D) Automation-driven command + its own suffixed echo stays AUTOMATION. The suffixed report
    //    ({state_left/state_right}) is a real echo match now (CommandCorrelator channel matching), so
    //    origin stays automation AND a redundant re-send would be suppressed again -- pinned here so the
    //    multi-channel confirm/suppress path cannot silently regress (doc/ht-lights-bug.md, finding #2).
    const swF = new DualSwitch('Wall Switch A', '0xf1', { channels: ['left', 'right'] })
    const mockF = new MockMqttService()
    swF.setMqttService(mockF)
    await swF.setCachedState({ state_left: 'OFF', state_right: 'OFF' }, { origin: 'unknown' })

    const writesF = await countCooldownWrites(async () => {
        swF.receiveCommand('ON', DeviceCommandSource.AUTOMATION)
        await sleep(30) // _onPublish: register instant token, origin=automation
        assertEqual(swF.getStateOrigin(), 'automation', 'AUTOMATION dispatch marks origin automation immediately')
        // z2m echoes the combined state back -- suffixed fields only.
        swF.handleMqttMessage({ topic: 'zigbee2mqtt/Wall Switch A', message: JSON.stringify({ state_left: 'ON', state_right: 'ON' }) })
        await sleep(30)
        // Identical periodic re-advertisement right after.
        swF.handleMqttMessage({ topic: 'zigbee2mqtt/Wall Switch A', message: JSON.stringify({ state_left: 'ON', state_right: 'ON' }) })
        await sleep(30)
    })
    assertEqual(lastPublish(mockF)?.payload, { state_left: 'ON', state_right: 'ON' }, 'AUTOMATION ON fanned out to both channels')
    assertEqual(swF.getStateOrigin(), 'automation', 'own echo + periodic tail stay AUTOMATION inside the token window')
    assertEqual(writesF, 0, 'no human cooldown written for an automation round-trip')
}

// ---------------------------------------------------------------------------
console.log('\n── MQTT dedup signature for suffixed payloads (regression) ──\n')

{
    // Regression: multi-channel devices report ONLY suffixed keys (state_l1,
    // brightness_l2, ...). The real MQTT service's dedup signature must include
    // them -- otherwise the signature is always "{}" and every report after the
    // first within the 300ms window is silently discarded, so the device cache
    // (and the AI's state view) never updates.
    const fake = {
        connected: true,
        published: [],
        publish(topic, payload, options) { this.published.push({ topic, payload, options }) },
        on(event, handler) { ;(this.handlers ??= {})[event] = handler; return this },
        emit(event, ...args) { this.handlers?.[event]?.(...args) },
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
    setImmediate(() => fake.emit('connect'))

    await MqttService.init({ connectFn: () => fake })

    const received = []
    MqttService.subscribe('zigbee2mqtt/Dimmer A', (topic, message) => received.push(message))
    await sleep(10) // let the subscription callback register

    const emit = (obj) => fake.emit('message', 'zigbee2mqtt/Dimmer A', Buffer.from(JSON.stringify(obj)))

    // Identical report twice within the dedupe window -> delivered exactly once.
    emit({ state_l1: 'ON', state_l2: 'OFF', brightness_l1: 120, brightness_l2: 200 })
    emit({ state_l1: 'ON', state_l2: 'OFF', brightness_l1: 120, brightness_l2: 200 })
    await sleep(20)
    assertEqual(received.length, 1, 'identical suffixed report deduped within the window')

    // A changed report must NOT be deduped against the previous one.
    emit({ state_l1: 'OFF', state_l2: 'OFF', brightness_l1: 120, brightness_l2: 200 })
    await sleep(20)
    assertEqual(received.length, 2, 'changed suffixed report delivered (signature includes channel fields)')

    // A third identical report is deduped again against the latest signature.
    emit({ state_l1: 'OFF', state_l2: 'OFF', brightness_l1: 120, brightness_l2: 200 })
    await sleep(20)
    assertEqual(received.length, 2, 'repeated changed report deduped against the latest signature')

    await MqttService.disconnect()
}

// ---------------------------------------------------------------------------
const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)