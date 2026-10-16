/**
 * Home Theater automation execution tests -- elastic across deployments.
 *
 * Section 1 runs self-contained scenarios against fabricated instances of the
 * shared HomeTheaterAutomation base in both supported shapes -- a single-room
 * deployment (one playback setup) and one bundled multi-host instance -- using
 * inline rules and stub devices, so no local configuration is required and the
 * suite works out of the box for any clone.
 *
 * Section 2 discovers every HomeTheaterAutomation subclass shipped under
 * etc/automation/ and cross-checks each configured instance's own config:
 * every host referenced by a rule condition must be declared in that instance's
 * triggers, its trigger topics stay scoped to those hosts, and at least one
 * trigger exists. Instances without a loaded config (fresh clones ship only
 * .dist templates) are skipped, not failed.
 *
 * Section 3 covers engine & provider semantics: video-player conditions
 * including the enumerated `offline` status, override_human_interaction wiring,
 * and MPC/VLC provider parse normalization.
 *
 * The video-player status is injected directly into the VideoPlayerMonitor
 * in-memory cache via setTestStatus(), so the test is independent of a live
 * Redis broker or a running player.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import fs from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DatabaseService from '../src/service/databaseService.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import AutomationContainer from '../src/automation/container/automationContainer.js'
import Autoloader from '../src/lib/autoloader.js'
import videoPlayerMonitor from '../src/monitor/videoPlayerMonitor.js'
import MpcProvider from '../src/monitor/providers/mpc.js'
import VlcProvider from '../src/monitor/providers/vlc.js'
import HomeTheaterAutomation from '../etc/automation/homeTheaterBase.js'
import solar from '../src/lib/sun.js'
import { parse as yamlParse } from 'yaml'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Stub global Date at a fixed month/day/hour, so sun-gated rules resolve deterministically
 * against that day's real civil dawn/dusk instead of the wall clock of the machine running
 * the suite.
 * @param {number} monthIndex - Zero-based month (0=Jan ... 11=Dec)
 * @param {number} [day=15] - Day of month
 * @param {number} [hour=12] - Hour of day
 * @returns {Function} Restore function returning the original Date
 */
function stubDate(monthIndex, day = 15, hour = 12) {
    const RealDate = global.Date
    class FakeDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(2026, monthIndex, day, hour, 0, 0)
            else super(...args)
        }
        static now() {
            return new RealDate(2026, monthIndex, day, hour, 0, 0).getTime()
        }
    }
    global.Date = FakeDate
    return () => { global.Date = RealDate }
}

// Record delegated invocations instead of executing the target automations (which are not
// loaded in this unit test), so we can assert WHICH owner hands control to and with what
// force flag. The real callAutomation would run them; here we just observe.
const invocations = []
// The exported default is a frozen singleton INSTANCE (not the class), so we can neither set an
// own property on it nor read `.prototype`. Patch its shared [[Prototype]] instead -- that is
// exactly where the base's `AutomationContainer.callAutomation(...)` lookup resolves to.
const containerPrototype = Object.getPrototypeOf(AutomationContainer)
containerPrototype.callAutomation = async function(name, data = {}) {
    invocations.push({ name, force: data?.force === true })
}

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
        console.log(`  ✓ ${label}`)
        passed++
    } else {
        console.error(`  ✗ ${label}`)
        failed++
    }
}

/**
 * Set a video-player status so VideoPlayerMonitor.getStatus() sees it.
 * Uses the monitor's test hook, which seeds the in-memory cache without a live
 * player or a running sweep.
 * @param {string} host - Host name
 * @param {string|null} status - Status; legacy/raw labels (`unreachable`, `unknown`, null) normalize to `offline`
 */
async function setVideoStatus(host, status) {
    await videoPlayerMonitor.setTestStatus(host, status)
}

/** Sleep helper for timing-sensitive scenarios (e.g., the react-on-change gate). */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Create a stub device that records received commands and mimics the base
 * class's cached-state read (`getStateLast`) so state-aware restore has
 * something to look at.
 * @param {string} name - Device name
 * @param {Object|null} [initialState=null] - Initial cached state payload
 *   (e.g., `{ state: 'ON' }` for plugs, `{ position: 50 }` for rollers)
 * @returns {Object} Stub device
 */
function makeStubDevice(name, initialState = null) {
    return {
        name,
        calls: [],
        stateLast: initialState ? { ...initialState } : null,
        getName() { return name },
        receiveCommand(payload, source) {
            this.calls.push({ payload, source })
            if (payload && typeof payload === 'object' && typeof payload.state === 'string') {
                this.stateLast = { state: payload.state.toUpperCase() }
            } else if (payload === 'CLOSE') {
                this.stateLast = { position: 0 }
            } else if (payload === 'OPEN') {
                this.stateLast = { position: 100 }
            }
        },
        getStateLast() { return this.stateLast },
        // No human-interaction origin -- the cooldown check fails open.
        getStateOrigin() { return 'unknown' },
        getStateLastAt() { return null }
    }
}

/**
 * Self-contained home-theater instance for testing.
 * Uses a fixed rule set injected post-construction (no YAML file) so the test
 * is independent of the live configuration and device container; resolveCommand
 * is inherited from HomeTheaterAutomation exactly like in production.
 */
class TestHomeTheater extends HomeTheaterAutomation {
    /** @type {Map<string, Object>} */ #devices
    /** @type {Object} */ #context

    /**
     * @param {Map<string, Object>} devices - Map of rule-target key -> stub device
     * @param {Object} context - Fabricated sensor context
     */
    constructor(devices, context) {
        super({ name: 'TestHomeTheater', configPath: '/dev/null' })
        this.#devices = devices
        this.#context = context
    }

