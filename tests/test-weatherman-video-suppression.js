/**
 * TtsWeatherMan video_player_suppression stand-down guard tests.
 *
 * WeatherMan overrides execute(), so -- unlike the other rule-based automations -- it must apply
 * the top-level video_player_suppression gate itself rather than inherit it from the shared flow.
 * These tests pin that integration at its exact seam using the REAL shipped configuration
 * (etc/automation/tts-weatherman.yaml) and the real player hosts defined in this deployment
 * (htpc / bedroom):
 *   - the prod YAML ships a video_player_suppression block covering both players on "playing" only
 *   - htpc playing -> stands down; bedroom playing -> stands down (multi-host OR)
 *   - paused / unreachable are NOT listed -> still announces (guard stays inert while browsing)
 *   - backward compatibility: with no video_player_suppression key the guard never suppresses
 *
 * Player status is injected via VideoPlayerMonitor.setTestStatus() into the in-memory cache, so
 * the test needs no live broker or running player.
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
import TtsWeatherManAutomation from '../etc/automation/ttsWeatherManAutomation.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
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

/** Seed a player's effective status in the monitor cache without a live player/broker. */
async function setVideoStatus(host, status) {
    await videoPlayerMonitor.setTestStatus(host, status)
}

const wm = new TtsWeatherManAutomation()
try {
    // init() loads tts-weatherman.yaml (now carrying the guard) and starts a harmless timer.
    await wm.init()

    console.log('\n── config wiring ──')
    const sup = wm.config?.video_player_suppression ?? {}
    assert(Array.isArray(sup.htpc), 'guard lists the htpc host')
    assert(JSON.stringify(sup.htpc) === JSON.stringify(['playing']), `htpc suppresses only on "playing" (${JSON.stringify(sup.htpc)})`)
    assert(Array.isArray(sup.bedroom), 'guard lists the bedroom host')
    assert(JSON.stringify(sup.bedroom) === JSON.stringify(['playing']), `bedroom suppresses only on "playing" (${JSON.stringify(sup.bedroom)})`)
    assert(Object.keys(sup).length === 2, `no unexpected extra hosts in the guard (${Object.keys(sup).join(', ')})`)

    console.log('\n── stand-down truth table (via isVideoPlayerSuppressionActive) ──')
    await setVideoStatus('htpc', 'playing'); await setVideoStatus('bedroom', 'stopped')
    assert((await wm.isVideoPlayerSuppressionActive()) === true, 'htpc playing -> stands down')

    await setVideoStatus('htpc', 'stopped'); await setVideoStatus('bedroom', 'playing')
    assert((await wm.isVideoPlayerSuppressionActive()) === true, 'bedroom playing -> stands down (multi-host OR)')

    await setVideoStatus('htpc', 'paused'); await setVideoStatus('bedroom', 'paused')
    assert((await wm.isVideoPlayerSuppressionActive()) === false, 'paused (not listed) -> still announces while browsing')

    await setVideoStatus('htpc', 'unreachable'); await setVideoStatus('bedroom', 'unreachable')
    assert((await wm.isVideoPlayerSuppressionActive()) === false, 'unreachable (not listed) -> still announces')

    // Backward compatibility: with the block removed entirely the guard is inert even while playing.
    const saved = wm.config.video_player_suppression
    delete wm.config.video_player_suppression
    await setVideoStatus('htpc', 'playing'); await setVideoStatus('bedroom', 'playing')
    assert((await wm.isVideoPlayerSuppressionActive()) === false, 'no video_player_suppression key -> never suppresses')
    wm.config.video_player_suppression = saved
} finally {
    await wm.cleanup()   // stop the timer started by init() so the process can exit
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : '') + `\n${'═'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)