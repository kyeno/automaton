import { config } from 'dotenv'
config()

'use strict'

/**
 * Tests for the shared TTS framing-profile resolver (src/lib/ttsProfiles.js).
 *
 * The resolver is the single owner of how intro/outro wave filenames and intro spacing
 * reach a 'tts:speak' payload for every speaker. Covered here:
 *   A) validate() -- well-formed blocks, trimming, malformed entries dropped with a
 *      warning naming the config path, non-objects yielding {}
 *   B) resolve() -- profile as base, explicit tts_options winning key by key, unknown
 *      profile contributing nothing and warned once per name
 *   C) speak() -- plain { text } payload when empty, framing spread when set
 *   D) Weatherman delegation -- tts_profile support through resolveTtsOptions()
 *
 * No Redis/MQTT/TTS server needed; TtsService.getProfile() is stubbed because wave
 * files are not part of the repository (locale profiles: ship commented out).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import EventBus from '../src/service/eventBus.js'
import TtsService from '../src/service/ttsService.js'
import TtsProfiles from '../src/lib/ttsProfiles.js'
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
        passed++
        console.log(`  \u2713 ${label}`)
    } else {
        failed++
        console.error(`  \u2717 ${label}`)
    }
}

/** Deep-equality for flat option objects (values are strings/numbers only). */
function sameOptions(actual, expected) {
    const aKeys = Object.keys(actual).sort()
    const eKeys = Object.keys(expected).sort()
    return JSON.stringify(aKeys) === JSON.stringify(eKeys) &&
        aKeys.every((k) => actual[k] === expected[k])
}

// Stubbed locale profile registry (see the profiles: block of etc/i18n/<locale>/tts.yaml).
const ttsProto = Object.getPrototypeOf(TtsService)
const originalGetProfile = ttsProto.getProfile
const registry = {
    news: { intro: 'news-intro.wav', outro: 'news-outro.wav', intro_spacing: -2.5 },
    broken: { intro: 42, outro: '', intro_spacing: 'soon' },
    partial: { outro: 'only-outro.wav' }
}
ttsProto.getProfile = function (name) {
    return registry[String(name ?? '').trim().toLowerCase()] ?? null
}

const consoleWarnings = []
const loggerProto = Object.getPrototypeOf(LoggerService)
const originalWarn = loggerProto.warn
loggerProto.warn = function (message, tag) {
    consoleWarnings.push(message)
    return originalWarn.call(this, message, tag)
}

console.log('=== TTS Profiles Tests ===\n')

// -- A) validate() ------------------------------------------------------------
console.log('-- A) validate() --')

assert(sameOptions(TtsProfiles.validate(
    { intro: 'a.wav', outro: 'b.wav', intro_spacing: -2.5 }
), { intro: 'a.wav', outro: 'b.wav', intro_spacing: -2.5 }), 'well-formed block passes through verbatim')

assert(sameOptions(TtsProfiles.validate(
    { intro: '  a.wav  ', outro: 'b.wav' }
), { intro: 'a.wav', outro: 'b.wav' }), 'wave filenames are trimmed')

const dropWarnings = []
assert(sameOptions(TtsProfiles.validate(
    { intro: 42, outro: '', intro_spacing: '-2.5' }, 'alerts.x_tts_options', (m) => dropWarnings.push(m)
), {}), 'malformed entries are dropped, never failing the utterance')
assert(dropWarnings.length === 3, `every dropped entry warns (got ${dropWarnings.length})`)
assert(dropWarnings.every((m) => m.startsWith('alerts.x_tts_options.')),
    `warnings name the config path (${dropWarnings[0]})`)
assert(dropWarnings.some((m) => m.includes('intro_spacing')), 'spacing warning distinguishes from wave warnings')

assert(sameOptions(TtsProfiles.validate(null), {}), 'missing block yields empty options')
assert(sameOptions(TtsProfiles.validate('intro.wav'), {}), 'non-objects yield empty options')
assert(sameOptions(TtsProfiles.validate(['a.wav']), {}), 'arrays yield empty options')
assert(sameOptions(TtsProfiles.validate({}), {}), 'empty block yields empty options')
assert(sameOptions(TtsProfiles.validate({ intro: 'a.wav', outro: null, intro_spacing: 0 }), { intro: 'a.wav', intro_spacing: 0 }),
    'null entries are skipped; zero spacing is a real value')

// -- B) resolve() -------------------------------------------------------------
console.log('\n-- B) resolve() --')

assert(sameOptions(TtsProfiles.resolve({ tts_profile: 'news' }),
    { intro: 'news-intro.wav', outro: 'news-outro.wav', intro_spacing: -2.5 }),
    'profile supplies the whole framing set')

assert(sameOptions(TtsProfiles.resolve({ tts_profile: ' NEWS ' }),
    { intro: 'news-intro.wav', outro: 'news-outro.wav', intro_spacing: -2.5 }),
    'profile names are trimmed and case-insensitive')

assert(sameOptions(TtsProfiles.resolve({ tts_profile: 'partial' }), { outro: 'only-outro.wav' }),
    'partial profile contributes only the fields it declares')

