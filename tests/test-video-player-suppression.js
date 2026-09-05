/**
 * Top-level video_player_suppression stand-down guard tests.
 *
 * Exercises the automation-wide `video_player_suppression` key (inverted
 * stand-down semantics) against a self-contained rule set (no local
 * configuration required):
 *   - Suppressed while a listed host is playing / paused / stopped
 *   - NOT suppressed on unreachable / unknown (unless explicitly listed)
 *   - `unknown`-listed suppression list also stands down on a null status
 *   - Backward compatibility: no key -> no suppression, rules dispatch
 *   - Multi-host OR: any listed host in a listed status suppresses
 *   - Exempt rules (ignore_video_player_suppression) still dispatch while
 *     the guard is active; non-exempt rules are skipped
 *   - Early-return path: no exempt rules -> no dispatch at all
 *   - Coexistence: per-rule video-player condition still applies on top
 *   - Forced runs do NOT bypass the guard
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
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import videoPlayerMonitor from '../src/monitor/videoPlayerMonitor.js'

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
 * Create a stub device that records received commands.
 * @param {string} name - Device name
 * @returns {Object} Stub device
 */
function makeStubDevice(name) {
    return {
        name,
        calls: [],
        getName() { return name },
        receiveCommand(payload, source) {
            this.calls.push({ payload, source })
        },
        getStateLast() { return null },
        // No human-interaction origin -- the cooldown check fails open.
        getStateOrigin() { return 'unknown' },
        getStateLastAt() { return null }
    }
}

// ---------------------------------------------------------------------------
// Test automation
// ---------------------------------------------------------------------------

/**
 * Self-contained roller automation for testing. Uses a fixed rule set (no
 * YAML file) so the test is independent of the live configuration and device
 * container. The suppression map is injected per scenario.
 */
class TestRollers extends RuleBasedAutomationBase {
    /** @type {Map<string, Object>} */ #devices
    /** @type {Object} */ #context

    /**
     * @param {Map<string, Object>} devices - Map of target id -> stub device
     * @param {Object} context - Fabricated sensor context
     */
    constructor(devices, context) {
        super({ name: 'TestRollers', configPath: '/dev/null' })
        this.#devices = devices
        this.#context = context
    }

