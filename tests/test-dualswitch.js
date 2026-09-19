/**
 * DualSwitch / DualDimmer behavioral tests.
 * Covers command translation to zigbee2mqtt suffixed multi-channel payloads
 * (all-channel fan-out, per-channel targeting, unknown-channel rejection, legacy
 * fallback without channels), brightness percentage mapping against config
 * overrides / reported bounds / Zigbee defaults, and -- critically -- preservation
 * of YAML interaction routing for physical button presses so Kuchnia Wlacznik
 * Jadalnia keeps driving kitchen outlets through its right button after being
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
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'

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
    const sw = new DualSwitch('Kuchnia Wlacznik Zlew', '0x1111', { channels: ['left', 'right'] })
    const mock = new MockMqttService()
    sw.setMqttService(mock)

    // Bare ON fans out to every configured channel in one combined payload.
    sw.receiveCommand('ON')
    assertEqual(lastPublish(mock)?.payload, { state_left: 'ON', state_right: 'ON' }, 'bare "ON" -> combined state_left/state_right payload')
    assert(lastPublish(mock)?.topic.endsWith('/Kuchnia Wlacznik Zlew/set'), 'published on the device /set topic')

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
    const dm = new DualDimmer('Salon Ambient', '0x2222', { channels: ['l1', 'l2'], brightness_range: { l1: [54, 254] } })
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

    // State + brightness combine into one payload for the same channel.
    mock.reset()
    dm.receiveCommand({ channel: 'l1', state: 'ON', brightness: 10 })
    const combined = lastPublish(mock)?.payload ?? {}
    assert(combined.state_l1 === 'ON' && Number.isInteger(combined.brightness_l1), 'state+brightness combined into single suffixed payload')
}

{
    // Device-reported bounds win over defaults when sane...
    const rep = new DualDimmer('Salon Swiatlo', '0x3333', { channels: ['l1', 'l2'] })
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
console.log('\n── Kuchnia Wlacznik Jadalnia button routing (regression) ──\n')

{
    // Load the real YAML interaction registry -- kuchnia_wlacznik_jadalnia maps
    // single_right -> Kuchnia Gniazdo TOGGLE and double_right -> Kuchnia Gniazdo LED TOGGLE.
    await InteractionContainer.init()
    assert(InteractionContainer.getInteraction('kuchnia_wlacznik_jadalnia') !== null, 'kuchnia_wlacznik_jadalnia interaction registered from YAML')

    // Target outlets as plain mechanisms wired to their own MQTT recorders.
    const gniazdo = new Mechanism('Kuchnia Gniazdo', '0xaaaa', {})
    const gniazdoLed = new Mechanism('Kuchnia Gniazdo LED', '0xbbbb', {})
    const mockGniazdo = new MockMqttService()
    const mockGniazdoLed = new MockMqttService()
    gniazdo.setMqttService(mockGniazdo)
    gniazdoLed.setMqttService(mockGniazdoLed)
    Object.assign(DeviceContainer.getAll(), {
        'Kuchnia Gniazdo': gniazdo,
        'Kuchnia Gniazdo LED': gniazdoLed
    })

    // The wall switch itself -- now a DualSwitch instead of the old Remote.
    const jadalnia = new DualSwitch('Kuchnia Wlacznik Jadalnia', '0xcccc', { channels: ['left', 'right'] })
    const mockJad = new MockMqttService()
    jadalnia.setMqttService(mockJad)

    const pressAction = async (action) => {
        jadalnia.handleMqttMessage({
            topic: 'zigbee2mqtt/Kuchnia Wlacznik Jadalnia',
            message: JSON.stringify({ action })
        })
        await new Promise((r) => setTimeout(r, 50))
    }

    // Single right press -> kitchen socket toggles, exactly as before the reclassification.
    await pressAction('single_right')
    assertEqual(lastPublish(mockGniazdo)?.payload, { state: 'TOGGLE' }, 'single_right still toggles Kuchnia Gniazdo via interaction registry')
    assertEqual(mockGniazdoLed.published.length, 0, 'single_right does not touch the LED outlet')

    // Double right press -> LED outlet toggles. (Wait past the deliberate 800ms
    // per-instance debounce window -- same protection Remote applies today.)
    mockGniazdo.reset(); mockGniazdoLed.reset()
    await new Promise((r) => setTimeout(r, 900))
    await pressAction('double_right')
    assertEqual(lastPublish(mockGniazdoLed)?.payload, { state: 'TOGGLE' }, 'double_right still toggles Kuchnia Gniazdo LED')
    assertEqual(mockGniazdo.published.length, 0, 'double_right does not touch the plain socket')

    // Unmapped actions are ignored without crashing or dispatching anything.
    mockGniazdo.reset(); mockGniazdoLed.reset()
    await new Promise((r) => setTimeout(r, 900))
    await pressAction('triple_left')
    assertEqual(mockGniazdo.published.length + mockGniazdoLed.published.length, 0, 'unmapped action type dispatches nothing')

    // The switch report itself is still cached through the mechanism path (same as Remote did).
    assert(jadalnia.getStateLast()?.action === 'triple_left', 'button reports are still cached via super.handleMqttMessage')

    // Debounce: rapid duplicate presses within the window route only once.
    const debounced = new DualSwitch('Kuchnia Wlacznik Jadalnia', '0xcccc', { channels: ['left', 'right'] })
    debounced.setMqttService(new MockMqttService())
    mockGniazdo.reset()
    debounced.handleMqttMessage({ topic: 'zigbee2mqtt/Kuchnia Wlacznik Jadalnia', message: JSON.stringify({ action: 'single_right' }) })
    debounced.handleMqttMessage({ topic: 'zigbee2mqtt/Kuchnia Wlacznik Jadalnia', message: JSON.stringify({ action: 'single_right' }) })
    await new Promise((r) => setTimeout(r, 50))
    assertEqual(mockGniazdo.published.length, 1, 'rapid double event within debounce window routes exactly once')
}
}

// ---------------------------------------------------------------------------
console.log('\n── AI tool dispatch (channel/brightness params) ──\n')

{
    // Register a live dual dimmer in the device registry for name resolution.
    const aiDimmer = new DualDimmer('Salon Ambient', '0x5555', { channels: ['l1', 'l2'], brightness_range: { l1: [54, 254] } })
    const mockAI = new MockMqttService()
    aiDimmer.setMqttService(mockAI)
    Object.assign(DeviceContainer.getAll(), { 'Salon Ambient': aiDimmer })

    // Native function-call shape with channel + brightness -> mapped suffixed payload.
    const result1 = JSON.parse(await ToolBuilder.execute({
        function: { name: 'set_device_state', arguments: JSON.stringify({ device_name: 'salon ambient', channel: 'L1', brightness: 50 }) }
    }))
    assertEqual(result1.status, 'sent', 'tool call reports sent status')
    assertEqual(lastPublish(mockAI)?.payload, { brightness_l1: 154 }, 'AI channel+brightness reaches device as mapped brightness_l1=154')

    // TOGGLE action now allowed by schema and fanned out across all channels.
    const aiSwitch = new DualSwitch('Kuchnia Wlacznik Zlew', '0x6666', { channels: ['left', 'right'] })
    const mockAISw = new MockMqttService()
    aiSwitch.setMqttService(mockAISw)
    Object.assign(DeviceContainer.getAll(), { 'Kuchnia Wlacznik Zlew': aiSwitch })

    await ToolBuilder.execute({
        function: { name: 'set_device_state', arguments: JSON.stringify({ device_name: 'kuchnia wlacznik zlew', action: 'TOGGLE' }) }
    })
    assertEqual(lastPublish(mockAISw)?.payload, { state_left: 'TOGGLE', state_right: 'TOGGLE' }, 'bare AI TOGGLE fans out to both switch channels')

    // Text-intent path (small models): loose pseudo-call with channel/brightness survives parsing.
    const intents = ToolBuilder.parseJsonIntent('set_device_state(device_name:"Salon Ambient", channel:l2, brightness:80)')
    assert(intents !== null && intents.length === 1, 'loose text intent parsed into one record')
    if (intents?.length === 1) {
        assertEqual(intents[0].channel, 'l2', 'text intent preserves channel field')
        assertEqual(intents[0].brightness, 80, 'text intent preserves brightness field')
    }

    // get_device_state must expose suffixed per-channel fields while stripping noise.
    // Stub the cache read so this assertion tests the filter itself, not Redis availability.
    const aiState = { state_l1: 'ON', brightness_l1: 180, linkquality: 99, last_seen: new Date().toISOString() }
    aiDimmer.getCachedState = async () => ({ stateLast: aiState, stateLastAt: new Date().toISOString(), stateOrigin: 'human' })
    const readResult = JSON.parse(await ToolBuilder.execute({
        function: { name: 'get_device_state', arguments: JSON.stringify({ device_name: 'salon ambient' }) }
    }))
    assert(readResult.state?.state_l1 === 'ON', 'filtered AI state includes state_l1')
    assert(Number.isFinite(Number(readResult.state?.brightness_l1)), 'filtered AI state includes brightness_l1')
    assert(!('linkquality' in (readResult.state ?? {})), 'noise fields still stripped from AI state view')
}

// ---------------------------------------------------------------------------
console.log('\n── Origin tracking & human-interaction detection ──\n')

{
    // A) Human-directed command on a dual switch: inherited Mechanism machinery must
    //    still mark origin human immediately at publish time and start the Redis
    //    cooldown -- payload shape (suffixed fan-out) must not matter here.
    const swH = new DualSwitch('Kuchnia Wlacznik Zlew', '0xh1', { channels: ['left', 'right'] })
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
    const dmB = new DualDimmer('Salon Ambient', '0xb2', { channels: ['l1', 'l2'] })
    dmB.setMqttService(new MockMqttService())
    await dmB.setCachedState({ brightness_l1: 180 }, { origin: 'automation' })
    const writesB2 = await countCooldownWrites(async () => {
        dmB.handleMqttMessage({ topic: 'zigbee2mqtt/Salon Ambient', message: JSON.stringify({ brightness_l1: 90 }) })
        await sleep(30)
    })
    assertEqual(dmB.getStateOrigin(), 'human', 'brightness_l1 change (180 -> 90) classified as HUMAN')
    assert(writesB2 >= 1, `brightness change started the cooldown (${writesB2} writes)`)

    // ...but bridge jitter within tolerance does NOT read as input.
    const dmC = new DualDimmer('Salon Swiatlo', '0xb3', { channels: ['l1', 'l2'] })
    dmC.setMqttService(new MockMqttService())
    await dmC.setCachedState({ brightness_l1: 180 }, { origin: 'automation' })
    const writesC = await countCooldownWrites(async () => {
        dmC.handleMqttMessage({ topic: 'zigbee2mqtt/Salon Swiatlo', message: JSON.stringify({ brightness_l1: 179 }) })
        await sleep(30)
    })
    assertEqual(dmC.getStateOrigin(), 'automation', 'jitter-sized brightness delta stays automation (no false human mark)')
    assertEqual(writesC, 0, 'jitter-sized delta wrote no cooldown')
}

{
    // C) Button action reports on a dual switch keep parity with plain wall switches:
    //    an event payload against a cached suffixed state counts as interaction...
    const swD = new DualSwitch('Kuchnia Wlacznik Jadalnia', '0xd1', { channels: ['left', 'right'] })
    swD.setMqttService(new MockMqttService())
    await swD.setCachedState({ state_left: 'ON', state_right: 'OFF' }, { origin: 'automation' })
    const writesD = await countCooldownWrites(async () => {
        swD.handleMqttMessage({ topic: 'zigbee2mqtt/Kuchnia Wlacznik Jadalnia', message: JSON.stringify({ action: 'single_right' }) })
        await sleep(30)
    })
    assertEqual(swD.getStateOrigin(), 'human', 'button press report classified as HUMAN (parity with plain switches)')
    assert(writesD >= 1, `button press started the cooldown (${writesD} writes)`)

    // ...while an identical periodic re-advertisement adds nothing.
    const writesE = await countCooldownWrites(async () => {
        swD.handleMqttMessage({ topic: 'zigbee2mqtt/Kuchnia Wlacznik Jadalnia', message: JSON.stringify({ action: 'single_right' }) })
        await sleep(30)
    })
    assertEqual(writesE, 0, 'identical periodic report wrote no additional cooldown')
}

{
    // D) Automation-driven command + its own suffixed echo stays AUTOMATION for the whole
    //    token window (pins current correlator fallback semantics so they cannot silently
    //    regress; see doc/TODO.md for the larger-scope echo-matching follow-up).
    const swF = new DualSwitch('Kuchnia Wlacznik Zlew', '0xf1', { channels: ['left', 'right'] })
    const mockF = new MockMqttService()
    swF.setMqttService(mockF)
    await swF.setCachedState({ state_left: 'OFF', state_right: 'OFF' }, { origin: 'unknown' })

    const writesF = await countCooldownWrites(async () => {
        swF.receiveCommand('ON', DeviceCommandSource.AUTOMATION)
        await sleep(30) // _onPublish: register instant token, origin=automation
        assertEqual(swF.getStateOrigin(), 'automation', 'AUTOMATION dispatch marks origin automation immediately')
        // z2m echoes the combined state back -- suffixed fields only.
        swF.handleMqttMessage({ topic: 'zigbee2mqtt/Kuchnia Wlacznik Zlew', message: JSON.stringify({ state_left: 'ON', state_right: 'ON' }) })
        await sleep(30)
        // Identical periodic re-advertisement right after.
        swF.handleMqttMessage({ topic: 'zigbee2mqtt/Kuchnia Wlacznik Zlew', message: JSON.stringify({ state_left: 'ON', state_right: 'ON' }) })
        await sleep(30)
    })
    assertEqual(lastPublish(mockF)?.payload, { state_left: 'ON', state_right: 'ON' }, 'AUTOMATION ON fanned out to both channels')
    assertEqual(swF.getStateOrigin(), 'automation', 'own echo + periodic tail stay AUTOMATION inside the token window')
    assertEqual(writesF, 0, 'no human cooldown written for an automation round-trip')
}

// ---------------------------------------------------------------------------
const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)