    loadDevices() { return this.#devices }
    async buildContext() { return this.#context }
}

// Dark-enough context for the office rule set's local light-restore gate (illuminance < 900);
// scenarios needing brighter daylight or other periods build their own instances.
const CONTEXT = { timeOfDay: 'evening', illuminance: 800 }

// ---------------------------------------------------------------------------
// Deployment shapes under test
// ---------------------------------------------------------------------------

/** Office-room device map (single playback setup): ambient plug on, kitchen off, roller mid-way. */
function makeOfficeDevices(dark = false) {
    return new Map([
        ['Living_Room_Plug', makeStubDevice('Living Room Plug', { state: dark ? 'OFF' : 'ON' })],
        ['Kitchen_Plug', makeStubDevice('Kitchen Plug', { state: 'OFF' })],
        ['Hallway_Cupboard_Outlet', makeStubDevice('Hallway Cupboard Outlet', { state: 'OFF' })],
        ['Salon_Ambient_Dimmer', makeStubDevice('Salon Ambient Dimmer')],
        ['Living_Room_Roller_Left', makeStubDevice('Living Room Roller Left', { position: dark ? 0 : 50 })]
    ])
}

/** Bundled two-room device map mirroring a split deployment's targets in one instance. */
function makeBundledDevices(dark = false) {
    const devices = makeOfficeDevices(dark)
    devices.set('Bedroom_Plug', makeStubDevice('Bedroom Plug', { state: dark ? 'OFF' : 'ON' }))
    devices.set('Bedroom_Roller_Left', makeStubDevice('Bedroom Roller Left', { position: dark ? 0 : 50 }))
    return devices
}

// Inline rule sets modeled on the shipped per-room configs. Presence conditions are
// omitted here only because the test fabricates statuses directly; production keeps
// presence on the light/roller rules.
const RULES_OFFICE = [
    { name: 'Office: player reachable - close rollers', conditions: { 'video_player': { htpc: ['playing', 'paused', 'stopped'] } }, targets: { Living_Room_Roller_Left: 'CLOSE' } },
    // Player gone (offline): hand the room back to its owners in one rule -- the array form
    // force-fires BOTH the roller owner and the ambient-lights owner. Keyed on the player
    // state alone (no separate presence gate).
    { name: 'Office: player gone - hand back to the room owners', conditions: { 'video_player': { htpc: ['offline'] } }, invoke_automation: [{ name: 'HomeOfficeRollersAutomation', force: true }, { name: 'AmbientLightsAutomation', force: true }] },
    // Online player that has paused/stopped: restore the lamp set locally (the salon dimmer
    // comes back at l1 50% / l2 25%). A GONE player instead delegates to the ambient-lights
    // owner via the rule above, so the two never fight over the same lamps.
    { name: 'Office: paused/stopped - restore ambient lighting', conditions: { 'video_player': { htpc: ['paused', 'stopped'] }, 'state_transition': { 'videoPlayer:htpc': { from: 'playing' } }, 'time_of_day': ['afternoon', 'evening', 'night'], illuminance: { lt: 900 } }, targets: { Living_Room_Plug: 'ON', Kitchen_Plug: 'ON', Salon_Ambient_Dimmer: { state: 'ON', brightness: { l1: 50, l2: 25 } } } },
    // The hallway cupboard lamp on its own terms: the same player state and illuminance gate as
    // the restore rule, narrowed to the EVENING half of the night -- civil dusk to midnight, and
    // out for the rest of the night. Both rules match on a pre-midnight pause and each
    // contributes its own targets; every matching rule acts, none is shadowed. `hour: { gte:
    // sunset }` stops at midnight on its own: the hour axis ends at 24:00, so no upper bound is
    // needed. `state_transition` pins the origin of the player's last transition -- a real pause
    // is `playing -> paused` -- so a player that merely came back (`offline -> stopped`, published
    // as `stopped` for the length of its playback-settle dwell) does not read as a pause.
    { name: 'Office: paused/stopped before midnight - hallway cupboard lamp', conditions: { 'video_player': { htpc: ['paused', 'stopped'] }, 'state_transition': { 'videoPlayer:htpc': { from: 'playing' } }, illuminance: { lt: 900 }, hour: { gte: 'sunset' } }, targets: { Hallway_Cupboard_Outlet: 'ON' } },
    { name: 'Office: playing - dark mode (lights off)', conditions: { 'video_player': { htpc: ['playing'] } }, targets: { Living_Room_Plug: 'OFF', Kitchen_Plug: 'OFF', Hallway_Cupboard_Outlet: 'OFF', Salon_Ambient_Dimmer: 'OFF' } }
]

const RULES_BUNDLED = [
    ...RULES_OFFICE,
    { name: 'Bedroom: player reachable - close rollers', conditions: { 'video_player': { bedroom: ['playing', 'paused', 'stopped'] } }, targets: { Bedroom_Roller_Left: 'CLOSE' } },
    // The bedroom is a "delegating" room: its gone rule hands the rollers back AND pokes the
    // ambient-lights owner (array form), while its not-playing rule delegates the lamp restore
    // for every non-playing state. This exercises the base class's flexibility to mix a
    // local-restore room (office) with a fully-delegating room (bedroom) in one instance.
    { name: 'Bedroom: player gone - hand back to the room owners', conditions: { 'video_player': { bedroom: ['offline'] } }, invoke_automation: [{ name: 'BedroomRollersAutomation', force: true }, { name: 'AmbientLightsAutomation', force: true }] },
    { name: 'Bedroom: not playing - delegate light restore to ambient lights', conditions: { 'video_player': { bedroom: ['paused', 'stopped', 'offline'] }, 'state_transition': { 'videoPlayer:bedroom': { from: 'playing' } } }, invoke_automation: { name: 'AmbientLightsAutomation', force: true } },
    { name: 'Bedroom: playing - dark mode (lights off)', conditions: { 'video_player': { bedroom: ['playing'] } }, targets: { Bedroom_Plug: 'OFF' } }
]

/**
 * Build a home-theater instance over the given device map in one of the two
 * supported shapes ('office' single-room or 'bundled' multi-host).
 * @param {Map<string, Object>} devices - Stub device map
 * @param {'office'|'bundled'} shape - Deployment shape under test
 * @returns {TestHomeTheater} Configured automation instance
 */
function makeInstance(devices, shape) {
        const auto = new TestHomeTheater(devices, CONTEXT)
    auto.config = {
        override_human_interaction: true,
        trigger_on_change_only: true,
        targets: Array.from(devices.values(), (d) => d.getName()),
        triggers_video: shape === 'office' ? ['htpc'] : ['htpc', 'bedroom'],
        triggers_network: shape === 'office' ? ['htpc'] : ['htpc', 'bedroom'],
        rules: shape === 'office' ? RULES_OFFICE : RULES_BUNDLED
    }
    // #overrideHumanInteraction is captured from config in the base constructor; we inject
    // the config post-construction here, so mirror it through the public setter to match
    // what a YAML-driven construction yields (the shipped configs set override_human_interaction).
    auto.setOverrideHumanInteraction(Boolean(auto.config.override_human_interaction))
    return auto
}

/**
 * Build a home-theater instance with a fabricated sensor context. The module-wide CONTEXT has
 * no sun instants (sun-gated rules fail closed against it), so scenarios about the midnight ->
 * civil dawn window inject their own sundawn/illuminance/timeOfDay.
 * @param {Map<string, Object>} devices - Stub device map
 * @param {'office'|'bundled'} shape - Deployment shape under test
 * @param {Object} context - Fabricated sensor context
 * @returns {TestHomeTheater} Configured automation instance
 */
function makeInstanceWithContext(devices, shape, context) {
    const auto = new TestHomeTheater(devices, context)
    auto.config = {
        override_human_interaction: true,
        trigger_on_change_only: true,
        targets: Array.from(devices.values(), (d) => d.getName()),
        triggers_video: shape === 'office' ? ['htpc'] : ['htpc', 'bedroom'],
        triggers_network: shape === 'office' ? ['htpc'] : ['htpc', 'bedroom'],
        rules: shape === 'office' ? RULES_OFFICE : RULES_BUNDLED
    }
    auto.setOverrideHumanInteraction(true)
    return auto
}

/**
 * Run a sequence of steps against one instance with a fabricated context.
 * @param {'office'|'bundled'} shape - Deployment shape under test
 * @param {Map<string, Object>} devices - Device map
 * @param {{[host: string]: string|null}[]} steps - Statuses before each execute() tick
 * @param {Object} context - Fabricated sensor context
 * @returns {Promise<Map<string, Object>>} The device map
 */
async function runSequenceWith(shape, devices, steps, context) {
    const auto = makeInstanceWithContext(devices, shape, context)
    for (const step of steps) {
        for (const [host, status] of Object.entries(step)) {
            await setVideoStatus(host, status)
        }
        await auto.execute({ trigger: 'test' })
    }
    return devices
}

/**
 * Run a sequence of steps against ONE automation instance, so state-aware
 * restore memory persists across steps exactly like in production. Each step
 * maps host -> status before that tick's execute().
 * @param {'office'|'bundled'} shape - Deployment shape under test
 * @param {Map<string, Object>} devices - Device map
 * @param {{[host: string]: string|null}[]} steps - Statuses before each execute() tick
 * @returns {Promise<Map<string, Object>>} The device map
 */
async function runSequence(shape, devices, steps) {
    const auto = makeInstance(devices, shape)
    for (const step of steps) {
        for (const [host, status] of Object.entries(step)) {
            await setVideoStatus(host, status)
        }
        await auto.execute({ trigger: 'test' })
    }
    return devices
}

/**
 * Assert a device received exactly the expected payload sequence (and that
 * every dispatched command was automation-originated).
 * @param {Map<string, Object>} devices - Device map
 * @param {string} id - Rule-target key
 * @param {(Object|string)[]} expectedPayloads - Expected payloads, in order
 * @param {string} label - Assertion label
 */
function assertCalls(devices, id, expectedPayloads, label) {
    const actual = devices.get(id).calls.map((c) => JSON.stringify(c.payload))
    const expected = expectedPayloads.map((p) => JSON.stringify(p))
    const match = actual.length === expected.length && actual.every((v, i) => v === expected[i])
    assert(match, `${label} (got [${actual.join(', ') || 'none'}])`)
    if (devices.get(id).calls.length > 0) {
        assert(
            devices.get(id).calls.every((c) => c.source === DeviceCommandSource.AUTOMATION),
            `${id}: all commands automation-originated`
        )
    }
}

/** Count how many times an automation was delegated to in this scenario. */
function invocationCount(name) { return invocations.filter((i) => i.name === name).length }

/** True when every delegation to `name` carried force:true and it fired at least once. */
function allForced(name) {
    const xs = invocations.filter((i) => i.name === name)
    return xs.length > 0 && xs.every((i) => i.force === true)
}

/** Reset the delegation recorder so each scenario asserts only its own firings. */
function resetInvocations() { invocations.length = 0 }

console.log('\n── Home theater (bundled instance): dark mode, pause restores only what was on ──\n')

{
    resetInvocations()
    const devices = await runSequence('bundled', makeBundledDevices(), [
        { htpc: 'playing', bedroom: 'stopped' },
        { htpc: 'paused', bedroom: 'stopped' }
    ])
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'ON' }],
        'Living_Room_Plug: OFF on play; restored locally on the paused tick')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }, { state: 'ON' }],
        'Kitchen_Plug: OFF on the playing tick; restored locally on pause')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }, { state: 'ON', brightness: { l1: 50, l2: 25 } }],
        'dimmer OFF on the playing tick; restored ON at l1 50% / l2 25% on the paused tick')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE'],
        'Living_Room_Roller_Left: re-closed on every reachable tick (playing + paused)')
    // Bedroom player open but idle: its roller is still owned (closed); light restore is
    // delegated rather than sent locally.
    assertCalls(devices, 'Bedroom_Plug', [],
        'Bedroom_Plug: silent (restore delegated to ambient-lights)')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE', 'CLOSE'],
        'Bedroom_Roller_Left: re-closed on every reachable tick (stopped both ticks)')
    // Delegation now comes from the BEDROOM rule alone; the office side restores locally.
    assert(invocationCount('AmbientLightsAutomation') === 2 && allForced('AmbientLightsAutomation'),
        'bedroom delegation fires on each of its not-playing ticks (forced); office restores locally')
}