    loadDevices() { return this.#devices }
    async buildContext() { return this.#context }

    /**
     * Delegate to the shared most-closed-wins resolver, exactly like the
     * production roller automations do.
     */
    resolveCommand(device, targetId, matchingRules) {
        return this.blindsResolveCommand(device, targetId, matchingRules)
    }
}

/**
 * Build a roller automation with a fixed rule set and an optional suppression map.
 * @param {Map<string, Object>} devices - Device map
 * @param {Object|null} [suppression] - video_player_suppression map (host -> statuses)
 * @param {Object} [extraRule] - Optional extra rule appended to the rule set
 * @returns {TestRollers}
 */
function makeRollers(devices, suppression = null, extraRule = null) {
    // illuminance 5 satisfies the rule's `illuminance: { lt: 15 }` condition.
    const auto = new TestRollers(devices, { timeOfDay: 'evening', illuminance: 5 })
    const rules = [
        {
            name: 'Night - close all',
            conditions: { illuminance: { lt: 15 } },
            targets: { Roller_Left: 'CLOSE', Roller_Right: 'CLOSE' }
        }
    ]
    if (extraRule) rules.push(extraRule)
    auto.config = { rules }
    if (suppression) auto.config.video_player_suppression = suppression
    return auto
}

/**
 * Fresh device map for a scenario.
 * @returns {Map<string, Object>}
 */
function makeDevices() {
    return new Map([
        ['Roller_Left', makeStubDevice('Roller Left')],
        ['Roller_Right', makeStubDevice('Roller Right')]
    ])
}

/**
 * Assert a device received exactly the expected payload sequence.
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
}


// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

console.log('\n── Suppression active on listed statuses ──\n')

{
    // playing / paused / stopped each stand the automation down
    for (const status of ['playing', 'paused', 'stopped']) {
        const devices = makeDevices()
        const auto = makeRollers(devices, { htpc: ['playing', 'paused', 'stopped'] })
        await setVideoStatus('htpc', status)
        await auto.execute({ trigger: 'test' })
        assertCalls(devices, 'Roller_Left', [], `suppression: ${status} -> no dispatch`)
    }
}

console.log('\n── Suppression inactive on unlisted statuses ──\n')

{
    // unreachable / unknown are not in the suppression list -> rules dispatch
    for (const status of ['unreachable', null]) {
        const devices = makeDevices()
        const auto = makeRollers(devices, { htpc: ['playing', 'paused', 'stopped'] })
        await setVideoStatus('htpc', status)
        await auto.execute({ trigger: 'test' })
        assertCalls(devices, 'Roller_Left', ['CLOSE'], `no suppression: ${status ?? 'null'} -> CLOSE dispatched`)
    }
}

console.log('\n── unknown token listed in suppression ──\n')

{
    // A suppression list that includes 'unknown' also stands down on null.
    const devices = makeDevices()
    const auto = makeRollers(devices, { htpc: ['playing', 'unknown'] })
    await setVideoStatus('htpc', null)
    await auto.execute({ trigger: 'test' })
    assertCalls(devices, 'Roller_Left', [], 'suppression: unknown listed -> null status stands down')

    // ... but a real unreachable status is not in the list -> dispatch
    const devices2 = makeDevices()
    const auto2 = makeRollers(devices2, { htpc: ['playing', 'unknown'] })
    await setVideoStatus('htpc', 'unreachable')
    await auto2.execute({ trigger: 'test' })
    assertCalls(devices2, 'Roller_Left', ['CLOSE'], 'suppression: unreachable not listed -> CLOSE dispatched')
}

console.log('\n── Backward compatibility: no suppression key ──\n')

{
    // Without the key, playing status does not suppress anything.
    const devices = makeDevices()
    const auto = makeRollers(devices)
    await setVideoStatus('htpc', 'playing')
    await auto.execute({ trigger: 'test' })
    assertCalls(devices, 'Roller_Left', ['CLOSE'], 'no suppression key: playing -> CLOSE dispatched (legacy behavior)')
}

console.log('\n── Multi-host OR ──\n')

{
    // Any listed host in a listed status suppresses (OR across hosts).
    const devices = makeDevices()
    const auto = makeRollers(devices, { htpc: ['playing'], bedroom: ['playing'] })
    await setVideoStatus('htpc', 'stopped')
    await setVideoStatus('bedroom', 'playing')
    await auto.execute({ trigger: 'test' })
    assertCalls(devices, 'Roller_Left', [], 'multi-host OR: bedroom playing -> no dispatch')

    // Neither host in a listed status -> dispatch
    const devices2 = makeDevices()
    const auto2 = makeRollers(devices2, { htpc: ['playing'], bedroom: ['playing'] })
    await setVideoStatus('htpc', 'stopped')
    await setVideoStatus('bedroom', 'unreachable')
    await auto2.execute({ trigger: 'test' })
    assertCalls(devices2, 'Roller_Left', ['CLOSE'], 'multi-host OR: none listed -> CLOSE dispatched')
}


console.log('\n── Exempt rules dispatch while suppression is active ──\n')

{
    // A rule with ignore_video_player_suppression still runs while suppressed.
    const devices = makeDevices()
    const exemptRule = {
        name: 'Exempt: always open at night',
        ignore_video_player_suppression: true,
        conditions: {},
        targets: { Roller_Left: 'OPEN', Roller_Right: 'OPEN' }
    }
    const auto = makeRollers(devices, { htpc: ['playing'] }, exemptRule)
    await setVideoStatus('htpc', 'playing')
    await auto.execute({ trigger: 'test' })
    assertCalls(devices, 'Roller_Left', ['OPEN'], 'exempt rule: dispatches while suppressed')
    assertCalls(devices, 'Roller_Right', ['OPEN'], 'exempt rule: dispatches to every target while suppressed')

    // The non-exempt CLOSE rule is skipped: most-closed-wins would otherwise
    // resolve CLOSE over OPEN, so OPEN proves the non-exempt rule was excluded.
    const devices2 = makeDevices()
    const exemptRule2 = {
        name: 'Exempt: open',
        ignore_video_player_suppression: true,
        conditions: {},
        targets: { Roller_Left: 'OPEN' }
    }
    const auto2 = makeRollers(devices2, { htpc: ['playing'] }, exemptRule2)
    await setVideoStatus('htpc', 'playing')
    await auto2.execute({ trigger: 'test' })
    assertCalls(devices2, 'Roller_Left', ['OPEN'], 'exempt rule: non-exempt CLOSE rule skipped (OPEN wins)')
}

console.log('\n── Early return: no exempt rules ──\n')

{
    // No rule opts out -> execute() returns before dispatching anything.
    const devices = makeDevices()
    const auto = makeRollers(devices, { htpc: ['playing'] })
    await setVideoStatus('htpc', 'playing')
    await auto.execute({ trigger: 'test' })
    assertCalls(devices, 'Roller_Left', [], 'early return: no exempt rules -> no dispatch')
    assertCalls(devices, 'Roller_Right', [], 'early return: no exempt rules -> no dispatch (Roller_Right)')
}

console.log('\n── Coexistence with per-rule video-player condition ──\n')

{
    // The per-rule condition still applies on top of the suppression guard:
    // here the guard is inactive (htpc stopped is not listed) but the rule's
    // own video-player allow-list rejects 'stopped'.
    const devices = makeDevices()
    const auto = makeRollers(devices, { bedroom: ['playing'] })
    auto.config.rules[0].conditions['video-player'] = { htpc: ['unknown', 'unreachable'] }
    await setVideoStatus('htpc', 'stopped')
    await setVideoStatus('bedroom', 'unreachable')
    await auto.execute({ trigger: 'test' })
    assertCalls(devices, 'Roller_Left', [], 'coexistence: per-rule condition rejects stopped even without suppression')

    // Same setup but the per-rule allow-list accepts the status -> dispatch.
    const devices2 = makeDevices()
    const auto2 = makeRollers(devices2, { bedroom: ['playing'] })
    auto2.config.rules[0].conditions['video-player'] = { htpc: ['unknown', 'unreachable'] }
    await setVideoStatus('htpc', 'unreachable')
    await setVideoStatus('bedroom', 'unreachable')
    await auto2.execute({ trigger: 'test' })
    assertCalls(devices2, 'Roller_Left', ['CLOSE'], 'coexistence: per-rule condition accepts unreachable -> dispatch')
}

console.log('\n── Forced run does not bypass the guard ──\n')

{
    // /automation force must not create device fights: the guard holds.
    const devices = makeDevices()
    const auto = makeRollers(devices, { htpc: ['playing'] })
    await setVideoStatus('htpc', 'playing')
    await auto.execute({ trigger: 'test', force: true })
    assertCalls(devices, 'Roller_Left', [], 'force: suppression NOT bypassed by forced run')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)
