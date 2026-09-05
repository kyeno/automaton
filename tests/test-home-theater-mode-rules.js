/**
 * Home Theater Mode automation execution tests.
 *
 * Exercises the rule-based execute() flow end-to-end using stubbed devices and
 * a fabricated video-player status against a self-contained rule set modeled on
 * home-theater-mode.yaml (no local configuration required):
 *   - Player reachable (playing/paused/stopped) -> CLOSE the room's rollers
 *   - Player gone (unknown/unreachable) -> hand rollers back (re-open only what we closed)
 *   - Playing -> OFF interfering lights (dark mode)
 *   - Not playing -> always-on ambient lights return; the rest only if on before dark mode
 *   - Lights already off before dark mode are never forced back on (restore_state_aware)
 *   - Unknown (null) video-player status matches only lists that opt in via 'unknown'
 *   - override_human_interaction bypasses the human-cooldown skip
 *   - MPC/VLC provider parse normalization (including version-lock behavior)
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

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import videoPlayerMonitor from '../src/monitor/videoPlayerMonitor.js'
import MpcProvider from '../src/monitor/providers/mpc.js'
import VlcProvider from '../src/monitor/providers/vlc.js'

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

// ---------------------------------------------------------------------------
// Video-player status injection
// ---------------------------------------------------------------------------

/**
 * Set a video-player status so VideoPlayerMonitor.getStatus() sees it.
 * Uses the monitor's test hook, which seeds the in-memory cache (and Redis
 * when a broker is reachable) without a live player or a running sweep.
 * @param {string} host - Host name
 * @param {string|null} status - Normalized status (or null for unknown)
 */
async function setVideoStatus(host, status) {
    await videoPlayerMonitor.setTestStatus(host, status)
}

// ---------------------------------------------------------------------------
// Stub device
// ---------------------------------------------------------------------------

/**
 * Create a stub device that records received commands and mimics the base
 * class's cached-state read (`getStateLast`) so state-aware restore has
 * something to look at.
 * @param {string} name - Device name
 * @param {Object|null} [initialState=null] - Initial cached state payload
 *   (e.g. `{ state: 'ON' }` for plugs, `{ position: 50 }` for rollers)
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

// ---------------------------------------------------------------------------
// Test automation
// ---------------------------------------------------------------------------

/**
 * Self-contained home-theater-mode automation for testing.
 * Uses a fixed rule set (no YAML file) so the test is independent of the
 * live configuration and device container.
 */
class TestHomeTheaterMode extends RuleBasedAutomationBase {
    /** @type {Map<string, Object>} */ #devices
    /** @type {Object} */ #context

    /**
     * @param {Map<string, Object>} devices - Map of rule-target key -> stub device
     * @param {Object} context - Fabricated sensor context
     */
    constructor(devices, context) {
        super({ name: 'TestHomeTheaterMode', configPath: '/dev/null' })
        this.#devices = devices
        this.#context = context
    }