console.log('\n── Home theater (bundled instance): already-dark room, only the always-on ambient returns ──\n')

{
    // Everything starts off/closed. Redundant OFF/CLOSE commands are still dispatched
    // whenever their rule matches (the old no-op gate is gone), but light RESTORE remains
    // delegated to the ambient-lights owner -- that delegation is what this scenario checks.
    resetInvocations()
    const devices = await runSequence('bundled', makeBundledDevices(true), [
        { htpc: 'playing', bedroom: 'stopped' },
        { htpc: 'paused', bedroom: 'stopped' }
    ])
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'ON' }], 'Living_Room_Plug: OFF re-sent even though already dark; restored locally on pause')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }, { state: 'ON' }], 'Kitchen_Plug: OFF re-sent on the playing tick; restored locally on pause')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }, { state: 'ON', brightness: { l1: 50, l2: 25 } }], 'dimmer OFF on the playing tick; restored ON at l1 50% / l2 25% on the paused tick')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE'], 'Living_Room_Roller_Left: re-closed each reachable tick (idempotent)')
    assertCalls(devices, 'Bedroom_Plug', [], 'Bedroom_Plug: silent (restore delegated)')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE', 'CLOSE'], 'Bedroom_Roller_Left: re-closed each reachable tick (idempotent)')
    // Bedroom delegation still happens even though the office side now restores locally.
    assert(invocationCount('AmbientLightsAutomation') === 2 && allForced('AmbientLightsAutomation'),
        'bedroom delegation fires both not-playing ticks (forced), despite a fully-dark room')
}

console.log('\n── Home theater (bundled instance): both playing (full dark) ──\n')

{
    // Both machines actively playing: full dark mode locally; nothing is delegated because
    // the players are reachable and not in a "not-playing" state.
    resetInvocations()
    const devices = await runSequence('bundled', makeBundledDevices(), [{ htpc: 'playing', bedroom: 'playing' }])
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }], 'Living_Room_Plug: OFF')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF (dark mode dispatches regardless of prior state)')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }], 'Salon_Ambient_Dimmer: OFF (dark mode switches the ambient dimmer off)')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE'], 'Living_Room_Roller_Left: CLOSE')
    assertCalls(devices, 'Bedroom_Plug', [{ state: 'OFF' }], 'Bedroom_Plug: OFF')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE'], 'Bedroom_Roller_Left: CLOSE')
    assert(invocations.length === 0, 'active playback never delegates to owners')
}

console.log('\n── Home theater (bundled instance): movie ends (stopped) -- lights return, rollers stay owned ──\n')

{
    // Stopped still means the player answers HTTP: the rollers remain owned (closed, no
    // re-open) and light restore is delegated to the ambient-lights owner on that tick.
    // Hand-back of the rollers happens when the player disappears, not when playback ends.
    resetInvocations()
    const devices = await runSequence('bundled', makeBundledDevices(), [
        { htpc: 'playing', bedroom: 'playing' },
        { htpc: 'stopped', bedroom: 'stopped' }
    ])
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'ON' }],
        'Living_Room_Plug: OFF on play; restored locally on the stopped tick')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }, { state: 'ON' }],
        'Kitchen_Plug: OFF on the playing tick; restored locally after stop')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }, { state: 'ON', brightness: { l1: 50, l2: 25 } }],
        'dimmer OFF on play; restored ON at l1 50% / l2 25% when playback stops')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE'],
        'Living_Room_Roller_Left: re-closed each reachable tick (playing + stopped)')
    assertCalls(devices, 'Bedroom_Plug', [{ state: 'OFF' }],
        'Bedroom_Plug: OFF on play; its not-playing restore stays delegated')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE', 'CLOSE'], 'Bedroom_Roller_Left: re-closed each reachable tick')
    // Both rooms go "not playing" together on the second tick; only the bedroom rule still
    // delegates -> one forced ambient-lights call for that shared tick.
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'ambient-lights invoked once via the bedroom rule for the shared not-playing tick (forced)')
}

