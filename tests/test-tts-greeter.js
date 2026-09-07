/**
 * Tests for TtsGreeterAutomation -- greeting windows, output routing, and AI fallback.
 *
 * Covers: unknown-history fail-open (full welcome, no absence note without data), each
 * configured window band (reboot / short-return / welcome-back -- contiguous bands so
 * every return speaks), absence-note variants ("off for <duration>" vs "last online on
 * <date>", threshold override via absence_note_long_after), offline events being ignored,
 * use_ai:false direct-TTS path, use_ai:true happy path (instruction + note clause, no
 * double-speak), and AI-down / thrown-error / empty-reply fallbacks to plain TTS with no
 * spoken notice.
 *
 * Expected speech is derived from the ACTIVE locale's greeter bundle at runtime, so
 * the same assertions hold under pl_PL or en_US. Uses an isolated temp database;
 * AiAssistant and TtsService availability are stubbed on their prototypes like the
 * WeatherMan tests do.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as yamlParse } from 'yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DatabaseService from '../src/service/databaseService.js'
import EventBus from '../src/service/eventBus.js'
import I18nLoader from '../src/service/i18nLoader.js'
import TtsService from '../src/service/ttsService.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import TtsGreeterAutomation from '../etc/automation/ttsGreeterAutomation.js'
import temporal from '../src/lib/date.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'
await ConfigService.init()
LoggerService.init()

const ROOT = path.resolve(import.meta.dirname, '..')
let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  ok - ${label}`)
        passed++
    } else {
        console.error(`  FAIL - ${label}`)
        failed++
    }
}

// -- Fixtures ---------------------------------------------------------------

const localeDir = I18nLoader.getLocale()
const bundlePath = path.join(ROOT, 'etc', 'i18n', localeDir, 'greeter.yaml')
const bundle = yamlParse(fs.readFileSync(bundlePath, 'utf8'))
const dateBundle = yamlParse(
    fs.readFileSync(path.join(ROOT, 'etc', 'i18n', localeDir, 'date.yaml'), 'utf8')
)
console.log(`\n(using ${localeDir} greeter bundle)\n`)

const shippedConfig = yamlParse(
    fs.readFileSync(path.join(ROOT, 'etc', 'automation', 'tts-greeter.yaml'), 'utf8')
)

/** Fill a bundle template's name placeholders from names.<host> (test-side mirror of #sentence). */
function expectedText(bucket, channel, host) {
    const tpl = bundle[bucket]?.[channel]?.[host]
    assert(typeof tpl === 'string' && tpl.trim(), `${bucket}.${channel}.${host} exists in active bundle`)
    return String(tpl).replace(/\{%\s*name_(vocative|genitive)\s*%\}/g, (_m, caseName) => bundle.names[host][caseName])
}

/** Localized calendar-date fragment for a moment -- test-side mirror of WeatherMan's #buildDateFragment. */
function expectedDateFragment(date) {
    const parts = temporal.getDateParts(date)
    return String(dateBundle.date_sentence).replace(
        /\{%\s*(day_name|day|month_name|year|year_word)\s*%}/g,
        (_m, key) => parts[key] ?? ''
    )
}

