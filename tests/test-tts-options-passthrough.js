/**
 * Tests for optional TTS server passthrough parameters (tts_options).
 *
 * Covers both halves of the feature end to end without any external services:
 *   A) Weatherman-side validation -- resolveTtsOptions() against synthetic configs
 *      (valid block, absent section, fully-null dist-template shape, malformed types,
 *      whitespace trimming), plus a smoke run against the real on-disk config.
 *   B) TTS service side -- a local HTTP stand-in captures the actual POST bodies;
 *      events emitted with intro/outro/intro_spacing must carry them verbatim while
 *      plain { text } events keep the clean request shape.
 *
 * No Redis/MQTT/AI needed; the only network traffic is loopback to our own stub server.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import http from 'node:http'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import EventBus from '../src/service/eventBus.js'
import TtsService from '../src/service/ttsService.js'
import TtsWeatherManAutomation from '../etc/automation/ttsWeatherManAutomation.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

// Bootstrap config + logger so logging works in unit-test mode
await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

/** Deep-equality for flat option objects (values are strings/numbers only). */
function sameOptions(actual, expected) {
    const aKeys = Object.keys(actual).sort()
    const eKeys = Object.keys(expected).sort()
    return JSON.stringify(aKeys) === JSON.stringify(eKeys) &&
        aKeys.every(k => actual[k] === expected[k])
}

// ---------------------------------------------------------------------------
// A. Weatherman-side validation (resolveTtsOptions with injected configs)
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 resolveTtsOptions() validation \u2500\u2500\n')

const wm = new TtsWeatherManAutomation()   // constructor loads YAML; no init() -> no timer

assert(
    sameOptions(wm.resolveTtsOptions({
        tts_options: { intro: 'a.wav', outro: 'b.wav', intro_spacing: -2.5 }
    }), { intro: 'a.wav', outro: 'b.wav', intro_spacing: -2.5 }),
    'valid block passes through verbatim (negative spacing included)'
)

assert(sameOptions(wm.resolveTtsOptions({}), {}), 'absent section yields empty object')

assert(
    sameOptions(wm.resolveTtsOptions({
        tts_options: { intro: null, outro: null, intro_spacing: null }
    }), {}),
    'fully-null dist-template shape yields empty object'
)

assert(
    sameOptions(wm.resolveTtsOptions({
        tts_options: { intro: 42, outro: '', intro_spacing: '-2.5' }
    }), {}),
    'malformed entries (number/empty-string/string spacing) all dropped'
)

assert(
    sameOptions(wm.resolveTtsOptions({
        tts_options: { intro: '  x.wav  ', outro: 'y.wav', intro_spacing: 0 }
    }), { intro: 'x.wav', outro: 'y.wav', intro_spacing: 0 }),
    'filenames trimmed; zero spacing accepted'
)

assert(
    wm.resolveTtsOptions() !== null && typeof wm.resolveTtsOptions() === 'object',
    'real on-disk config resolves without throwing (any shape OK per install)'
)

// ---------------------------------------------------------------------------
// B. TTS service end-to-end POST capture against a local stub server
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 TtsService request body passthrough \u2500\u2500\n')

const received = []
const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
        try {
            received.push(JSON.parse(body))
        } catch (_) {
            received.push(null)   // unparseable body -> assertions below fail loudly
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
    })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.env['TTS_API_URL'] = `http://127.0.0.1:${server.address().port}/tts`

try {
    await TtsService.init()
    assert(TtsService.isEnabled(), 'service enabled with loopback API URL + locale template')

    EventBus.emit('tts:speak', { text: 'Jingle utterance', intro: 'a.wav', outro: 'b.wav', intro_spacing: -2.5 })
    EventBus.emit('tts:speak', { text: 'Plain utterance' })

    const t0 = Date.now()
    while (received.length < 2 && Date.now() - t0 < 3000) {
        await new Promise(r => setTimeout(r, 25))
    }
    assert(received.length === 2, 'both requests reached the stub server')

    if (received.length >= 2) {
        const [withOpts, plain] = received

        assert(withOpts !== null, 'jingle request body is valid JSON')
        assert(typeof withOpts?.model === 'string' && withOpts.model.length > 0, 'locale model present in jingle request')
        assert(withOpts?.text === 'Jingle utterance', 'text intact in jingle request')
        assert(withOpts?.intro === 'a.wav', 'intro forwarded verbatim')
        assert(withOpts?.outro === 'b.wav', 'outro forwarded verbatim')
        assert(withOpts?.intro_spacing === -2.5, 'negative intro_spacing forwarded as number')

        assert(plain !== null, 'plain request body is valid JSON')
        assert(plain?.text === 'Plain utterance', 'text intact in plain request')
        assert(plain?.intro === undefined, 'no intro leaked into plain request')
        assert(plain?.outro === undefined, 'no outro leaked into plain request')
        assert(plain?.intro_spacing === undefined, 'no intro_spacing leaked into plain request')
    } else {
        for (const label of ['jingle fields', 'plain shape']) assert(false, `skipped: ${label}`)
    }
} finally {
    TtsService.cleanup()
    await new Promise(resolve => server.close(resolve))
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} FAILED` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)