console.log('\n── Home theater (bundled instance): roller ownership lifecycle (reachable -> gone -> reachable) ──\n')

{
    // Rollers are owned while the player answers HTTP (any state); when it disappears
    // (offline -- player not answering, or host powered down; both enumerate to one status)
    // home-theater hands control back to the room's roller owner instead of re-opening locally.
    // The bedroom player is gone throughout, so its roller is never closed by us -- only ever
    // delegated. Redundant CLOSE/OFF commands are still dispatched whenever their rule matches;
    // the delegation counts below are what matter.
    resetInvocations()
    const devices = await runSequence('bundled', makeBundledDevices(), [
        { htpc: 'playing', bedroom: null },
        { htpc: 'paused', bedroom: null },
        { htpc: null, bedroom: null },
        { htpc: null, bedroom: null },
        { htpc: 'playing', bedroom: null },
        { htpc: 'unreachable', bedroom: null }
    ])
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE', 'CLOSE'],
        'Living_Room_Roller_Left: re-closed on each reachable tick (t1,t2,t5); offline ticks delegate')
    // The office restores locally ONLY on the paused tick (t2); on the offline ticks (t3,t4,t6)
    // the gone rule delegates the lamp restore to the ambient-lights owner instead of re-asserting
    // it here, so the local plugs/dimmer stay quiet on those ticks.
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'ON' }, { state: 'OFF' }],
        'Living_Room_Plug: OFF on each playing tick (t1,t5); local restore only on the paused tick (t2)')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }, { state: 'ON' }, { state: 'OFF' }],
        'Kitchen_Plug: mirrors the plug sequence (local restore only on t2)')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }, { state: 'ON', brightness: { l1: 50, l2: 25 } }, { state: 'OFF' }],
        'dimmer OFF on each playing tick (t1,t5); restored ON at l1 50% / l2 25% only on the paused tick (t2)')
    assertCalls(devices, 'Bedroom_Roller_Left', [],
        'Bedroom_Roller_Left: never closed by us -- only ever delegated')
    assertCalls(devices, 'Bedroom_Plug', [],
        'Bedroom_Plug: silent (restore delegated to ambient-lights)')
    // Delegation counts across the six ticks.
    assert(invocationCount('HomeOfficeRollersAutomation') === 3 && allForced('HomeOfficeRollersAutomation'),
        'office rollers handed back on each HTPC-offline tick (t3,t4,t6), forced')
    assert(invocationCount('BedroomRollersAutomation') === 6 && allForced('BedroomRollersAutomation'),
        'bedroom rollers handed back every tick (player gone throughout), forced')
    assert(invocationCount('AmbientLightsAutomation') === 6 && allForced('AmbientLightsAutomation'),
        'ambient restore delegated from the bedroom rule on every tick, forced; office restores locally')
}

console.log('\n── Home theater (bundled instance): rollers found closed are never opened on hand-back ──\n')

{
    // The office rollers start closed (position 0). Redundant CLOSE commands are still
    // dispatched whenever the reachable rule matches (the old no-op gate is gone), but home-
    // theater never sends OPEN -- it delegates hand-back to the owner instead of re-opening.
    resetInvocations()
    const devices = makeBundledDevices()
    devices.get('Living_Room_Roller_Left').stateLast = { position: 0 }
    const after = await runSequence('bundled', devices, [
        { htpc: 'playing', bedroom: null },
        { htpc: null, bedroom: null }
    ])
    assertCalls(after, 'Living_Room_Roller_Left', ['CLOSE'],
        'Living_Room_Roller_Left: re-closed on the playing tick; hand-back delegated (never opened)')
    // On the offline tick the office delegates the lamp restore to the ambient-lights owner
    // (gone rule) rather than re-asserting it locally, so the local plugs/dimmer stay quiet.
    assertCalls(after, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated to ambient-lights when HTPC goes offline')
    assertCalls(after, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF on the playing tick; restore delegated after')
    assertCalls(after, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }], 'dimmer OFF on play; restore delegated on the offline tick')
    assertCalls(after, 'Bedroom_Roller_Left', [], 'Bedroom_Roller_Left: never opened')
    // Delegation happened even though the local rollers stayed put.
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'office hand-back delegated once when HTPC went offline, forced')
    assert(invocationCount('BedroomRollersAutomation') === 2 && allForced('BedroomRollersAutomation'),
        'bedroom hand-back delegated both ticks (player gone), forced')
    assert(invocationCount('AmbientLightsAutomation') === 2 && allForced('AmbientLightsAutomation'),
        'ambient restore delegated both not-playing ticks, forced')
}

console.log('\n── Home theater (bundled instance): players vanish mid-movie (offline) -- full hand-back ──\n')

{
    // Both machines disappear (offline): home-theater hands the rollers back to each
    // room's owner and delegates light restore to ambient-lights -- nothing is re-opened or
    // switched on locally anymore. Each device only ever sees its single dark-mode command.
    resetInvocations()
    const devices = await runSequence('bundled', makeBundledDevices(), [
        { htpc: 'playing', bedroom: 'playing' },
        { htpc: null, bedroom: null }
    ])
    // Both players vanish: the office no longer restores its lamps locally -- the gone rule
    // delegates the restore to the ambient-lights owner, so each local device only ever sees
    // its single dark-mode command.
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated to ambient-lights when the player vanishes')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF on the playing tick; restore delegated after vanish')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }], 'dimmer OFF on play; restore delegated when both players vanish')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE'],
        'Living_Room_Roller_Left: CLOSE then delegated hand-back (no local OPEN)')
    assertCalls(devices, 'Bedroom_Plug', [{ state: 'OFF' }],
        'Bedroom_Plug: OFF on play; its not-playing restore stays delegated')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE'],
        'Bedroom_Roller_Left: CLOSE then delegated hand-back')
    // Full hand-back in one offline tick: each owner invoked once, forced. The ambient-lights
    // owner is poked by BOTH the office gone rule and the bedroom gone/not-playing rules, but
    // the base class deduplicates it to a single forced invocation per run.
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'office rollers handed back to HomeOfficeRollersAutomation (forced)')
    assert(invocationCount('BedroomRollersAutomation') === 1 && allForced('BedroomRollersAutomation'),
        'bedroom rollers handed back to BedroomRollersAutomation (forced)')
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'light restore delegated to AmbientLightsAutomation once (forced), deduplicated across both rooms')
}

console.log('\n── Home theater (single-room instance): dark mode, pause restores only what was on ──\n')