    loadDevices() { return this.#devices }
    async buildContext() { return this.#context }

    /**
     * Delegate to the shared first-rule-wins resolver, exactly like the
     * production HomeTheaterModeAutomation does.
     */
    resolveCommand(device, targetId, matchingRules) {
        return this.simpleResolveCommand(device, targetId, matchingRules)
    }
}

/**
 * Build a home-theater-mode automation with a fixed rule set.
 * @param {Map<string, Object>} devices
 * @param {Object} context
 * @returns {TestHomeTheaterMode}
 */
function makeHomeTheaterMode(devices, context) {
    const auto = new TestHomeTheaterMode(devices, context)
    auto.config = {
        override_human_interaction: true,
        restore_state_aware: true,
        rules: [
            // Rollers: owned while the player answers HTTP, regardless of state.
            {
                name: 'HTPC: player reachable - close Salon rollers',
                conditions: {
                    'video-player': { htpc: ['playing', 'paused', 'stopped'] }
                },
                targets: { Salon_Roleta_Okno_Lewe: 'CLOSE', Salon_Roleta_Okno_Prawe: 'CLOSE' }
            },
            {
                name: 'HTPC: player gone - hand Salon rollers back',
                conditions: {
                    'video-player': { htpc: ['unknown', 'unreachable'] }
                },
                targets: { Salon_Roleta_Okno_Lewe: 'OPEN', Salon_Roleta_Okno_Prawe: 'OPEN' }
            },
            {
                name: 'Bedroom: player reachable - close Sypialnia rollers',
                conditions: {
                    'video-player': { bedroom: ['playing', 'paused', 'stopped'] }
                },
                targets: { Sypialnia_Roleta_Okno_Lewe_Lewa: 'CLOSE' }
            },
            {
                name: 'Bedroom: player gone - hand Sypialnia rollers back',
                conditions: {
                    'video-player': { bedroom: ['unknown', 'unreachable'] }
                },
                targets: { Sypialnia_Roleta_Okno_Lewe_Lewa: 'OPEN' }
            },
            // Lights: playback controls them, the player merely being open does not.
            // (Presence conditions are omitted here only because the test fabricates
            // statuses directly; production keeps presence on the light rules.)
            {
                name: 'HTPC: not playing - always-on ambient lights',
                conditions: {
                    'video-player': { htpc: ['paused', 'stopped', 'unreachable', 'unknown'] }
                },
                force_restore: true,
                targets: { Przedpokoj_Gniazdo: 'ON' }
            },
            {
                name: 'HTPC: not playing - restore remaining lights (state-aware)',
                conditions: {
                    'video-player': { htpc: ['paused', 'stopped', 'unreachable', 'unknown'] }
                },
                targets: { Kuchnia_Gniazdo: 'ON' }
            },
            {
                name: 'HTPC: playing - dark mode',
                conditions: {
                    'video-player': { htpc: ['playing'] }
                },
                targets: { Przedpokoj_Gniazdo: 'OFF', Kuchnia_Gniazdo: 'OFF' }
            },
            {
                name: 'Bedroom: not playing - restore ambient lights (state-aware)',
                conditions: {
                    'video-player': { bedroom: ['paused', 'stopped', 'unreachable', 'unknown'] }
                },
                targets: { Sypialnia_Gniazdo: 'ON' }
            },
            {
                name: 'Bedroom: playing - dark mode',
                conditions: {
                    'video-player': { bedroom: ['playing'] }
                },
                targets: { Sypialnia_Gniazdo: 'OFF' }
            }
        ]
    }
    // #overrideHumanInteraction is captured from config in the base constructor; we inject
    // the config post-construction here, so mirror it through the public setter to match
    // what a YAML-driven construction yields (home-theater-mode.yaml sets override_human_interaction).
    auto.setOverrideHumanInteraction(Boolean(auto.config.override_human_interaction))
    return auto
}

/**
 * Run a sequence of home-theater steps against ONE automation instance, so
 * state-aware restore memory persists across steps exactly like in production.
 * @param {Map<string, Object>} devices - Device map
 * @param {{htpc: string|null, bedroom: string|null}[]} steps - Status before each execute() tick
 * @returns {Promise<Map<string, Object>>} The device map
 */
async function runSequence(devices, steps) {
    const auto = makeHomeTheaterMode(devices, CONTEXT)
    for (const step of steps) {
        await setVideoStatus('htpc', step.htpc)
        await setVideoStatus('bedroom', step.bedroom)
        await auto.execute({ trigger: 'test' })
    }
    return devices
}

/**
 * Assert a device received exactly the expected payload sequence (and that
 * every dispatched command was automation-originated).
 * @param {Map<string, Object>} devices
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

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const CONTEXT = { timeOfDay: 'evening' }

/**
 * Build the standard device map for a home-theater scenario: living-room
 * ambient lights on, kitchen plug off, rollers mid-way.
 * @returns {Map<string, Object>}
 */
function makeDevices() {
    return new Map([
        ['Przedpokoj_Gniazdo', makeStubDevice('Przedpokoj Gniazdo', { state: 'ON' })],
        ['Kuchnia_Gniazdo', makeStubDevice('Kuchnia Gniazdo', { state: 'OFF' })],
        ['Salon_Roleta_Okno_Lewe', makeStubDevice('Salon Roleta Okno Lewe', { position: 50 })],
        ['Salon_Roleta_Okno_Prawe', makeStubDevice('Salon Roleta Okno Prawe', { position: 50 })],
        ['Sypialnia_Gniazdo', makeStubDevice('Sypialnia Gniazdo', { state: 'ON' })],
        ['Sypialnia_Roleta_Okno_Lewe_Lewa', makeStubDevice('Sypialnia Roleta Okno Lewe Lewa', { position: 50 })]
    ])
}

/**
 * Build the standard device map with everything already dark/off.
 * @returns {Map<string, Object>}
 */
function makeDevicesDark() {
    const devices = makeDevices()
    for (const dev of devices.values()) {
        if (dev.stateLast?.state !== undefined) dev.stateLast = { state: 'OFF' }
        else if (dev.stateLast?.position !== undefined) dev.stateLast = { position: 0 }
    }
    return devices
}

console.log('\n── Home theater mode: dark mode, pause restores only what was on ──\n')

{
    const devices = await runSequence(makeDevices(), [
        { htpc: 'playing', bedroom: 'stopped' },
        { htpc: 'paused', bedroom: 'stopped' }
    ])
    assertCalls(devices, 'Przedpokoj_Gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'Przedpokoj_Gniazdo: OFF then restored ON (always-on ambient, force_restore)')
    assertCalls(devices, 'Kuchnia_Gniazdo', [],
        'Kuchnia_Gniazdo: silent (OFF no-op -- already off; ON skipped -- no memory)')
    assertCalls(devices, 'Salon_Roleta_Okno_Lewe', ['CLOSE'],
        'Salon_Roleta_Okno_Lewe: CLOSE once (paused re-tick suppressed as no-op)')
    assertCalls(devices, 'Salon_Roleta_Okno_Prawe', ['CLOSE'],
        'Salon_Roleta_Okno_Prawe: CLOSE once (paused re-tick suppressed as no-op)')
    // Bedroom player open but idle: its roller is still owned (closed), and the
    // still-on ambient light is an ON no-op -- never double-commanded.
    assertCalls(devices, 'Sypialnia_Gniazdo', [],
        'Sypialnia_Gniazdo: silent (still on -- ON no-op)')
    assertCalls(devices, 'Sypialnia_Roleta_Okno_Lewe_Lewa', ['CLOSE'],
        'Sypialnia_Roleta_Okno_Lewe_Lewa: CLOSE once (player reachable though idle)')
}

console.log('\n── Home theater mode: already-dark room, only the always-on ambient returns ──\n')

{
    // Everything starts off/closed: dark mode dispatches nothing at all, and
    // on pause only the force_restore ambient is asserted back on. State-aware
    // lights that were off before dark mode are never forced back on.
    const devices = await runSequence(makeDevicesDark(), [
        { htpc: 'playing', bedroom: 'stopped' },
        { htpc: 'paused', bedroom: 'stopped' }
    ])
    assertCalls(devices, 'Przedpokoj_Gniazdo', [{ state: 'ON' }],
        'Przedpokoj_Gniazdo: forced ON on pause (force_restore ambient)')
    assertCalls(devices, 'Kuchnia_Gniazdo', [],
        'Kuchnia_Gniazdo: never forced back on (was off, no memory)')
    assertCalls(devices, 'Salon_Roleta_Okno_Lewe', [], 'Salon_Roleta_Okno_Lewe: CLOSE suppressed (already closed)')
    assertCalls(devices, 'Salon_Roleta_Okno_Prawe', [], 'Salon_Roleta_Okno_Prawe: CLOSE suppressed (already closed)')
    assertCalls(devices, 'Sypialnia_Gniazdo', [], 'Sypialnia_Gniazdo: never forced back on')
    assertCalls(devices, 'Sypialnia_Roleta_Okno_Lewe_Lewa', [], 'Sypialnia_Roleta_Okno_Lewe_Lewa: CLOSE suppressed (already closed)')
}

console.log('\n── Home theater mode: both playing (full dark) ──\n')

{
    const devices = await runSequence(makeDevices(), [{ htpc: 'playing', bedroom: 'playing' }])
    assertCalls(devices, 'Przedpokoj_Gniazdo', [{ state: 'OFF' }], 'Przedpokoj_Gniazdo: OFF')
    assertCalls(devices, 'Kuchnia_Gniazdo', [], 'Kuchnia_Gniazdo: OFF suppressed (already off)')
    assertCalls(devices, 'Salon_Roleta_Okno_Lewe', ['CLOSE'], 'Salon_Roleta_Okno_Lewe: CLOSE')
    assertCalls(devices, 'Salon_Roleta_Okno_Prawe', ['CLOSE'], 'Salon_Roleta_Okno_Prawe: CLOSE')
    assertCalls(devices, 'Sypialnia_Gniazdo', [{ state: 'OFF' }], 'Sypialnia_Gniazdo: OFF')
    assertCalls(devices, 'Sypialnia_Roleta_Okno_Lewe_Lewa', ['CLOSE'], 'Sypialnia_Roleta_Okno_Lewe_Lewa: CLOSE')
}

console.log('\n── Home theater mode: movie ends (stopped) -- lights return, rollers stay owned ──\n')

{
    // Stopped still means the player answers HTTP: the rollers remain owned
    // (closed, no re-open) and only the lights come back. Hand-back happens
    // when the player disappears, not when playback ends.
    const devices = await runSequence(makeDevices(), [
        { htpc: 'playing', bedroom: 'playing' },
        { htpc: 'stopped', bedroom: 'stopped' }
    ])
    assertCalls(devices, 'Przedpokoj_Gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'Przedpokoj_Gniazdo: OFF then restored ON')
    assertCalls(devices, 'Kuchnia_Gniazdo', [],
        'Kuchnia_Gniazdo: silent (was off before dark mode)')
    assertCalls(devices, 'Salon_Roleta_Okno_Lewe', ['CLOSE'],
        'Salon_Roleta_Okno_Lewe: CLOSE only (stopped keeps the rollers owned)')
    assertCalls(devices, 'Salon_Roleta_Okno_Prawe', ['CLOSE'], 'Salon_Roleta_Okno_Prawe: CLOSE only')
    assertCalls(devices, 'Sypialnia_Gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'Sypialnia_Gniazdo: OFF then restored ON (state-aware memory)')
    assertCalls(devices, 'Sypialnia_Roleta_Okno_Lewe_Lewa', ['CLOSE'], 'Sypialnia_Roleta_Okno_Lewe_Lewa: CLOSE only')
}

console.log('\n── Home theater mode: roller ownership lifecycle (reachable -> gone -> reachable) ──\n')

{
    // Rollers are owned while the player answers HTTP (any state) and handed
    // back when it disappears: unknown (null) and unreachable both trigger the
    // hand-back, which re-opens only what this automation closed itself.
    // Repeated ticks in the same state are suppressed as no-ops. The bedroom
    // player is gone throughout, so its roller (never closed here) must never
    // be opened by the hand-back rule.
    const devices = await runSequence(makeDevices(), [
        { htpc: 'playing', bedroom: null },
        { htpc: 'paused', bedroom: null },
        { htpc: null, bedroom: null },
        { htpc: null, bedroom: null },
        { htpc: 'playing', bedroom: null },
        { htpc: 'unreachable', bedroom: null }
    ])
    assertCalls(devices, 'Salon_Roleta_Okno_Lewe', ['CLOSE', 'OPEN', 'CLOSE', 'OPEN'],
        'Salon_Roleta_Okno_Lewe: CLOSE, hand-back OPEN on unknown, re-owned CLOSE, OPEN on unreachable')
    assertCalls(devices, 'Salon_Roleta_Okno_Prawe', ['CLOSE', 'OPEN', 'CLOSE', 'OPEN'],
        'Salon_Roleta_Okno_Prawe: CLOSE, OPEN, CLOSE, OPEN')
    assertCalls(devices, 'Przedpokoj_Gniazdo',
        [{ state: 'OFF' }, { state: 'ON' }, { state: 'OFF' }, { state: 'ON' }],
        'Przedpokoj_Gniazdo: dark mode and restore follow playback, not ownership')
    assertCalls(devices, 'Kuchnia_Gniazdo', [], 'Kuchnia_Gniazdo: silent throughout')
    assertCalls(devices, 'Sypialnia_Roleta_Okno_Lewe_Lewa', [],
        'Sypialnia_Roleta_Okno_Lewe_Lewa: never opened (automation never closed it)')
    assertCalls(devices, 'Sypialnia_Gniazdo', [],
        'Sypialnia_Gniazdo: silent (still on -- ON no-op)')
}

console.log('\n── Home theater mode: rollers found closed are never opened on hand-back ──\n')

{
    // The Salon rollers start closed (position 0): the reachable rule's CLOSE
    // is a no-op and writes no snapshot, so the later hand-back OPEN must not
    // fire -- blinds this automation did not close stay as they are.
    const devices = makeDevices()
    devices.get('Salon_Roleta_Okno_Lewe').stateLast = { position: 0 }
    devices.get('Salon_Roleta_Okno_Prawe').stateLast = { position: 0 }
    const after = await runSequence(devices, [
        { htpc: 'playing', bedroom: null },
        { htpc: null, bedroom: null }
    ])
    assertCalls(after, 'Salon_Roleta_Okno_Lewe', [],
        'Salon_Roleta_Okno_Lewe: stays closed (CLOSE no-op, OPEN without ownership)')
    assertCalls(after, 'Salon_Roleta_Okno_Prawe', [], 'Salon_Roleta_Okno_Prawe: stays closed')
    assertCalls(after, 'Przedpokoj_Gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'Przedpokoj_Gniazdo: lights still cycle normally')
    assertCalls(after, 'Kuchnia_Gniazdo', [], 'Kuchnia_Gniazdo: silent')
    assertCalls(after, 'Sypialnia_Roleta_Okno_Lewe_Lewa', [], 'Sypialnia_Roleta_Okno_Lewe_Lewa: never opened')
}

console.log('\n── Home theater mode: players vanish mid-movie (unknown) -- full hand-back ──\n')

{
    // Both machines disappear (unknown/null): the rollers are handed back in
    // both rooms and the remembered lights return; the kitchen plug (off
    // before dark mode) stays off.
    const devices = await runSequence(makeDevices(), [
        { htpc: 'playing', bedroom: 'playing' },
        { htpc: null, bedroom: null }
    ])
    assertCalls(devices, 'Przedpokoj_Gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'Przedpokoj_Gniazdo: OFF then restored ON')
    assertCalls(devices, 'Kuchnia_Gniazdo', [], 'Kuchnia_Gniazdo: silent (was off before)')
    assertCalls(devices, 'Salon_Roleta_Okno_Lewe', ['CLOSE', 'OPEN'],
        'Salon_Roleta_Okno_Lewe: CLOSE then hand-back OPEN')
    assertCalls(devices, 'Salon_Roleta_Okno_Prawe', ['CLOSE', 'OPEN'], 'Salon_Roleta_Okno_Prawe: CLOSE then OPEN')
    assertCalls(devices, 'Sypialnia_Gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'Sypialnia_Gniazdo: OFF then restored ON')
    assertCalls(devices, 'Sypialnia_Roleta_Okno_Lewe_Lewa', ['CLOSE', 'OPEN'],
        'Sypialnia_Roleta_Okno_Lewe_Lewa: CLOSE then hand-back OPEN')
}

// ---------------------------------------------------------------------------
// video-player condition unit checks
// ---------------------------------------------------------------------------

console.log('\n── video-player condition (conditionsMatch) ──\n')

{
    const auto = makeHomeTheaterMode(new Map([['stub', makeStubDevice('Stub')]]), CONTEXT)

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

// ---------------------------------------------------------------------------
// Provider parse checks (real MPC-HC 1.9.16.63 page shape, VLC status.json)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// override_human_interaction check
// ---------------------------------------------------------------------------

console.log('\n── override_human_interaction ──\n')

{
    const auto = makeHomeTheaterMode(new Map([['stub', makeStubDevice('Stub')]]), CONTEXT)
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