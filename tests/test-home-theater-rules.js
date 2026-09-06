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
 * including the explicit `unknown` token, override_human_interaction wiring,
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

import { join, resolve } from 'node:path'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import AutomationContainer from '../src/automation/container/automationContainer.js'
import Autoloader from '../src/lib/autoloader.js'
import videoPlayerMonitor from '../src/monitor/videoPlayerMonitor.js'
import MpcProvider from '../src/monitor/providers/mpc.js'
import VlcProvider from '../src/monitor/providers/vlc.js'
import HomeTheaterAutomation from '../etc/automation/homeTheaterBase.js'

const ROOT = resolve(import.meta.dirname, '..')

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
 * @param {string|null} status - Normalized status (or null for unknown)
 */
async function setVideoStatus(host, status) {
    await videoPlayerMonitor.setTestStatus(host, status)
}

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

const CONTEXT = { timeOfDay: 'evening' }

// ---------------------------------------------------------------------------
// Deployment shapes under test
// ---------------------------------------------------------------------------

/** Office-room device map (single playback setup): ambient plug on, kitchen off, roller mid-way. */
function makeOfficeDevices(dark = false) {
    return new Map([
        ['Living_Room_Plug', makeStubDevice('Living Room Plug', { state: dark ? 'OFF' : 'ON' })],
        ['Kitchen_Plug', makeStubDevice('Kitchen Plug', { state: 'OFF' })],
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
    { name: 'Office: player reachable - close rollers', conditions: { 'video-player': { htpc: ['playing', 'paused', 'stopped'] } }, targets: { Living_Room_Roller_Left: 'CLOSE' } },
    { name: 'Office: player gone - hand rollers back to their owner', conditions: { 'video-player': { htpc: ['unknown', 'unreachable'] } }, invoke_automation: { name: 'HomeOfficeRollersAutomation', force: true } },
    { name: 'Office: not playing - delegate light restore to ambient lights', conditions: { 'video-player': { htpc: ['paused', 'stopped', 'unreachable', 'unknown'] } }, invoke_automation: { name: 'AmbientLightsAutomation', force: true } },
    { name: 'Office: playing - dark mode (lights off)', conditions: { 'video-player': { htpc: ['playing'] } }, targets: { Living_Room_Plug: 'OFF', Kitchen_Plug: 'OFF' } }
]

const RULES_BUNDLED = [
    ...RULES_OFFICE,
    { name: 'Bedroom: player reachable - close rollers', conditions: { 'video-player': { bedroom: ['playing', 'paused', 'stopped'] } }, targets: { Bedroom_Roller_Left: 'CLOSE' } },
    { name: 'Bedroom: player gone - hand rollers back to their owner', conditions: { 'video-player': { bedroom: ['unknown', 'unreachable'] } }, invoke_automation: { name: 'BedroomRollersAutomation', force: true } },
    { name: 'Bedroom: not playing - delegate light restore to ambient lights', conditions: { 'video-player': { bedroom: ['paused', 'stopped', 'unreachable', 'unknown'] } }, invoke_automation: { name: 'AmbientLightsAutomation', force: true } },
    { name: 'Bedroom: playing - dark mode (lights off)', conditions: { 'video-player': { bedroom: ['playing'] } }, targets: { Bedroom_Plug: 'OFF' } }
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
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated to ambient-lights (no local ON)')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }],
        'Kitchen_Plug: OFF on the playing tick (redundant commands no longer suppressed)')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE'],
        'Living_Room_Roller_Left: re-closed on every reachable tick (playing + paused)')
    // Bedroom player open but idle: its roller is still owned (closed); light restore is
    // delegated rather than sent locally.
    assertCalls(devices, 'Bedroom_Plug', [],
        'Bedroom_Plug: silent (restore delegated to ambient-lights)')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE', 'CLOSE'],
        'Bedroom_Roller_Left: re-closed on every reachable tick (stopped both ticks)')
    // Delegation: both not-playing ticks hand light restore to the ambient-lights owner.
    assert(invocationCount('AmbientLightsAutomation') === 2 && allForced('AmbientLightsAutomation'),
        'ambient-lights invoked on each not-playing tick (forced)')
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
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }], 'Living_Room_Plug: OFF re-sent even though already dark (restore still delegated)')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF re-sent on the playing tick')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE'], 'Living_Room_Roller_Left: re-closed each reachable tick (idempotent)')
    assertCalls(devices, 'Bedroom_Plug', [], 'Bedroom_Plug: silent (restore delegated)')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE', 'CLOSE'], 'Bedroom_Roller_Left: re-closed each reachable tick (idempotent)')
    // Delegation still happens even though no local light command is sent.
    assert(invocationCount('AmbientLightsAutomation') === 2 && allForced('AmbientLightsAutomation'),
        'ambient-lights invoked on each not-playing tick (forced), despite a fully-dark room')
}

