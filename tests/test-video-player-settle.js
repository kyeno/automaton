/**
 * Video-player playback-settle behaviour tests.
 *
 * Verifies the "settling" delay added to video-player-driven automations so lights /
 * suppression do not fire immediately on `playing`, but only once the SAME title has played
 * continuously for the dwell window (using a ~60 s dwell window). Covers:
 *   - MPC / VLC extractTitle() identity extraction
 *   - StateService.delete() semantics (used to reset watch sessions)
 *   - Dwell NOT yet reached reports `stopped`; dwell reached reports `playing`
 *   - Pause BEFORE settle resets the session; pause AFTER settle preserves it
 *   - Stop clears the session; changing movie restarts the dwell clock
 *   - End-to-end: dark-mode rule + suppression are inactive before settle, active after
 *
 * The state machine is driven through recordObservation() together with a controllable fake
 * clock (_setClock), so timing is fully deterministic without sleeping across the real window.
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
import StateService from '../src/service/stateService.js'
import EventBus from '../src/service/eventBus.js'
import videoPlayerMonitor from '../src/monitor/videoPlayerMonitor.js'
import MpcProvider from '../src/monitor/providers/mpc.js'
import VlcProvider from '../src/monitor/providers/vlc.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'

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
// Deterministic clock + settle window
// ---------------------------------------------------------------------------

const SETTLE_MS = 60_000          // deterministic dwell window for fast tests
const T0 = 1_700_000_000_000      // arbitrary epoch-ms baseline
let fakeNow = T0

videoPlayerMonitor._setPlaybackSettleMs(SETTLE_MS)
videoPlayerMonitor._setClock(() => fakeNow)

/**
 * Apply one observation at a specific simulated time.
 * @param {string} host - Host name
 * @param {string|null} status - Normalized status ('playing'|'paused'|'stopped'|'unreachable') or null
 * @param {string|null} [title] - Media title to associate with the observation
 * @param {number} atMs - Simulated current time (epoch ms)
 */
async function obs(host, status, title, atMs) {
    fakeNow = atMs
    await videoPlayerMonitor.recordObservation(host, status, typeof title === 'string' ? title : null)
}

function kTitle(h) { return `videoPlayer.${h}.title` }
function kSince(h) { return `videoPlayer.${h}.sinceMs` }
function kSettled(h) { return `videoPlayer.${h}.settled` }

console.log('\n── MPC extractTitle ──\n')
{
    const mpc = new MpcProvider()
    const pageFile = [
        '<html><body>',
        '<p id="version">2.4</p>',
        '<p id="statestring">Playing</p>',
        '<p id="file">D:\\Movies\\Inception.mkv</p>',
        '<p id="title">Inception (2010)</p>',
        '</body></html>'
    ].join('')
    assert(mpc.parse(pageFile) === 'playing', 'mpc parse -> playing')
    assert(mpc.extractTitle(pageFile) === 'D:\\Movies\\Inception.mkv', 'mpc prefers <p id="file"> over title')

    const pageTitleOnly = [
        '<html><body>',
        '<p id="statestring">Paused</p>',
        '<p id="file"></p>',
        '<p id="title">Interstellar</p>',
        '</body></html>'
    ].join('')
    assert(mpc.extractTitle(pageTitleOnly) === 'Interstellar', 'mpc falls back to <p id="title"> when file empty')

    const pageNone = '<html><body><p id="statestring">Stopped</p></body></html>'
    assert(mpc.extractTitle(pageNone) === null, 'mpc returns null when neither file nor title present')
}

console.log('\n── VLC extractTitle ──\n')
{
    const vlc = new VlcProvider()
    assert(vlc.extractTitle(JSON.stringify({ state: 'playing', input_name: '/media/Big_Buck_Bunny.mp4' })) === '/media/Big_Buck_Bunny.mp4', 'vlc uses input_name')
    assert(vlc.extractTitle(JSON.stringify({ state: 'paused', name: 'Nightcrawler' })) === 'Nightcrawler', 'vlc uses name fallback')
    assert(vlc.extractTitle(JSON.stringify({ state: 'stopped', meta: { artist: 'Artist X', title: 'Track Y' } })) === 'Track Y', 'vlc reads nested meta.title')
    assert(vlc.extractTitle(JSON.stringify({ state: 'playing' })) === null, 'vlc returns null with no candidate fields')
    assert(vlc.extractTitle('not json at all') === null, 'vlc tolerates non-JSON body (returns null)')
}

console.log('\n── StateService.delete ──\n')
{
    const key = '__settle_test_key__'
    let notified = 0
    const off = StateService.on(key, () => { notified++ })
    assert(StateService.get(key) === undefined, 'delete test: key absent initially')
    StateService.set(key, 'value-1')
    assert(StateService.get(key) === 'value-1', 'delete test: value set')
    StateService.delete(key)
    assert(StateService.get(key) === undefined, 'delete test: removed -> get() is undefined')
    assert(notified >= 2, `delete test: listeners notified on set + delete (got ${notified})`)
    const before = notified
    StateService.delete(key)   // deleting an already-absent key must be a safe no-op
    assert(notified === before, 'delete test: deleting missing key does not notify again')
    assert(!Object.keys(StateService.dump()).includes('__settle_test_key__'), 'delete test: dump omits deleted key')
    off()
}