{
    resetInvocations()
    const devices = await runSequence('office', makeOfficeDevices(), [
        { htpc: 'playing' },
        { htpc: 'paused' }
    ])
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'ON' }],
        'Living_Room_Plug: OFF on play; restored locally on the paused tick')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }, { state: 'ON' }],
        'Kitchen_Plug: OFF on the playing tick; restored locally on pause')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }, { state: 'ON', brightness: { l1: 50, l2: 25 } }],
        'dimmer OFF on the playing tick; restored ON at l1 50% / l2 25% on the paused tick')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE'],
        'Living_Room_Roller_Left: re-closed on every reachable tick (playing + paused)')
    // Local restore while the player stays reachable -- no ambient-lights delegation at all.
    assert(invocationCount('AmbientLightsAutomation') === 0,
        'office instance restores its lamp set locally -- AmbientLightsAutomation is never invoked')
    assert(invocationCount('HomeOfficeRollersAutomation') === 0,
        'no roller hand-back while the player stays reachable')
    assert(invocationCount('BedroomRollersAutomation') === 0,
        "a foreign room's owner is never invoked from a single-room instance")
}

console.log('\n── Home theater (single-room instance): player gone -- hands back to its own owner only ──\n')

{
    resetInvocations()
    const devices = await runSequence('office', makeOfficeDevices(), [
        { htpc: 'playing' },
        { htpc: null }
    ])
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE'],
        'Living_Room_Roller_Left: CLOSE then delegated hand-back (no local OPEN)')
    // The single-room instance now delegates the lamp restore to the ambient-lights owner on
    // the offline tick (gone rule) instead of restoring it locally, so the local devices only
    // ever see their single dark-mode command.
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated to ambient-lights when the player goes offline')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF on the playing tick; restore delegated after')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [{ state: 'OFF' }], 'dimmer OFF on play; restore delegated on the offline tick')
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'rollers handed back to this room\'s owner exactly once (forced)')
    assert(invocationCount('BedroomRollersAutomation') === 0,
        "a foreign room's owner is never invoked from a single-room instance")
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'light restore delegated to AmbientLightsAutomation once (forced) on the offline tick')
}

console.log('\n── Home theater (single-room instance): rollers found closed are never opened on hand-back ──\n')

{
    // The roller starts closed (position 0). Redundant CLOSE commands are still dispatched
    // whenever the reachable rule matches, but home-theater never sends OPEN -- it delegates
    // hand-back to the owner instead of re-opening.
    resetInvocations()
    const devices = makeOfficeDevices()
    devices.get('Living_Room_Roller_Left').stateLast = { position: 0 }
    const after = await runSequence('office', devices, [
        { htpc: 'playing' },
        { htpc: null }
    ])
    assertCalls(after, 'Living_Room_Roller_Left', ['CLOSE'],
        'Living_Room_Roller_Left: re-closed on the playing tick; hand-back delegated (never opened)')
    // The offline tick delegates the lamp restore to the ambient-lights owner (gone rule), so
    // the local plug only ever sees its single dark-mode command.
    assertCalls(after, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated to ambient-lights when the player goes offline')
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'hand-back delegated once when the player went offline, forced')
    assert(invocationCount('BedroomRollersAutomation') === 0,
        "a foreign room's owner is never invoked from a single-room instance")
}

console.log('\n── Home theater (single-room instance): daylight pause -- restore gate rejects ──\n')

{
    // Bright afternoon (illuminance >= 900): pausing must NOT restore the lamp set locally --
    // the time-of-day + illuminance gate rejects it exactly like the old delegation did.
    resetInvocations()
    const devices = makeOfficeDevices()
        const auto = new TestHomeTheater(devices, { timeOfDay: 'afternoon', illuminance: 1500 })
    auto.config = {
        override_human_interaction: true,
        trigger_on_change_only: true,
        targets: Array.from(devices.values(), (d) => d.getName()),
        triggers_video: ['htpc'],
        triggers_network: ['htpc'],
        rules: RULES_OFFICE
    }
    auto.setOverrideHumanInteraction(true)
    await setVideoStatus('htpc', 'paused')
    await auto.execute({ trigger: 'test' })
    assertCalls(devices, 'Living_Room_Plug', [], 'no local ON while it is still bright outside')
    assertCalls(devices, 'Kitchen_Plug', [], 'kitchen plug also stays dark in bright daylight')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [], 'dimmer untouched when the restore gate rejects')
    assert(invocationCount('AmbientLightsAutomation') === 0, 'bright-daylight pause delegates to nothing either')
}

console.log('\n── Home theater (Gone rule): player-state-only condition force-fires both owners ──\n')

{
    // The Gone rule is keyed on the player state ALONE (no separate presence gate): when the
    // player is offline it force-fires BOTH the roller owner and the ambient-lights owner in a
    // single rule. This scenario proves the condition is player-state-only and that both owners
    // are poked (forced) on one offline tick, while the local lamps stay quiet (the restore is
    // delegated, not re-asserted here).
    resetInvocations()
    const devices = await runSequence('office', makeOfficeDevices(), [
        { htpc: null }
    ])
    assertCalls(devices, 'Living_Room_Plug', [], 'Living_Room_Plug: silent -- restore delegated to ambient-lights')
    assertCalls(devices, 'Kitchen_Plug', [], 'Kitchen_Plug: silent -- restore delegated to ambient-lights')
    assertCalls(devices, 'Salon_Ambient_Dimmer', [], 'dimmer silent -- restore delegated to ambient-lights')
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'Gone rule force-fires the roller owner (HomeOfficeRollersAutomation)')
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'Gone rule force-fires the ambient-lights owner (AmbientLightsAutomation)')
}

console.log('\n── Home theater (timer gate): idle ticks do not re-fire or re-poke ──\n')