console.log('\n── Home theater (bundled instance): both playing (full dark) ──\n')

{
    // Both machines actively playing: full dark mode locally; nothing is delegated because
    // the players are reachable and not in a "not-playing" state.
    resetInvocations()
    const devices = await runSequence('bundled', makeBundledDevices(), [{ htpc: 'playing', bedroom: 'playing' }])
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }], 'Living_Room_Plug: OFF')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF (dark mode dispatches regardless of prior state)')
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
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; stopped-tick restore delegated (no local ON)')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }],
        'Kitchen_Plug: OFF on the playing tick; nothing more after stop')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE'],
        'Living_Room_Roller_Left: re-closed each reachable tick (playing + stopped)')
    assertCalls(devices, 'Bedroom_Plug', [{ state: 'OFF' }],
        'Bedroom_Plug: OFF on play; stopped-tick restore delegated')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE', 'CLOSE'], 'Bedroom_Roller_Left: re-closed each reachable tick')
    // Both rooms go "not playing" together on the second tick -> one deduped ambient-lights call.
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'ambient-lights invoked once for the shared not-playing tick (forced)')
}

console.log('\n── Home theater (bundled instance): roller ownership lifecycle (reachable -> gone -> reachable) ──\n')

{
    // Rollers are owned while the player answers HTTP (any state); when it disappears
    // (unknown/null or unreachable) home-theater hands control back to the room's roller
    // owner instead of re-opening locally. The bedroom player is gone throughout, so its
    // roller is never closed by us -- only ever delegated. Redundant CLOSE/OFF commands are
    // still dispatched whenever their rule matches; the delegation counts below are what matter.
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
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }, { state: 'OFF' }],
        'Living_Room_Plug: OFF on each playing tick (t1,t5); restore delegated otherwise')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }, { state: 'OFF' }], 'Kitchen_Plug: OFF on each playing tick (t1,t5)')
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
        'ambient restore delegated on every not-playing tick, forced')
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
    assertCalls(after, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated when HTPC goes offline')
    assertCalls(after, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF on the playing tick')
    assertCalls(after, 'Bedroom_Roller_Left', [], 'Bedroom_Roller_Left: never opened')
    // Delegation happened even though the local rollers stayed put.
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'office hand-back delegated once when HTPC went offline, forced')
    assert(invocationCount('BedroomRollersAutomation') === 2 && allForced('BedroomRollersAutomation'),
        'bedroom hand-back delegated both ticks (player gone), forced')
    assert(invocationCount('AmbientLightsAutomation') === 2 && allForced('AmbientLightsAutomation'),
        'ambient restore delegated both not-playing ticks, forced')
}

console.log('\n── Home theater (bundled instance): players vanish mid-movie (unknown) -- full hand-back ──\n')

{
    // Both machines disappear (unknown/null): home-theater hands the rollers back to each
    // room's owner and delegates light restore to ambient-lights -- nothing is re-opened or
    // switched on locally anymore. Each device only ever sees its single dark-mode command.
    resetInvocations()
    const devices = await runSequence('bundled', makeBundledDevices(), [
        { htpc: 'playing', bedroom: 'playing' },
        { htpc: null, bedroom: null }
    ])
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; hand-back tick restores via delegation')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF on the playing tick; hand-back tick delegates')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE'],
        'Living_Room_Roller_Left: CLOSE then delegated hand-back (no local OPEN)')
    assertCalls(devices, 'Bedroom_Plug', [{ state: 'OFF' }],
        'Bedroom_Plug: OFF on play; restore delegated')
    assertCalls(devices, 'Bedroom_Roller_Left', ['CLOSE'],
        'Bedroom_Roller_Left: CLOSE then delegated hand-back')
    // Full hand-back in one offline tick: each owner invoked once, forced.
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'office rollers handed back to HomeOfficeRollersAutomation (forced)')
    assert(invocationCount('BedroomRollersAutomation') === 1 && allForced('BedroomRollersAutomation'),
        'bedroom rollers handed back to BedroomRollersAutomation (forced)')
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'light restore delegated to AmbientLightsAutomation (forced), deduped across rooms')
}

console.log('\n── Home theater (single-room instance): dark mode, pause restores only what was on ──\n')