console.log('\n── Settle: dwell not reached -> stopped, then playing ──\n')
{
    const host = 'htpc'
    let events = 0
    const off = EventBus.subscribe(`videoPlayer:${host}`, () => { events++ })

    await obs(host, 'playing', 'Inception.mkv', T0)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'unsettled play reports stopped')
    assert(StateService.get(kTitle(host)) === 'Inception.mkv', 'session title captured')
    assert(StateService.get(kSince(host)) === T0, 'dwell clock started at first observation')
    assert(StateService.get(kSettled(host)) === false, 'not settled yet')

    await obs(host, 'playing', 'Inception.mkv', T0 + 30_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'still within window -> stopped')
    assert(StateService.get(kSince(host)) === T0, 'same-title play does NOT restart the clock')

    await obs(host, 'playing', 'Inception.mkv', T0 + SETTLE_MS)
    assert(await videoPlayerMonitor.getStatus(host) === 'playing', 'crossing the window -> playing')
    assert(StateService.get(kSettled(host)) === true, 'settled flag set on crossing')
    assert(events >= 2, `EventBus published on real transitions (got ${events})`)
    off()
}

console.log('\n── Settle: pause before settle resets the session ──\n')
{
    const host = 'bedroom'
    await obs(host, 'playing', 'MovieA.mkv', T0)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'pre-settle play reports stopped')

    await obs(host, 'paused', null, T0 + 30_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'paused', 'pause passes through as paused')
    assert(StateService.get(kSince(host)) == null, 'session cleared after pre-settle pause')
    assert(StateService.get(kTitle(host)) == null, 'title cleared after pre-settle pause')

    // Resume: clock must restart from scratch.
    await obs(host, 'playing', 'MovieA.mkv', T0 + 45_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'resume starts a fresh dwell window')
    assert(StateService.get(kSince(host)) === T0 + 45_000, 'fresh clock anchored at resume time')

    // Only 30s of continuous play since resume -> still not settled (would be if unreset).
    await obs(host, 'playing', 'MovieA.mkv', T0 + 75_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'must re-accumulate full window after reset')
}

console.log('\n── Settle: changing movie restarts the dwell clock ──\n')
{
    const host = 'office'
    await obs(host, 'playing', 'Alpha.mkv', T0)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'first title settling')

    await obs(host, 'playing', 'Beta.mkv', T0 + 50_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'new title reports stopped again')
    assert(StateService.get(kTitle(host)) === 'Beta.mkv', 'session now tracks new title')
    assert(StateService.get(kSince(host)) === T0 + 50_000, 'clock restarted for new title')

    // 50s into Beta (< window) even though ~100s total elapsed across both titles.
    await obs(host, 'playing', 'Beta.mkv', T0 + 100_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'dwell measured per-title, not cumulatively')
}

console.log('\n── Settle: stop clears the session, then must re-settle ──\n')
{
    const host = 'lounge'
    await obs(host, 'playing', 'Film.mkv', T0)
    await obs(host, 'playing', 'Film.mkv', T0 + SETTLE_MS)
    assert(await videoPlayerMonitor.getStatus(host) === 'playing', 'settled -> playing before stop')
    assert(StateService.get(kSettled(host)) === true, 'settled flag set before stop')

    await obs(host, 'stopped', null, T0 + 70_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'stop passes through as stopped')
    assert(StateService.get(kSince(host)) == null, 'session cleared on stop')
    assert(StateService.get(kSettled(host)) !== true, 'settled flag reset on stop')

    // Re-starting the same title after a stop begins a brand-new dwell window.
    await obs(host, 'playing', 'Film.mkv', T0 + 80_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'replay after stop starts fresh clock')
    assert(StateService.get(kSince(host)) === T0 + 80_000, 'fresh clock anchored at restart time')

    await obs(host, 'playing', 'Film.mkv', T0 + 140_000)   // exactly one full window later
    assert(await videoPlayerMonitor.getStatus(host) === 'playing', 'must re-settle for another full window')
}

console.log('\n── Settle: pause AFTER settle preserves state; resume stays playing ──\n')
{
    const host = 'theater'
    await obs(host, 'playing', 'Epic.mkv', T0)
    await obs(host, 'playing', 'Epic.mkv', T0 + SETTLE_MS)
    assert(await videoPlayerMonitor.getStatus(host) === 'playing', 'settled -> playing')

    await obs(host, 'paused', null, T0 + 90_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'paused', 'post-settle pause reports paused')
    assert(StateService.get(kSettled(host)) === true, 'pause does NOT clear an already-settled session')
    assert(StateService.get(kSince(host)) === T0, 'original start time preserved across a post-settle pause')
    assert(StateService.get(kTitle(host)) === 'Epic.mkv', 'title retained across a post-settle pause')

    // Resuming the same title must be immediately active -- no second dwell required.
    await obs(host, 'playing', 'Epic.mkv', T0 + 120_000)
    assert(await videoPlayerMonitor.getStatus(host) === 'playing', 'resume of settled title is instantly playing (no re-dwell)')
}

