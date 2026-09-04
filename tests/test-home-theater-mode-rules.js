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
     * @param {Map<string, Object>} devices - Map of target id -> stub device
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
                    videoPlayer: { htpc: ['playing', 'paused', 'stopped'] }
                },
                targets: { htpc_salon_lewe: 'CLOSE', htpc_salon_prawe: 'CLOSE' }
            },
            {
                name: 'HTPC: player gone - hand Salon rollers back',
                conditions: {
                    videoPlayer: { htpc: ['unknown', 'unreachable'] }
                },
                targets: { htpc_salon_lewe: 'OPEN', htpc_salon_prawe: 'OPEN' }
            },
            {
                name: 'Bedroom: player reachable - close Sypialnia rollers',
                conditions: {
                    videoPlayer: { bedroom: ['playing', 'paused', 'stopped'] }
                },
                targets: { bedroom_syp_lewe_lewa: 'CLOSE' }
            },
            {
                name: 'Bedroom: player gone - hand Sypialnia rollers back',
                conditions: {
                    videoPlayer: { bedroom: ['unknown', 'unreachable'] }
                },
                targets: { bedroom_syp_lewe_lewa: 'OPEN' }
            },
            // Lights: playback controls them, the player merely being open does not.
            // (Presence conditions are omitted here only because the test fabricates
            // statuses directly; production keeps presence on the light rules.)
            {
                name: 'HTPC: not playing - always-on ambient lights',
                conditions: {
                    videoPlayer: { htpc: ['paused', 'stopped', 'unreachable', 'unknown'] }
                },
                force_restore: true,
                targets: { htpc_przedp_gniazdo: 'ON' }
            },
            {
                name: 'HTPC: not playing - restore remaining lights (state-aware)',
                conditions: {
                    videoPlayer: { htpc: ['paused', 'stopped', 'unreachable', 'unknown'] }
                },
                targets: { htpc_kuchnia_gniazdo: 'ON' }
            },
            {
                name: 'HTPC: playing - dark mode',
                conditions: {
                    videoPlayer: { htpc: ['playing'] }
                },
                targets: { htpc_przedp_gniazdo: 'OFF', htpc_kuchnia_gniazdo: 'OFF' }
            },
            {
                name: 'Bedroom: not playing - restore ambient lights (state-aware)',
                conditions: {
                    videoPlayer: { bedroom: ['paused', 'stopped', 'unreachable', 'unknown'] }
                },
                targets: { bedroom_sypialnia_gniazdo: 'ON' }
            },
            {
                name: 'Bedroom: playing - dark mode',
                conditions: {
                    videoPlayer: { bedroom: ['playing'] }
                },
                targets: { bedroom_sypialnia_gniazdo: 'OFF' }
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
 * @param {string} id - Target id
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
        ['htpc_przedp_gniazdo', makeStubDevice('Przedpokoj Gniazdo', { state: 'ON' })],
        ['htpc_kuchnia_gniazdo', makeStubDevice('Kuchnia Gniazdo', { state: 'OFF' })],
        ['htpc_salon_lewe', makeStubDevice('Salon Roleta Okno Lewe', { position: 50 })],
        ['htpc_salon_prawe', makeStubDevice('Salon Roleta Okno Prawe', { position: 50 })],
        ['bedroom_sypialnia_gniazdo', makeStubDevice('Sypialnia Gniazdo', { state: 'ON' })],
        ['bedroom_syp_lewe_lewa', makeStubDevice('Sypialnia Roleta Okno Lewe Lewa', { position: 50 })]
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
    assertCalls(devices, 'htpc_przedp_gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'htpc_przedp_gniazdo: OFF then restored ON (always-on ambient, force_restore)')
    assertCalls(devices, 'htpc_kuchnia_gniazdo', [],
        'htpc_kuchnia_gniazdo: silent (OFF no-op -- already off; ON skipped -- no memory)')
    assertCalls(devices, 'htpc_salon_lewe', ['CLOSE'],
        'htpc_salon_lewe: CLOSE once (paused re-tick suppressed as no-op)')
    assertCalls(devices, 'htpc_salon_prawe', ['CLOSE'],
        'htpc_salon_prawe: CLOSE once (paused re-tick suppressed as no-op)')
    // Bedroom player open but idle: its roller is still owned (closed), and the
    // still-on ambient light is an ON no-op -- never double-commanded.
    assertCalls(devices, 'bedroom_sypialnia_gniazdo', [],
        'bedroom_sypialnia_gniazdo: silent (still on -- ON no-op)')
    assertCalls(devices, 'bedroom_syp_lewe_lewa', ['CLOSE'],
        'bedroom_syp_lewe_lewa: CLOSE once (player reachable though idle)')
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
    assertCalls(devices, 'htpc_przedp_gniazdo', [{ state: 'ON' }],
        'htpc_przedp_gniazdo: forced ON on pause (force_restore ambient)')
    assertCalls(devices, 'htpc_kuchnia_gniazdo', [],
        'htpc_kuchnia_gniazdo: never forced back on (was off, no memory)')
    assertCalls(devices, 'htpc_salon_lewe', [], 'htpc_salon_lewe: CLOSE suppressed (already closed)')
    assertCalls(devices, 'htpc_salon_prawe', [], 'htpc_salon_prawe: CLOSE suppressed (already closed)')
    assertCalls(devices, 'bedroom_sypialnia_gniazdo', [], 'bedroom_sypialnia_gniazdo: never forced back on')
    assertCalls(devices, 'bedroom_syp_lewe_lewa', [], 'bedroom_syp_lewe_lewa: CLOSE suppressed (already closed)')
}

console.log('\n── Home theater mode: both playing (full dark) ──\n')

{
    const devices = await runSequence(makeDevices(), [{ htpc: 'playing', bedroom: 'playing' }])
    assertCalls(devices, 'htpc_przedp_gniazdo', [{ state: 'OFF' }], 'htpc_przedp_gniazdo: OFF')
    assertCalls(devices, 'htpc_kuchnia_gniazdo', [], 'htpc_kuchnia_gniazdo: OFF suppressed (already off)')
    assertCalls(devices, 'htpc_salon_lewe', ['CLOSE'], 'htpc_salon_lewe: CLOSE')
    assertCalls(devices, 'htpc_salon_prawe', ['CLOSE'], 'htpc_salon_prawe: CLOSE')
    assertCalls(devices, 'bedroom_sypialnia_gniazdo', [{ state: 'OFF' }], 'bedroom_sypialnia_gniazdo: OFF')
    assertCalls(devices, 'bedroom_syp_lewe_lewa', ['CLOSE'], 'bedroom_syp_lewe_lewa: CLOSE')
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
    assertCalls(devices, 'htpc_przedp_gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'htpc_przedp_gniazdo: OFF then restored ON')
    assertCalls(devices, 'htpc_kuchnia_gniazdo', [],
        'htpc_kuchnia_gniazdo: silent (was off before dark mode)')
    assertCalls(devices, 'htpc_salon_lewe', ['CLOSE'],
        'htpc_salon_lewe: CLOSE only (stopped keeps the rollers owned)')
    assertCalls(devices, 'htpc_salon_prawe', ['CLOSE'], 'htpc_salon_prawe: CLOSE only')
    assertCalls(devices, 'bedroom_sypialnia_gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'bedroom_sypialnia_gniazdo: OFF then restored ON (state-aware memory)')
    assertCalls(devices, 'bedroom_syp_lewe_lewa', ['CLOSE'], 'bedroom_syp_lewe_lewa: CLOSE only')
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
    assertCalls(devices, 'htpc_salon_lewe', ['CLOSE', 'OPEN', 'CLOSE', 'OPEN'],
        'htpc_salon_lewe: CLOSE, hand-back OPEN on unknown, re-owned CLOSE, OPEN on unreachable')
    assertCalls(devices, 'htpc_salon_prawe', ['CLOSE', 'OPEN', 'CLOSE', 'OPEN'],
        'htpc_salon_prawe: CLOSE, OPEN, CLOSE, OPEN')
    assertCalls(devices, 'htpc_przedp_gniazdo',
        [{ state: 'OFF' }, { state: 'ON' }, { state: 'OFF' }, { state: 'ON' }],
        'htpc_przedp_gniazdo: dark mode and restore follow playback, not ownership')
    assertCalls(devices, 'htpc_kuchnia_gniazdo', [], 'htpc_kuchnia_gniazdo: silent throughout')
    assertCalls(devices, 'bedroom_syp_lewe_lewa', [],
        'bedroom_syp_lewe_lewa: never opened (automation never closed it)')
    assertCalls(devices, 'bedroom_sypialnia_gniazdo', [],
        'bedroom_sypialnia_gniazdo: silent (still on -- ON no-op)')
}

console.log('\n── Home theater mode: rollers found closed are never opened on hand-back ──\n')

{
    // The Salon rollers start closed (position 0): the reachable rule's CLOSE
    // is a no-op and writes no snapshot, so the later hand-back OPEN must not
    // fire -- blinds this automation did not close stay as they are.
    const devices = makeDevices()
    devices.get('htpc_salon_lewe').stateLast = { position: 0 }
    devices.get('htpc_salon_prawe').stateLast = { position: 0 }
    const after = await runSequence(devices, [
        { htpc: 'playing', bedroom: null },
        { htpc: null, bedroom: null }
    ])
    assertCalls(after, 'htpc_salon_lewe', [],
        'htpc_salon_lewe: stays closed (CLOSE no-op, OPEN without ownership)')
    assertCalls(after, 'htpc_salon_prawe', [], 'htpc_salon_prawe: stays closed')
    assertCalls(after, 'htpc_przedp_gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'htpc_przedp_gniazdo: lights still cycle normally')
    assertCalls(after, 'htpc_kuchnia_gniazdo', [], 'htpc_kuchnia_gniazdo: silent')
    assertCalls(after, 'bedroom_syp_lewe_lewa', [], 'bedroom_syp_lewe_lewa: never opened')
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
    assertCalls(devices, 'htpc_przedp_gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'htpc_przedp_gniazdo: OFF then restored ON')
    assertCalls(devices, 'htpc_kuchnia_gniazdo', [], 'htpc_kuchnia_gniazdo: silent (was off before)')
    assertCalls(devices, 'htpc_salon_lewe', ['CLOSE', 'OPEN'],
        'htpc_salon_lewe: CLOSE then hand-back OPEN')
    assertCalls(devices, 'htpc_salon_prawe', ['CLOSE', 'OPEN'], 'htpc_salon_prawe: CLOSE then OPEN')
    assertCalls(devices, 'bedroom_sypialnia_gniazdo', [{ state: 'OFF' }, { state: 'ON' }],
        'bedroom_sypialnia_gniazdo: OFF then restored ON')
    assertCalls(devices, 'bedroom_syp_lewe_lewa', ['CLOSE', 'OPEN'],
        'bedroom_syp_lewe_lewa: CLOSE then hand-back OPEN')
}

// ---------------------------------------------------------------------------
// videoPlayer condition unit checks
// ---------------------------------------------------------------------------

console.log('\n── videoPlayer condition (conditionsMatch) ──\n')

{
    const auto = makeHomeTheaterMode(new Map([['stub', makeStubDevice('Stub')]]), CONTEXT)

    // playing matches [playing]
    await setVideoStatus('htpc', 'playing')
    assert(await auto.conditionsMatch({ videoPlayer: { htpc: 'playing' } }, CONTEXT),
        'videoPlayer: htpc=playing matches [playing]')
    assert(!(await auto.conditionsMatch({ videoPlayer: { htpc: ['paused', 'stopped'] } }, CONTEXT)),
        'videoPlayer: htpc=playing rejected by [paused, stopped]')
    // paused matches the not-playing list
    await setVideoStatus('htpc', 'paused')
    assert(await auto.conditionsMatch({ videoPlayer: { htpc: ['paused', 'stopped', 'unreachable'] } }, CONTEXT),
        'videoPlayer: htpc=paused matches not-playing list')
    assert(!(await auto.conditionsMatch({ videoPlayer: { htpc: ['playing'] } }, CONTEXT)),
        'videoPlayer: htpc=paused rejected by [playing]')
    // unreachable matches the not-playing list
    await setVideoStatus('htpc', 'unreachable')
    assert(await auto.conditionsMatch({ videoPlayer: { htpc: ['paused', 'stopped', 'unreachable'] } }, CONTEXT),
        'videoPlayer: htpc=unreachable matches not-playing list')
    assert(!(await auto.conditionsMatch({ videoPlayer: { htpc: ['unknown'] } }, CONTEXT)),
        'videoPlayer: unreachable is a real status, not the unknown token')
    // Unknown (null) status: matches ONLY lists that explicitly opt in via the
    // 'unknown' token (ambient restore, ownership hand-back). Playback
    // requirements and plain not-playing lists stay inert on a guess.
    await setVideoStatus('htpc', null)
    assert(!(await auto.conditionsMatch({ videoPlayer: { htpc: ['playing'] } }, CONTEXT)),
        'videoPlayer: unknown status does not satisfy a "playing" requirement')
    assert(!(await auto.conditionsMatch({ videoPlayer: { htpc: ['paused', 'stopped'] } }, CONTEXT)),
        'videoPlayer: unknown status does not match a list without the unknown token')
    assert(await auto.conditionsMatch({ videoPlayer: { htpc: ['paused', 'stopped', 'unknown'] } }, CONTEXT),
        'videoPlayer: unknown status matches a list that opts in via unknown')
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