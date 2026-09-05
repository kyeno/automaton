/**
 * VideoPlayerMonitor endpoint-IP resolution tests.
 *
 * Verifies that each `videoPlayers` entry resolves its endpoint IP from the
 * same-named `computers` entry, that an explicit `host` key overrides that
 * lookup, and that players with neither are skipped:
 *   - No `host` key -> IP resolved from the same-named `computers` entry
 *   - Explicit `host` key -> wins over the `computers` lookup (failsafe)
 *   - Explicit `host` key with no `computers` section -> works standalone
 *   - Neither `host` nor a matching `computers` entry -> player skipped
 *   - Blank / non-string `host` values -> player skipped (validation)
 *   - Blank `computers` IP -> player skipped (unresolvable)
 *   - Mixed configs keep only the resolvable players, other keys intact
 *
 * Uses init(configOverride) so no live configuration is required; the sweep
 * timer is stopped after each case. The fire-and-forget first sweep is
 * harmless: fetches target RFC 5737 TEST-NET addresses and simply time out
 * into the strike counter without touching any status assertion.
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
import videoPlayerMonitor from '../src/monitor/videoPlayerMonitor.js'

await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0

/**
 * Assert a condition, recording pass/fail and printing failures.
 * @param {boolean} condition - Expected-to-be-true condition
 * @param {string} description - Human-readable assertion label
 * @returns {void}
 */
function assert(condition, description) {
    if (condition) {
        passed++
    } else {
        failed++
        console.error(`  ✗ ${description}`)
    }
}

/** Minimal valid player entry; the endpoint IP is deliberately omitted. */
const baseEntry = { port: 8080, path: '/requests/status.json', parser: 'vlc' }

console.log('\n-- Video Player Host Resolution --\n')

// -- No host key: IP resolved from the same-named computers entry -----------
await videoPlayerMonitor.init({
    computers: { 'my-pc': '192.0.2.5' },
    videoPlayers: { 'my-pc': { ...baseEntry } },
})
videoPlayerMonitor.stop()
assert(videoPlayerMonitor.getVideoPlayers()['my-pc']?.host === '192.0.2.5',
    'no host key: IP resolved from same-named computers entry')
assert(videoPlayerMonitor.getHostNames().includes('my-pc'),
    'resolved player is listed in getHostNames()')

// -- Explicit host key overrides the computers lookup ------------------------
await videoPlayerMonitor.init({
    computers: { 'my-pc': '192.0.2.5' },
    videoPlayers: { 'my-pc': { ...baseEntry, host: '192.0.2.9' } },
})
videoPlayerMonitor.stop()
assert(videoPlayerMonitor.getVideoPlayers()['my-pc']?.host === '192.0.2.9',
    'explicit host key wins over the computers lookup')

// -- Explicit host key works with no computers section at all ----------------
await videoPlayerMonitor.init({
    videoPlayers: { standalone: { ...baseEntry, host: '192.0.2.7' } },
})
videoPlayerMonitor.stop()
assert(videoPlayerMonitor.getVideoPlayers().standalone?.host === '192.0.2.7',
    'explicit host key works without a computers section')

// -- Neither host nor a matching computers entry: player skipped -------------
await videoPlayerMonitor.init({
    computers: { other: '192.0.2.5' },
    videoPlayers: { ghost: { ...baseEntry } },
})
videoPlayerMonitor.stop()
assert(!videoPlayerMonitor.getHostNames().includes('ghost'),
    'no host key and no matching computers entry: player skipped')
assert(Object.keys(videoPlayerMonitor.getVideoPlayers()).length === 0,
    'unresolvable player leaves the monitor map empty')

// -- Blank host string: skipped by validation --------------------------------
await videoPlayerMonitor.init({
    videoPlayers: { blank: { ...baseEntry, host: '   ' } },
})
videoPlayerMonitor.stop()
assert(!videoPlayerMonitor.getHostNames().includes('blank'),
    'blank host string: player skipped')

// -- Non-string host: skipped by validation ----------------------------------
await videoPlayerMonitor.init({
    videoPlayers: { numeric: { ...baseEntry, host: 123 } },
})
videoPlayerMonitor.stop()
assert(!videoPlayerMonitor.getHostNames().includes('numeric'),
    'non-string host: player skipped')

// -- Blank computers IP: unresolvable, player skipped ------------------------
await videoPlayerMonitor.init({
    computers: { 'my-pc': '' },
    videoPlayers: { 'my-pc': { ...baseEntry } },
})
videoPlayerMonitor.stop()
assert(!videoPlayerMonitor.getHostNames().includes('my-pc'),
    'blank computers IP: player skipped as unresolvable')

// -- Mixed config: only resolvable players survive, keys intact -------------
await videoPlayerMonitor.init({
    computers: { good: '192.0.2.5' },
    videoPlayers: {
        good: { ...baseEntry },
        bad: { ...baseEntry },
    },
})
videoPlayerMonitor.stop()
{
    const hosts = videoPlayerMonitor.getHostNames()
    const good = videoPlayerMonitor.getVideoPlayers().good
    assert(hosts.length === 1 && hosts[0] === 'good',
        'mixed config: only the resolvable player is kept')
    assert(good?.host === '192.0.2.5' && good?.port === 8080 &&
        good?.path === '/requests/status.json' && good?.parser === 'vlc',
        'resolved player keeps its other keys intact')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)