{
    // The timer is a safety net only: with trigger_on_change_only, a scheduled tick is skipped
    // unless a monitored subject (the video-player status) actually transitioned since the last
    // evaluation. This proves a second idle tick -- with the player stably offline and no new
    // transition -- neither re-fires the Gone rule nor re-pokes the owners, which is what used
    // to force the ambient lamps back on every 15 minutes.
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'automaton-htpc-gate-'))
    const dbFile = join(dir, 'state.db')
    assert(await DatabaseService.init(dbFile), 'database available for the timer-gate scenario')

    resetInvocations()
    const devices = makeOfficeDevices()
    const auto = makeInstance(devices, 'office')
    await sleep(25)   // ensure any later Date.now() is strictly greater than the construction baseline

    // First transition: the player goes offline. setVideoStatus records the enumerated `offline`
    // status durably (the store is the gate's baseline), so the first timer tick sees a change
    // and runs; the extra recordTransition documents that intent explicitly.
    await setVideoStatus('htpc', null)
    await DatabaseService.recordTransition({ domain: 'videoPlayer', subject: 'htpc', toState: 'offline' })
    await auto.execute({ trigger: 'timer' })
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'first timer tick after the offline transition fires the Gone rule (rollers owner)')
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'first timer tick after the offline transition pokes the ambient-lights owner')

    // Second idle tick: no new transition since the last evaluation, so the gate skips it.
    // Capture the device call counts first so we can prove the skipped tick adds nothing.
    const rollerCallsBefore = devices.get('Living_Room_Roller_Left').calls.length
    const plugCallsBefore = devices.get('Living_Room_Plug').calls.length
    resetInvocations()
    await auto.execute({ trigger: 'timer' })
    assert(invocationCount('HomeOfficeRollersAutomation') === 0,
        'second idle timer tick is skipped -- no re-fire of the Gone rule (rollers owner)')
    assert(invocationCount('AmbientLightsAutomation') === 0,
        'second idle timer tick is skipped -- no re-poke of the ambient-lights owner')
    assert(devices.get('Living_Room_Roller_Left').calls.length === rollerCallsBefore,
        'second idle timer tick sends no new roller commands')
    assert(devices.get('Living_Room_Plug').calls.length === plugCallsBefore,
        'second idle timer tick sends no new plug commands')

    // A real new transition (player comes back) unblocks the next tick, but the reachable
    // (not gone) rule does not re-poke the owners.
    await sleep(25)   // ensure the new transition's timestamp is strictly after the last eval baseline
    await setVideoStatus('htpc', 'playing')
    await DatabaseService.recordTransition({ domain: 'videoPlayer', subject: 'htpc', toState: 'playing' })
    await auto.execute({ trigger: 'timer' })
    assert(invocationCount('HomeOfficeRollersAutomation') === 0,
        'a new transition unblocks the tick, but the reachable rule (not gone) does not re-poke the owners')

    await DatabaseService.close()
    fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n── Home theater (single-room instance): hallway cupboard lamp -- before midnight only ──\n')

{
    // The dedicated rule owns the cupboard lamp alone: the same player state and illuminance gate
    // as the restore rule, narrowed to civil dusk -> midnight. `sundusk` is that day's real civil
    // dusk, so the sun gate is exercised against a real number, any month.
    const sun = solar.getSunTimes(new Date(2026, 9, 15))
    const sundawn = sun.sundawn.getTime()
    const sundusk = sun.sundusk.getTime()
    const DARK = { timeOfDay: 'night', illuminance: 100, sundawn, sundusk }
    const BRIGHT = { timeOfDay: 'night', illuminance: 1500, sundawn, sundusk }

    // 21:00, dark: ONE pause before midnight fires BOTH rules in ONE run. The restore rule lights
    // its lamps and the cupboard rule lights the cupboard -- every matching rule acts, none is
    // shadowed.
    const restoreClockEve = stubDate(9 /* October */, 15, 21)
    try {
        let devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: 'playing' },
            { htpc: 'paused' }
        ], { ...DARK, timeOfDay: 'evening' })
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [{ state: 'OFF' }, { state: 'ON' }],
            'cupboard lamp: OFF on the playing tick, ON on the pre-midnight pause')
        assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'ON' }],
            'restore rule lights its own lamps on the same tick -- two rules, one run')

        // 21:00, bright: the illuminance gate rejects -- the cupboard lamp stays out.
        devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: 'playing' },
            { htpc: 'paused' }
        ], { ...BRIGHT, timeOfDay: 'evening' })
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [{ state: 'OFF' }],
            'cupboard lamp: dark-mode OFF only -- a bright pre-midnight pause does not light it')
    } finally {
        restoreClockEve()
    }

    // 02:00, dark: AFTER midnight the sun gate is closed -- the restore rule still lights its
    // lamps, so the cupboard lamp is the one lamp a night pause does not light. Watching into the
    // small hours restores the room's main lamps only.
    const restoreClock = stubDate(9, 15, 2)
    try {
        const devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: 'playing' },
            { htpc: 'paused' }
        ], DARK)
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [{ state: 'OFF' }],
            'cupboard lamp: dark-mode OFF only -- a post-midnight pause leaves it out')
        assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'ON' }],
            'restore rule still lights its own lamps after midnight (independent gates)')
    } finally {
        restoreClock()
    }

    // 04:30, dark: the "dark morning" -- the cupboard lamp stays out right through to dawn.
    const restoreClock2 = stubDate(9, 15, 4)
    try {
        const devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: 'playing' },
            { htpc: 'paused' }
        ], DARK)
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [{ state: 'OFF' }],
            'cupboard lamp: not lit on a 04:00 pause either -- its window ends at midnight')
    } finally {
        restoreClock2()
    }

    // 07:00, dark: past civil dawn the sun gate is closed on both ends -- no lamp lighting.
    const restoreClock3 = stubDate(9, 15, 7)
    try {
        const devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: 'playing' },
            { htpc: 'paused' }
        ], DARK)
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [{ state: 'OFF' }],
            'cupboard lamp: not lit past civil dawn -- the rule is gated to dusk -> midnight')
    } finally {
        restoreClock3()
    }
}

console.log('\n── Home theater (transition gate): a player that APPEARED is not a pause ──\n')