assert(sameOptions(TtsProfiles.resolve({
    tts_profile: 'news',
    tts_options: { intro: 'own-intro.wav' }
}), { intro: 'own-intro.wav', outro: 'news-outro.wav', intro_spacing: -2.5 }),
    'explicit tts_options wins key by key, profile fills the rest')

assert(sameOptions(TtsProfiles.resolve({
    tts_profile: 'news',
    tts_options: { intro: 'a.wav', outro: 'b.wav', intro_spacing: 0 }
}), { intro: 'a.wav', outro: 'b.wav', intro_spacing: 0 }),
    'a full explicit block replaces the profile entirely')

const brokenWarnings = []
assert(sameOptions(TtsProfiles.resolve({ tts_profile: 'broken' }, (m) => brokenWarnings.push(m)), {}),
    'malformed profile entries are dropped, speech stays plain')
assert(brokenWarnings.length === 3, `malformed profile entries warn (got ${brokenWarnings.length})`)
assert(brokenWarnings.every((m) => m.startsWith('profiles.broken.')),
    `profile warnings name the registry path (${brokenWarnings[0]})`)

const ghostWarnings = []
assert(sameOptions(TtsProfiles.resolve({ tts_profile: 'ghost' }, (m) => ghostWarnings.push(m)), {}),
    'unknown profile contributes nothing')
assert(sameOptions(TtsProfiles.resolve({ tts_profile: 'GHOST ' }, (m) => ghostWarnings.push(m)), {}),
    'unknown profile resolved again (dedupe check)')
assert(ghostWarnings.length === 1, `unknown profile warns once per name, not per utterance (got ${ghostWarnings.length})`)
assert(ghostWarnings[0].includes('ghost') && ghostWarnings[0].includes('profiles'),
    `warning names the profile and where to define it (${ghostWarnings[0]})`)

assert(sameOptions(TtsProfiles.resolve({}), {}), 'no profile and no options yield {}')
assert(sameOptions(TtsProfiles.resolve(null), {}), 'null source yields {}')
assert(sameOptions(TtsProfiles.resolve({ tts_profile: '' }), {}), 'empty profile name is treated as unset')
assert(sameOptions(TtsProfiles.resolve({ tts_profile: 'news', tts_options: null }),
    { intro: 'news-intro.wav', outro: 'news-outro.wav', intro_spacing: -2.5 }),
    'null tts_options leaves the profile intact')

const defaultWarns = []
loggerProto.warn = function (message, tag) {
    defaultWarns.push({ message, tag })
    return originalWarn.call(this, message, tag)
}
TtsProfiles.resolve({ tts_profile: 'ghost-default' })
loggerProto.warn = originalWarn
assert(defaultWarns.length === 1 && defaultWarns[0].tag === 'TtsProfiles',
    'resolve() without an onWarn sink falls back to LoggerService.warn')

// -- C) speak() ---------------------------------------------------------------
console.log('\n-- C) speak() --')

const emitted = []
const unsubSpeak = EventBus.subscribe('tts:speak', (payload) => emitted.push(payload))

TtsProfiles.speak('Hello there')
assert(emitted.length === 1 && JSON.stringify(emitted[0]) === JSON.stringify({ text: 'Hello there' }),
    `empty options keep the plain { text } payload (${JSON.stringify(emitted[0])})`)

TtsProfiles.speak('Hello again', TtsProfiles.resolve({ tts_profile: 'news' }))
assert(JSON.stringify(emitted[1]) === JSON.stringify({
    text: 'Hello again', intro: 'news-intro.wav', outro: 'news-outro.wav', intro_spacing: -2.5
}), `resolved framing is spread into the payload (${JSON.stringify(emitted[1])})`)

TtsProfiles.speak('No endpoint here', { intro: 'a.wav', output_endpoint: 'tcp://x' })
assert(emitted[2].output_endpoint === 'tcp://x',
    'speak() stays a thin spread -- the sink stays the caller/TtsService concern')
unsubSpeak()

// -- D) Weatherman delegation -------------------------------------------------
console.log('\n-- D) Weatherman delegation --')

const wm = new TtsWeatherManAutomation()   // constructor loads YAML; no init() -> no timer

assert(sameOptions(wm.resolveTtsOptions({ tts_profile: 'news' }),
    { intro: 'news-intro.wav', outro: 'news-outro.wav', intro_spacing: -2.5 }),
    'resolveTtsOptions() understands tts_profile')

assert(sameOptions(wm.resolveTtsOptions({
    tts_profile: 'news',
    tts_options: { intro: 'own.wav' }
}), { intro: 'own.wav', outro: 'news-outro.wav', intro_spacing: -2.5 }),
    'Weatherman keeps its explicit-block precedence')

assert(sameOptions(wm.resolveTtsOptions({}), {}), 'empty automation config yields {}')
assert(sameOptions(wm.resolveTtsOptions({ tts_options: { intro: 42, outro: '', intro_spacing: 'soon' } }), {}),
    'malformed automation entries degrade to plain speech')
assert(sameOptions(wm.resolveTtsOptions(),
    { intro: 'mixkit-television-news-report-transition-3089.wav', outro: 'mixkit-intro-news-sound-1151.wav', intro_spacing: -2.5 }),
    'on-disk weatherman config still resolves its jingle (smoke)')

loggerProto.warn = originalWarn
ttsProto.getProfile = originalGetProfile

console.log(`\nResults: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