/** Expected absence note appended to a greeting for a known duration ('' when none applies). */
function expectedNote(absenceMs, channel = 'tts', thresholdMs = 12 * HOUR) {
    if (!Number.isFinite(absenceMs) || !(absenceMs > 0)) return ''
    const section = bundle.absence_note?.[channel]
    if (!section) return ''
    const variant = absenceMs > thresholdMs ? 'long' : 'short'
    const tpl = typeof section[variant] === 'string' && section[variant].trim() ? section[variant] : null
    if (!tpl) return ''
    if (variant === 'short') {
        const phrase = temporal.msToHumanPhrase(absenceMs, temporal.getDurationUnits())
        return phrase ? tpl.replace(/\{%\s*time_phrase\s*%}/g, phrase) : ''
    }
    // long: the offline moment is seeded as NOW - absenceMs in every case below.
    const fragment = expectedDateFragment(new Date(NOW - absenceMs))
    return fragment ? tpl.replace(/\{%\s*last_online_date\s*%}/g, fragment) : ''
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-greeter-test-'))
assert(await DatabaseService.init(path.join(tmpDir, 'state.db')), 'database available for seeding history')

// Deterministic output-channel guard: pretend the TTS server is up so execute()'s
// off-guard never depends on ambient environment. Restored at the end.
const ttsProto = Object.getPrototypeOf(TtsService)
const origTtsEnabled = ttsProto.isEnabled
ttsProto.isEnabled = () => true

// AiAssistant stubbing -- same prototype-patch technique as test-weatherman-ai-fallback.js.
const aiProto = Object.getPrototypeOf(AiAssistant)
const origIsAvailable = aiProto.isAvailable
const origProcessMessage = aiProto.processMessage
let lastPrompt = null
function setAi({ available = false, reply = '', failWith = null } = {}) {
    aiProto.isAvailable = () => available
    aiProto.processMessage = async (text) => {
        lastPrompt = text
        if (failWith) throw new Error(failWith)
        return reply
    }
}
function resetAi() {
    aiProto.isAvailable = origIsAvailable
    aiProto.processMessage = origProcessMessage
    lastPrompt = null
}

/** Record a state sequence with controlled timestamps (Date.now patched per step). */
async function seedHistory(host, steps) {
    const origNow = Date.now
    try {
        for (const step of steps) {
            Date.now = () => step.atMs
            await DatabaseService.recordTransition({ domain: 'network', subject: host, toState: step.state })
        }
    } finally {
        Date.now = origNow
    }
}

// -- Event capture ----------------------------------------------------------

const seen = { tts: [], system: [], periodic: [] }
const unsubs = [
    EventBus.subscribe('tts:speak', p => seen.tts.push(p)),
    EventBus.subscribe('ai:systemMessage', p => seen.system.push(p)),
    EventBus.subscribe('ai:periodicResponse', p => seen.periodic.push(p))
]
function resetSeen() {
    seen.tts.length = 0
    seen.system.length = 0
    seen.periodic.length = 0
}

const greeter = new TtsGreeterAutomation()   // constructor loads YAML; no init() -> no timers/subscriptions
const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000

try {
    // -----------------------------------------------------------------------
    console.log('\n── unknown history fails open with a full welcome ──')
    greeter.config = { ...shippedConfig, use_ai: false }
    await seedHistory('meerkat', [{ state: 'online', atMs: NOW }])   // single row -> no prior state
    resetSeen()
    await greeter.execute({ trigger: 'network:meerkat' })
    assert(seen.tts.length === 1, 'unknown absence still produces exactly one greeting')
    assert(seen.tts[0]?.text === expectedText('welcome', 'tts', 'meerkat'), 'unknown absence speaks the welcome alone -- no note without duration data')
    assert(seen.periodic.length === 0 && lastPrompt == null, 'no AI involvement on direct-TTS path')

    // -----------------------------------------------------------------------
    console.log('\n── window bands pick the right bucket (use_ai:false) ──')
    greeter.config = { ...shippedConfig, use_ai: false }

    await seedHistory('kyeno', [
        { state: 'offline', atMs: NOW - 8 * HOUR },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:kyeno' })
    assert(seen.tts.length === 1, 'long absence (8h) speaks once')
    assert(
        seen.tts[0]?.text === `${expectedText('welcome', 'tts', 'kyeno')} ${expectedNote(8 * HOUR)}`,
        '8h absence -> welcome bucket + "off for" absence note'
    )

    await seedHistory('meerkat', [
        { state: 'offline', atMs: NOW - 15 * MIN },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:meerkat' })
    assert(seen.tts.length === 1, 'short return (15m) speaks once')
    assert(
        seen.tts[0]?.text === `${expectedText('forgot', 'tts', 'meerkat')} ${expectedNote(15 * MIN)}`,
        '15m absence -> forgot bucket ("did you forget something?") + off-for note'
    )

    await seedHistory('kyeno', [
        { state: 'offline', atMs: NOW - 90_000 },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    const rebootDecision = await greeter.greetDecisionFor('kyeno')
    assert(rebootDecision.action === 'speak' && rebootDecision.bucket === 'reboot', '90s absence classifies as the reboot band')
    await greeter.execute({ trigger: 'network:kyeno' })
    assert(seen.tts.length === 1, 'quick blip (90s) speaks once')
    assert(
        seen.tts[0]?.text === `${expectedText('reboot', 'tts', 'kyeno')} ${expectedNote(90_000)}`,
        '90s absence -> reboot bucket with genitive name + off-for note'
    )

    // The old silent gap (30m < x < 4h): shipped bands are contiguous now, so a 2h return
    // is greeted -- welcome bucket plus the "off for" absence note.
    await seedHistory('meerkat', [
        { state: 'offline', atMs: NOW - 2 * HOUR },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:meerkat' })
    assert(seen.tts.length === 1, '2h absence speaks once (contiguous bands -- no more silent gap)')
    assert(
        seen.tts[0]?.text === `${expectedText('welcome', 'tts', 'meerkat')} ${expectedNote(2 * HOUR)}`,
        '2h absence -> welcome bucket + off-for note'
    )
    assert(seen.system.length === 0 && seen.periodic.length === 0, 'case emits nothing to UI either')

    // -----------------------------------------------------------------------
    console.log('\n── absence notes switch from duration to date past the threshold ──')
    greeter.config = { ...shippedConfig, use_ai: false }

    // Above the default 12h threshold: "last online on <date it went offline>".
    await seedHistory('kyeno', [
        { state: 'offline', atMs: NOW - 30 * HOUR },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:kyeno' })
    const expectedLongNote = expectedNote(30 * HOUR)
    assert(expectedLongNote !== '', 'long-variant note resolves in active bundle')
    assert(
        seen.tts[0]?.text === `${expectedText('welcome', 'tts', 'kyeno')} ${expectedLongNote}`,
        '30h absence -> welcome bucket + last-online-on-date note'
    )

    // Config override moves the switch point: with a 6h threshold an 8h absence is "long".
    greeter.config = { ...shippedConfig, use_ai: false, absence_note_long_after: '6h' }
    await seedHistory('meerkat', [
        { state: 'offline', atMs: NOW - 8 * HOUR },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:meerkat' })
    assert(
        seen.tts[0]?.text === `${expectedText('welcome', 'tts', 'meerkat')} ${expectedNote(8 * HOUR, 'tts', 6 * HOUR)}`,
        'threshold override (6h): 8h absence renders the date variant instead of a duration'
    )

    // -----------------------------------------------------------------------
    console.log('\n── going offline is observed but never greeted ──')
    await seedHistory('kyeno', [{ state: 'offline', atMs: Date.now() }])   // kyeno ends OFFLINE now
    const offlineDecision = await greeter.greetDecisionFor('kyeno')
    assert(offlineDecision.action === 'skip', 'offline host decision is skip')
    assert(/not online/.test(offlineDecision.reason), 'skip reason names the actual state')
    resetSeen()
    await greeter.execute({ trigger: 'network:kyeno' })
    assert(seen.tts.length === 0, 'offline event produces no speech')

    // -----------------------------------------------------------------------
    console.log('\n── use_ai:true happy path speaks through the model only ──')
    greeter.config = { ...shippedConfig, use_ai: true }
    setAi({ available: true, reply: 'Witaj, Edytko!' })
    await seedHistory('meerkat', [
        { state: 'offline', atMs: NOW - 8 * HOUR },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:meerkat' })
    const expectedPrompt = `${expectedText('welcome', 'ai', 'meerkat')} ${expectedNote(8 * HOUR, 'ai')}`
    assert(lastPrompt === expectedPrompt, 'AI receives the ai.<host> instruction + absence-note clause')
    assert(seen.system[0]?.text === lastPrompt, 'UI system echo matches exactly what went to the model')
    assert(seen.periodic.length === 1 && seen.periodic[0].text === 'Witaj, Edytko!', "model's reply surfaced as periodic response")
    assert(seen.tts.length === 0, 'no double-speak when AI handled it (its own tts:speak is fired by AiAssistant)')

    // -----------------------------------------------------------------------
    console.log('\n── use_ai:true fallbacks speak plain TTS once, no spoken notice ──')
    greeter.config = { ...shippedConfig, use_ai: true }

    setAi({ available: false })   // AI down entirely
    await seedHistory('meerkat', [
        { state: 'offline', atMs: NOW - 15 * MIN },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:meerkat' })
    assert(seen.tts.length === 1 && seen.tts[0].text === `${expectedText('forgot', 'tts', 'meerkat')} ${expectedNote(15 * MIN)}`, 'AI unavailable -> plain TTS sentence + off-for note spoken once')
    assert(seen.system.length === 0 && seen.periodic.length === 0, 'AI-down fallback posts no UI notice (warn log only)')

    setAi({ available: true, failWith: 'provider exploded' })   // provider throws mid-flight
    await seedHistory('meerkat', [
        { state: 'offline', atMs: NOW - 8 * HOUR },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:meerkat' })
    assert(seen.tts.length === 1 && seen.tts[0].text === `${expectedText('welcome', 'tts', 'meerkat')} ${expectedNote(8 * HOUR)}`, 'thrown AI error -> plain TTS sentence + off-for note spoken once')
    assert(seen.periodic.length === 0, 'thrown AI error surfaces no periodic response')

    setAi({ available: true, reply: '' })   // model answers with nothing usable
    await seedHistory('meerkat', [
        { state: 'offline', atMs: NOW - 90_000 },
        { state: 'online', atMs: NOW }
    ])
    resetSeen()
    await greeter.execute({ trigger: 'network:meerkat' })
    assert(seen.tts.length === 1 && seen.tts[0].text === `${expectedText('reboot', 'tts', 'meerkat')} ${expectedNote(90_000)}`, 'empty AI reply -> plain TTS sentence + off-for note spoken once')
    assert(seen.system.length >= 1, 'the instruction was still echoed to UI before the failed attempt')

} finally {
    for (const unsub of unsubs) if (typeof unsub === 'function') unsub()
    resetAi()
    ttsProto.isEnabled = origTtsEnabled
    await DatabaseService.close().catch(() => {})
    fs.rmSync(tmpDir, { recursive: true, force: true })
}

if (failed > 0) throw new Error(`${failed} check(s) failed`)
console.log(`\nAll ${passed} greeter checks passed.`)
process.exit(0)