{
    resetInvocations()
    const devices = await runSequence('office', makeOfficeDevices(), [
        { htpc: 'playing' },
        { htpc: 'paused' }
    ])
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated to ambient-lights (no local ON)')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }],
        'Kitchen_Plug: OFF on the playing tick (redundant commands no longer suppressed)')
    assertCalls(devices, 'Living_Room_Roller_Left', ['CLOSE', 'CLOSE'],
        'Living_Room_Roller_Left: re-closed on every reachable tick (playing + paused)')
    // Delegation while the player stays reachable: light restore on the paused tick only -- never a roller hand-back.
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'ambient-lights invoked once for the single not-playing tick (forced)')
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
    assertCalls(devices, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated when the player goes offline')
    assertCalls(devices, 'Kitchen_Plug', [{ state: 'OFF' }], 'Kitchen_Plug: OFF on the playing tick')
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'rollers handed back to this room\'s owner exactly once (forced)')
    assert(invocationCount('BedroomRollersAutomation') === 0,
        "a foreign room's owner is never invoked from a single-room instance")
    assert(invocationCount('AmbientLightsAutomation') === 1 && allForced('AmbientLightsAutomation'),
        'light restore delegated once for the offline tick (forced)')
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
    assertCalls(after, 'Living_Room_Plug', [{ state: 'OFF' }],
        'Living_Room_Plug: OFF on play; restore delegated when the player goes offline')
    assert(invocationCount('HomeOfficeRollersAutomation') === 1 && allForced('HomeOfficeRollersAutomation'),
        'hand-back delegated once when the player went offline, forced')
    assert(invocationCount('BedroomRollersAutomation') === 0,
        "a foreign room's owner is never invoked from a single-room instance")
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
                for (const key of ['video-player', 'presence']) {
                    const hosts = (conditions[key] && typeof conditions[key] === 'object') ? Object.keys(conditions[key]) : []
                    for (const host of hosts) {
                        assert(declared.has(host),
                            `${fileName}: rule "${rule.name}" watches host "${host}", which is not in its triggers`)
                    }
                }
            }
            // Trigger topics stay scoped to the declared hosts only.
            const topics = instance.getTriggerTopics()
            assert(topics.length > 0, `${fileName}: configured instance subscribes to at least one topic`)
            for (const topic of topics) {
                const host = topic.slice(topic.indexOf(':') + 1)
                assert(declared.has(host), `${fileName}: subscribed topic "${topic}" stays within declared hosts`)
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
    assert(await auto.conditionsMatch({ 'video-player': { htpc: 'playing' } }, CONTEXT),
        'video-player: htpc=playing matches [playing]')
    assert(!(await auto.conditionsMatch({ 'video-player': { htpc: ['paused', 'stopped'] } }, CONTEXT)),
        'video-player: htpc=playing rejected by [paused, stopped]')
    // paused matches the not-playing list
    await setVideoStatus('htpc', 'paused')
    assert(await auto.conditionsMatch({ 'video-player': { htpc: ['paused', 'stopped', 'unreachable'] } }, CONTEXT),
        'video-player: htpc=paused matches not-playing list')
    assert(!(await auto.conditionsMatch({ 'video-player': { htpc: ['playing'] } }, CONTEXT)),
        'video-player: htpc=paused rejected by [playing]')
    // unreachable matches the not-playing list
    await setVideoStatus('htpc', 'unreachable')
    assert(await auto.conditionsMatch({ 'video-player': { htpc: ['paused', 'stopped', 'unreachable'] } }, CONTEXT),
        'video-player: htpc=unreachable matches not-playing list')
    assert(!(await auto.conditionsMatch({ 'video-player': { htpc: ['unknown'] } }, CONTEXT)),
        'video-player: unreachable is a real status, not the unknown token')
    // Unknown (null) status: matches ONLY lists that explicitly opt in via the
    // 'unknown' token (ambient restore, ownership hand-back). Playback
    // requirements and plain not-playing lists stay inert on a guess.
    await setVideoStatus('htpc', null)
    assert(!(await auto.conditionsMatch({ 'video-player': { htpc: ['playing'] } }, CONTEXT)),
        'video-player: unknown status does not satisfy a "playing" requirement')
    assert(!(await auto.conditionsMatch({ 'video-player': { htpc: ['paused', 'stopped'] } }, CONTEXT)),
        'video-player: unknown status does not match a list without the unknown token')
    assert(await auto.conditionsMatch({ 'video-player': { htpc: ['paused', 'stopped', 'unknown'] } }, CONTEXT),
        'video-player: unknown status matches a list that opts in via unknown')
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