{
    // The playback-settle window publishes an about-to-play player as `stopped` for the length of
    // its dwell, so `offline -> stopped` -- the player answering HTTP again, heading to play --
    // reads exactly like a pause to a status-only condition, and the lamps flash on its way to
    // playing. `state_transition` pins the ORIGIN of the subject's last recorded transition, so
    // only a departure from playback (`playing -> paused/stopped`) restores light. No timing
    // assumption, no delay: the history already distinguishes the two.
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'automaton-htpc-transition-'))
    const dbFile = join(dir, 'state.db')
    assert(await DatabaseService.init(dbFile), 'database available for the transition-gate scenarios')

    const sun = solar.getSunTimes(new Date(2026, 9, 15))
    const DUSK = {
        timeOfDay: 'evening',
        illuminance: 100,
        sundawn: sun.sundawn.getTime(),
        sundusk: sun.sundusk.getTime()
    }

    // 21:00 -- inside the cupboard lamp's window, so the sun gate is not what is being tested.
    const restoreClock = stubDate(9 /* October */, 15, 21)
    try {
        // A player that merely came back: `offline -> stopped`. Every status gate says "stopped",
        // which the restore rules key on -- only the origin gate keeps the lamps from flashing.
        let devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: null },
            { htpc: 'stopped' }
        ], DUSK)
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [],
            'offline -> stopped: the cupboard lamp stays out -- an appearing player is not a pause')
        assertCalls(devices, 'Living_Room_Plug', [],
            'offline -> stopped: the restore rule does not light its lamps on an appearing player')

        // The same player plays, then pauses for real: `playing -> paused`.
        devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: 'playing' },
            { htpc: 'paused' }
        ], DUSK)
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [{ state: 'OFF' }, { state: 'ON' }],
            'playing -> paused: the cupboard lamp lights -- a real pause restores it')
        assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'ON' }],
            'playing -> paused: the restore rule lights its lamps on the same tick')

        // Scrubbing and browsing inside a player that is not playing: `stopped -> paused`. The
        // status lands on `paused`, which the rules key on, but nothing left playback.
        devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: 'stopped' },
            { htpc: 'paused' }
        ], DUSK)
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [],
            'stopped -> paused: nothing lights -- scrubbing is not a departure from playback')
        assertCalls(devices, 'Living_Room_Plug', [],
            'stopped -> paused: the restore rule stays quiet too')
    } finally {
        restoreClock()
        await DatabaseService.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

console.log('\n── Home theater (transition gate): no history leaves the gate inert ──\n')

{
    // Availability follows `state_changed_ago_minutes`: with no recorded history the gate is inert
    // rather than fatal, so a store that is down (or a host never swept) never silences a rule.
    // The scenarios above run with the store closed, and the cupboard lamp lights there.
    const sun = solar.getSunTimes(new Date(2026, 9, 15))
    const DUSK = {
        timeOfDay: 'evening',
        illuminance: 100,
        sundawn: sun.sundawn.getTime(),
        sundusk: sun.sundusk.getTime()
    }
    const restoreClock = stubDate(9 /* October */, 15, 21)
    try {
        assert(!DatabaseService.isAvailable(), 'no transition history available for this scenario')
        const devices = await runSequenceWith('office', makeOfficeDevices(), [
            { htpc: 'playing' },
            { htpc: 'paused' }
        ], DUSK)
        assertCalls(devices, 'Hallway_Cupboard_Outlet', [{ state: 'OFF' }, { state: 'ON' }],
            'with no history the gate is inert -- the pause still restores the cupboard lamp')
    } finally {
        restoreClock()
    }
}

console.log('\n── Home theater (shipped configs): hallway cupboard lamp rule shape ──\n')

{
    // Both shipped configs must keep the cupboard lamp OUT of the restore rule and in a rule of
    // its own, gated to civil dusk -> midnight, with dark mode still putting it out on playback
    // and both restore paths pinned to a transition that came FROM playing.
    const FILES = [
        { file: 'etc/automation/home-office-video.yaml', host: 'htpc', cupboard: 'Przedpokoj_Gniazdo_Szafka', lux: 700 },
        { file: 'etc/automation/home-office-video.yaml.dist', host: 'my-pc', cupboard: 'Hallway_Cupboard_Outlet', lux: 900 },
    ]
    for (const { file, host, cupboard, lux } of FILES) {
        const full = join(ROOT, file)
        if (!fs.existsSync(full)) continue
        const rules = yamlParse(fs.readFileSync(full, 'utf8')).rules ?? []
        const find = (re) => rules.find((r) => re.test(r.name))
        const restore = find(/restore ambient lighting$/)
        const evening = find(/before midnight/)
        const dark = find(/dark mode/)
        const playerStates = evening?.conditions?.video_player
            ? Object.values(evening.conditions.video_player)[0] : null
        const originGate = (rule) => {
            const from = rule?.conditions?.state_transition?.[`videoPlayer:${host}`]?.from
            return from === undefined ? undefined : (Array.isArray(from) ? from : [from])
        }

        assert(restore && evening && dark, `${file}: restore, before-midnight and dark-mode rules all exist`)
        assert(restore?.targets?.[cupboard] === undefined,
            `${file}: the restore rule no longer targets the cupboard lamp`)
        assert(JSON.stringify(Object.keys(evening?.targets ?? {})) === JSON.stringify([cupboard]),
            `${file}: the before-midnight rule owns the cupboard lamp alone`)
        assert(evening?.targets?.[cupboard] === 'ON', `${file}: the before-midnight rule lights it`)
        assert(evening?.reassert_state === true, `${file}: it re-asserts past a stale cached state`)
        assert(evening?.conditions?.hour?.gte === 'sunset' && evening?.conditions?.hour?.lt === undefined,
            `${file}: its window is \`hour: { gte: sunset }\` -- dusk to midnight, the axis ceiling needs no bound`)
        assert(evening?.conditions?.illuminance?.lt === lux, `${file}: it keeps the restore lux gate (${lux})`)
        assert(JSON.stringify(playerStates) === JSON.stringify(['paused', 'stopped']),
            `${file}: it keys on the same player states as the restore rule`)
        assert(JSON.stringify(originGate(restore)) === JSON.stringify(['playing']),
            `${file}: the restore rule restores only a transition that came from playing`)
        assert(JSON.stringify(originGate(evening)) === JSON.stringify(['playing']),
            `${file}: the cupboard lamp lights only on a transition that came from playing`)
        assert(dark?.targets?.[cupboard] === 'OFF', `${file}: dark mode still puts it out on playback`)
    }
}

console.log('\n── Deployment consistency (shipped etc/automation instances) ──\n')

{
    // Discover every HomeTheaterAutomation subclass shipped under etc/automation/ and
    // cross-check each configured instance against its OWN config -- no hardcoded hosts or
    // device names, so any split (one room, many rooms, bundled) validates itself.
    const ETC_AUTOMATION = join(ROOT, 'etc', 'automation')
    let discovered = 0
    try {
        const modules = await new Autoloader().preloadPath(ETC_AUTOMATION)
        for (const [fileName, mod] of Object.entries(modules)) {
            if (typeof mod !== 'function' || mod === HomeTheaterAutomation) continue
            if (!(mod.prototype instanceof HomeTheaterAutomation)) continue
            discovered++
            /** @type {{config?: object}|null} */
            let instance = null
            try {
                instance = new mod()
            } catch {
                console.log(`  ⊘ ${fileName}: not directly instantiable -- skipped`)
                continue
            }
            const rules = Array.isArray(instance.config?.rules) ? instance.config.rules : []
            if (rules.length === 0) {
                console.log(`  ⊘ ${fileName}: no loaded config (fresh clone ships only .dist templates) -- skipped`)
                continue
            }
            const declared = new Set([
                ...(Array.isArray(instance.config.triggers_video) ? instance.config.triggers_video : []),
                ...(Array.isArray(instance.config.triggers_network) ? instance.config.triggers_network : [])
            ])
            assert(declared.size > 0, `${fileName}: configured instance declares at least one trigger host`)
            // Every host a rule condition references must be able to wake this instance.
            for (const rule of rules) {
                const conditions = rule.conditions ?? {}
                for (const key of ['video_player', 'presence']) {
                    const hosts = (conditions[key] && typeof conditions[key] === 'object') ? Object.keys(conditions[key]) : []
                    for (const host of hosts) {
                        assert(declared.has(host),
                            `${fileName}: rule "${rule.name}" watches host "${host}", which is not in its triggers`)
                    }
                }
                // `state_transition` refs are '<domain>:<subject>'; a video-player origin gate on a
                // host this instance is never woken by would read history it cannot act on.
                const transitions = (conditions['state_transition'] && typeof conditions['state_transition'] === 'object')
                    ? conditions['state_transition'] : {}
                for (const ref of Object.keys(transitions)) {
                    const sep = String(ref).indexOf(':')
                    const domain = sep > 0 ? ref.slice(0, sep) : ''
                    const subject = sep > 0 ? ref.slice(sep + 1) : ref
                    assert(domain === 'videoPlayer',
                        `${fileName}: rule "${rule.name}" gates state_transition on domain "${domain || '(none)'}", expected 'videoPlayer'`)
                    assert(declared.has(subject),
                        `${fileName}: rule "${rule.name}" gates state_transition on host "${subject}", which is not in its triggers`)
                }
            }
            // Trigger topics stay scoped to the declared hosts and sensors only.
            const declaredSensors = new Set(
                Array.isArray(instance.config.triggers_zigbee) ? instance.config.triggers_zigbee : []
            )
            const topics = instance.getTriggerTopics()
            assert(topics.length > 0, `${fileName}: configured instance subscribes to at least one topic`)
            for (const topic of topics) {
                const domain = topic.slice(0, topic.indexOf(':'))
                const subject = topic.slice(topic.indexOf(':') + 1)
                if (domain === 'zigbee') {
                    assert(declaredSensors.has(subject),
                        `${fileName}: subscribed zigbee topic "${topic}" stays within declared sensors`)
                } else {
                    assert(declared.has(subject), `${fileName}: subscribed topic "${topic}" stays within declared hosts`)
                }
            }
        }
    } catch (e) {
        console.log(`  ⊘ etc/automation scan unavailable (${e.message}) -- skipped`)
    }
    if (discovered === 0) {
        console.log('  ⊘ No HomeTheaterAutomation instances found under etc/automation/ (skipped)')
    }
}

console.log('\n── video-player condition (conditionsMatch) ──\n')

{
    const auto = makeInstance(new Map([['stub', makeStubDevice('Stub')]]), 'bundled')

    // playing matches [playing]
    await setVideoStatus('htpc', 'playing')
    assert(await auto.conditionsMatch({ 'video_player': { htpc: 'playing' } }, CONTEXT),
        'video_player: htpc=playing matches [playing]')
    assert(!(await auto.conditionsMatch({ 'video_player': { htpc: ['paused', 'stopped'] } }, CONTEXT)),
        'video_player: htpc=playing rejected by [paused, stopped]')
    // paused matches the not-playing list
    await setVideoStatus('htpc', 'paused')
    assert(await auto.conditionsMatch({ 'video_player': { htpc: ['paused', 'stopped', 'offline'] } }, CONTEXT),
        'video_player: htpc=paused matches not-playing list')
    assert(!(await auto.conditionsMatch({ 'video_player': { htpc: ['playing'] } }, CONTEXT)),
        'video_player: htpc=paused rejected by [playing]')
    // offline matches the not-playing list; both raw causes (player not answering, host down)
    // normalize to it, so the raw input form is irrelevant to matching.
    await setVideoStatus('htpc', 'unreachable')
    assert(await auto.conditionsMatch({ 'video_player': { htpc: ['paused', 'stopped', 'offline'] } }, CONTEXT),
        'video_player: htpc=offline (raw unreachable) matches not-playing list')
    assert(!(await auto.conditionsMatch({ 'video_player': { htpc: ['playing'] } }, CONTEXT)),
        'video_player: offline rejected by [playing]')
    // No recorded status (raw null) enumerates to the same `offline` status: rules that list it
    // match, playback requirements and not-playing lists WITHOUT it stay inert.
    await setVideoStatus('htpc', null)
    assert(await auto.conditionsMatch({ 'video_player': { htpc: ['offline'] } }, CONTEXT),
        'video_player: null status enumerates to offline')
    assert(!(await auto.conditionsMatch({ 'video_player': { htpc: ['playing'] } }, CONTEXT)),
        'video_player: offline does not satisfy a "playing" requirement')
    assert(!(await auto.conditionsMatch({ 'video_player': { htpc: ['paused', 'stopped'] } }, CONTEXT)),
        'video_player: offline does not match a list without offline')

    // Pin the exact condition shape of the office instance's local restore rule: it must fire
    // for afternoon/evening/night darkness and reject morning or readings at/above 900 lux.
    const restoreConditions = {
        'video_player': { htpc: ['paused', 'stopped', 'offline'] },
        'time_of_day': ['afternoon', 'evening', 'night'],
        illuminance: { lt: 900 }
    }
    await setVideoStatus('htpc', 'paused')
    assert(await auto.conditionsMatch(restoreConditions, { timeOfDay: 'afternoon', illuminance: 800 }),
        'restore gate: afternoon darkness matches')
    assert(await auto.conditionsMatch(restoreConditions, { timeOfDay: 'evening', illuminance: 899 }),
        'restore gate: evening just below the bound (899 < 900) matches')
    assert(await auto.conditionsMatch(restoreConditions, { timeOfDay: 'night', illuminance: 15 }),
        'restore gate: pre-dawn night darkness matches')
    assert(!(await auto.conditionsMatch(restoreConditions, { timeOfDay: 'morning', illuminance: 15 })),
        'restore gate: morning is outside the allowed periods even in full darkness')
    assert(!(await auto.conditionsMatch(restoreConditions, { timeOfDay: 'evening', illuminance: 900 })),
        'restore gate: exactly 900 lux rejects (strictly-below bound)')
}

console.log('\n── MPC / VLC provider parse ──\n')

{
    const mpc = new MpcProvider()

    // Minimal page mirroring the real MPC-HC variables.html structure.
    const mpcPage = (statestring, version = '1.9.16.63') =>
        '<!DOCTYPE html><html><body>' +
        '<p id="file">movie.mkv</p>' +
        '<p id="state">0</p>' +
        `<p id="statestring">${statestring}</p>` +
        `<p id="version">${version}</p>` +
        '</body></html>'

    assert(mpc.parse(mpcPage('Playing')) === 'playing', 'mpc: statestring "Playing" -> playing')
    assert(mpc.parse(mpcPage('Paused')) === 'paused', 'mpc: statestring "Paused" -> paused')
    assert(mpc.parse(mpcPage('Stopped')) === 'stopped', 'mpc: statestring "Stopped" -> stopped')
    assert(mpc.parse(mpcPage('')) === 'stopped', 'mpc: empty statestring (no media) -> stopped')

    let threw = false
    try { mpc.parse('<html><body><p id="version">1.9.16.63</p></body></html>') } catch { threw = true }
    assert(threw, 'mpc: missing statestring throws (feeds the strike counter)')

    // Unsupported versions warn once but still parse (fail-safe via regex miss).
    assert(mpc.parse(mpcPage('Playing', '2.1.0')) === 'playing', 'mpc: unsupported version still parses')

    const vlc = new VlcProvider()
    assert(vlc.parse('{"state":"playing"}') === 'playing', 'vlc: state "playing" -> playing')
    assert(vlc.parse('{"state":"paused"}') === 'paused', 'vlc: state "paused" -> paused')
    assert(vlc.parse('{"state":"stopped"}') === 'stopped', 'vlc: state "stopped" -> stopped')
    threw = false
    try { vlc.parse('not json') } catch { threw = true }
    assert(threw, 'vlc: non-JSON response throws (feeds the strike counter)')
}

console.log('\n── override_human_interaction ──\n')

{
    const auto = makeInstance(new Map([['stub', makeStubDevice('Stub')]]), 'office')
    assert(auto.getOverrideHumanInteraction() === true,
        'home theater automation opts into override_human_interaction')

    // A base automation without the flag keeps the default (false).
    class PlainAuto extends RuleBasedAutomationBase {
        constructor() { super({ name: 'Plain', configPath: '/dev/null' }) }
        loadDevices() { return new Map() }
        async buildContext() { return {} }
        resolveCommand() { return null }
    }
    const plain = new PlainAuto()
    assert(plain.getOverrideHumanInteraction() === false,
        'base automation defaults to override off')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)