// ---------------------------------------------------------------------------
// End-to-end: dark-mode rule + suppression gate on the settle-aware status
// ---------------------------------------------------------------------------

/** Minimal light automation over RuleBasedAutomationBase (no YAML / container). */
class TestLights extends RuleBasedAutomationBase {
    /** @type {Map<string, Object>} */ #devices
    /** @type {Object} */ #context
    /**
     * @param {Map<string, Object>} devices - Target id -> stub device
     * @param {Object} context - Fabricated sensor context
     */
    constructor(devices, context) {
        super({ name: 'TestLights', configPath: '/dev/null' })
        this.#devices = devices
        this.#context = context
    }
    loadDevices() { return this.#devices }
    async buildContext() { return this.#context }
    resolveCommand(_device, targetId, matchingRules) {
        for (const rule of matchingRules) if (rule.targets?.[targetId] != null) return { payload: rule.targets[targetId] }
        return null
    }
}

function makeStub(name) {
    return {
        name, calls: [], getName() { return name },
        receiveCommand(payload, source) { this.calls.push({ payload, source }) },
        getStateLast() { return null }, getStateOrigin() { return 'unknown' }, getStateLastAt() { return null }
    }
}
function devMap() { return new Map([['Light_Dim', makeStub('Dimmer')]]) }
function expectCalls(map, id, expectedPayloads, label) {
    const actual = map.get(id).calls.map((c) => JSON.stringify(c.payload))
    const exp = expectedPayloads.map((p) => JSON.stringify(p))
    assert(actual.length === exp.length && actual.every((v, i) => v === exp[i]), `${label} (got [${actual.join(', ') || 'none'}])`)
}

console.log('\n── End-to-end: dark-mode + suppression gate on settle ──\n')
{
    const host = 'cinema'
    // Phase 1 -- unsettled play reads as `stopped`.
    await obs(host, 'playing', 'Dune.mkv', T0)
    assert(await videoPlayerMonitor.getStatus(host) === 'stopped', 'e2e pre-settle: effective status is stopped')

    {   // Dark-mode rule requires playing -> INACTIVE before settle.
        const d = devMap()
        const auto = new TestLights(d, { timeOfDay: 'night' })
        auto.config = { rules: [{ name: 'Dark mode', conditions: { 'video-player': { [host]: ['playing'] } }, targets: { Light_Dim: 'ON' } }] }
        await auto.execute({ trigger: 'test' })
        expectCalls(d, 'Light_Dim', [], 'dark-mode INACTIVE before settle')
    }
    {   // Suppression list has playing/paused; effective `stopped` not listed -> guard INACTIVE -> dispatches.
        const d = devMap()
        const auto = new TestLights(d, { timeOfDay: 'evening', illuminance: 5 })
        auto.config = { rules: [{ name: 'Close', conditions: {}, targets: { Light_Dim: 'OFF' } }], video_player_suppression: { [host]: ['playing', 'paused'] } }
        await auto.execute({ trigger: 'test' })
        expectCalls(d, 'Light_Dim', ['OFF'], 'suppression INACTIVE before settle -> dispatches')
    }

    // Phase 2 -- cross the dwell window -> effectively `playing`.
    await obs(host, 'playing', 'Dune.mkv', T0 + SETTLE_MS)
    assert(await videoPlayerMonitor.getStatus(host) === 'playing', 'e2e post-settle: effective status is playing')

    {   // Dark-mode rule now matches -> ACTIVE after settle.
        const d = devMap()
        const auto = new TestLights(d, { timeOfDay: 'night' })
        auto.config = { rules: [{ name: 'Dark mode', conditions: { 'video-player': { [host]: ['playing'] } }, targets: { Light_Dim: 'ON' } }] }
        await auto.execute({ trigger: 'test' })
        expectCalls(d, 'Light_Dim', ['ON'], 'dark-mode ACTIVE after settle')
    }
    {   // Effective `playing` is in the suppression list -> guard ACTIVE -> stands down.
        const d = devMap()
        const auto = new TestLights(d, { timeOfDay: 'evening', illuminance: 5 })
        auto.config = { rules: [{ name: 'Close', conditions: {}, targets: { Light_Dim: 'OFF' } }], video_player_suppression: { [host]: ['playing', 'paused'] } }
        await auto.execute({ trigger: 'test' })
        expectCalls(d, 'Light_Dim', [], 'suppression ACTIVE after settle -> no dispatch')
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)