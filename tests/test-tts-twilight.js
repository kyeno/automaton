/**
 * Tests for TtsTwilightAutomation -- civil dawn/dusk gate evaluation, exact-minute freshness,
 * once-per-day announcement markers, per-rule TTS framing, output routing with AI fallbacks,
 * silent-period suppression, force semantics, manual preview, missing geo, and the anchored timer.
 *
 * Covers: shipped rule normalization (event, gate, section, per-rule framing, `once` default),
 * malformed-rule warnings, the mutual exclusivity of the two sun gates, dawn/dusk firing inside
 * the announce grace window (before / at / after the instant, stale events rejected), one
 * announcement per event per day with independent dawn and dusk markers, Redis-down fail-open,
 * per-rule intro framing reaching both the direct-TTS payload and the AI pipeline, use_ai happy
 * path plus empty-reply / thrown-error / AI-down fallbacks without double-speak, silence_between
 * suppression with force bypass, forced runs not consuming the daily slot, manual runs previewing
 * the next upcoming event without consuming it, missing coordinates staying silent, and the
 * minute-anchored timer arming an interval only after its first boundary tick.
 *
 * Expected speech is derived from the ACTIVE locale's twilight bundle at runtime, so the same
 * assertions hold under pl_PL or en_US. Solar instants are stubbed to fixed local times, Date is
 * stubbed per scenario, and the CacheService layer is stubbed in-memory like test-automation-force
 * does, so marker behaviour never depends on a live Redis.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import fs from 'node:fs'
import { resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import EventBus from '../src/service/eventBus.js'
import I18nLoader from '../src/service/i18nLoader.js'
import TtsService from '../src/service/ttsService.js'
import CacheService from '../src/service/cacheService.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import solar from '../src/lib/sun.js'
import temporal from '../src/lib/date.js'
import TtsTwilightAutomation from '../etc/automation/ttsTwilightAutomation.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'
await ConfigService.init()
LoggerService.init()

const ROOT = resolve(import.meta.dirname, '..')
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

/** Civil dawn / civil dusk instants the stubbed solar provider reports (local, same day). */
const DAWN_HOUR = 5
const DAWN_MINUTE = 40
const DUSK_HOUR = 18
const DUSK_MINUTE = 20
const DAWN_CLOCK = '05:40'
const DUSK_CLOCK = '18:20'

const localeDir = I18nLoader.getLocale()
const bundlePath = resolve(ROOT, 'etc', 'i18n', localeDir, 'twilight.yaml')
const bundle = yamlParse(fs.readFileSync(bundlePath, 'utf8'))
console.log(`\n(using ${localeDir} twilight bundle)\n`)

const shippedConfig = yamlParse(
    fs.readFileSync(resolve(ROOT, 'etc', 'automation', 'tts-twilight.yaml'), 'utf8')
)

const ttsTemplate = yamlParse(
    fs.readFileSync(resolve(ROOT, 'etc', 'i18n', localeDir, 'tts.yaml'), 'utf8')
)

/** Fill a bundle template's runtime placeholders from an explicit token map (test-side mirror). */
function expectedText(section, channel, tokens) {
    const tpl = bundle[section]?.[channel]
    assert(typeof tpl === 'string' && tpl.trim() !== '', `${section}.${channel} exists in active bundle`)
    return String(tpl).replace(/\{%\s*([a-z_]+)\s*%}/g, (_m, key) => tokens[key])
}

// Solar stub: fixed civil dawn/dusk on the stubbed calendar day; flippable to "no geo".
const solarProto = Object.getPrototypeOf(solar)
const origGetSunTimes = solarProto.getSunTimes
let sunUp = true
solarProto.getSunTimes = (date = new Date()) => {
    if (!sunUp) return { sundawn: null, sundusk: null }
    const y = date.getFullYear()
    const m = date.getMonth()
    const d = date.getDate()
    return {
        sundawn: new Date(y, m, d, DAWN_HOUR, DAWN_MINUTE, 0, 0),
        sundusk: new Date(y, m, d, DUSK_HOUR, DUSK_MINUTE, 0, 0)
    }
}

// Deterministic output-channel guard: pretend the TTS server is up so execute()'s off-guard
// never depends on ambient environment. Flippable per scenario; restored at the end.
let ttsUp = true
const ttsProto = Object.getPrototypeOf(TtsService)
const origTtsEnabled = ttsProto.isEnabled
ttsProto.isEnabled = () => ttsUp
// TtsService loads its locale template in init(), which this test never runs; serve profiles
// from the parsed tts.yaml so per-rule framing resolves exactly as it does in production.
const origGetProfile = ttsProto.getProfile
ttsProto.getProfile = (name) => {
    const registry = ttsTemplate.profiles
    const wanted = String(name ?? '').trim().toLowerCase()
    if (!wanted || !registry) return null
    const key = Object.keys(registry).find((entry) => entry.toLowerCase() === wanted)
    return key ? registry[key] : null
}

// AiAssistant stubbing -- same prototype-patch technique as test-tts-greeter.js.
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
    lastPrompt = null
}
function resetAi() {
    aiProto.isAvailable = origIsAvailable
    aiProto.processMessage = origProcessMessage
    lastPrompt = null
}

// Daily-marker stub: CacheService is a frozen singleton, so patch its prototype like
// test-automation-force.js does. `cacheFails` emulates a Redis outage.
const cacheProto = Object.getPrototypeOf(CacheService)
const origCacheGet = cacheProto.get
const origCacheSet = cacheProto.set
const markerStore = new Map()
let cacheFails = false
cacheProto.get = async (key) => {
    if (cacheFails) throw new Error('redis is down')
    return markerStore.has(key) ? markerStore.get(key) : undefined
}
cacheProto.set = async (key, item) => {
    if (cacheFails) throw new Error('redis is down')
    markerStore.set(key, item)
    return true
}
function clearMarkers() { markerStore.clear() }

/** Stub Date to an arbitrary local time without waiting for the real clock (test-silence-between pattern). */
function stubDate(hour, minute) {
    const OriginalDate = global.Date
    class FakeDate extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) super(2026, 7 /* August */, 15, hour, minute, 0, 0)
            else super(...args)
        }
        static now() { return new FakeDate().getTime() }
    }
    Object.setPrototypeOf(FakeDate.prototype, OriginalDate.prototype)
    global.Date = FakeDate
    return () => { global.Date = OriginalDate }
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

/** Synthetic config over the shipped production one; scenarios override what they need. */
function cfg(overrides = {}) {
    return {
        ...shippedConfig,
        use_ai: false,
        timer_interval: '1m',
        announce_grace: '5m',
        silence_between: null,
        ...overrides
    }
}

/** Framing-only rules used where the intro of each event must be distinguishable. */
function framedRules() {
    return [
        { name: 'Civil dawn', event: 'sundawn', sentence: 'twilight.sundawn', tts_options: { intro: 'dawn-intro.wav', intro_spacing: -1.5 } },
        { name: 'Civil dusk', event: 'sundusk', sentence: 'twilight.sundusk', tts_options: { intro: 'dusk-intro.wav' } }
    ]
}

const twilight = new TtsTwilightAutomation()   // constructor loads YAML; no init() -> no timers/subscriptions

try {
    // -----------------------------------------------------------------------
    console.log('\n-- bundle and shipped config structure --')
    for (const section of ['sundawn', 'sundusk']) {
        assert(typeof bundle[section]?.tts === 'string' && bundle[section].tts.trim(), `${section}.tts present`)
        assert(typeof bundle[section]?.ai === 'string' && bundle[section].ai.trim(), `${section}.ai present`)
        assert(bundle[section].tts.includes('{% time %}'), `${section}.tts carries the {% time %} placeholder`)
        assert(ttsTemplate.profiles?.[section] !== undefined, `active tts.yaml defines the ${section} framing profile`)
    }
    assert(Array.isArray(shippedConfig.rules) && shippedConfig.rules.length === 2, 'shipped config ships exactly two rules')
    assert(shippedConfig.rules[0]?.event === 'sundawn' && shippedConfig.rules[1]?.event === 'sundusk', 'shipped rules announce civil dawn then civil dusk')
    assert(shippedConfig.rules.every(r => r.once === true), 'shipped rules consume the once-per-day marker')
    assert(shippedConfig.rules.every(r => typeof r.tts_profile === 'string' && r.tts_profile.trim()), 'each shipped rule names its own TTS profile')


    // -----------------------------------------------------------------------
    console.log('\n-- rule normalization and malformed-rule warnings --')
    twilight.config = cfg({ rules: [
        { name: 'No event', sentence: 'twilight.sundawn' },
        { name: 'No sentence', event: 'sundawn' },
        'not an object',
        { name: 'Upper dusk', event: ' SUNDUSK ', sentence: 'twilight.sundusk', once: false, tts_profile: ' dusk ', tts_options: { intro: 'x.wav' } },
        { name: 'Bare dawn', event: 'sunrise', sentence: 'twilight.sundawn' }
    ] })
    const norm = twilight.rules()
    assert(norm.length === 2, 'rules without event or sentence (and non-objects) are dropped with warnings')
    assert(norm[0].event === 'sundusk' && norm[0].once === false, 'event keys are case-insensitive and once:false is respected')
    assert(norm[0].tts_profile === 'dusk' && norm[0].tts_options.intro === 'x.wav', 'per-rule framing keys are carried through')
    assert(JSON.stringify(norm[1].conditions) === JSON.stringify({ after_latest_of: ['sundawn'] }), 'a rule without conditions gets the plain "event has happened" gate')
    assert(norm[1].event === 'sundawn', 'sunrise is accepted as an alias of the civil dawn instant')
    twilight.config = cfg()
    assert(twilight.rules().every(r => r.once === true), 'once defaults to true on the shipped rules')
    assert(twilight.announceGraceMs() === 300000, 'announce_grace "5m" parses to 300000 ms')
    twilight.config = cfg({ announce_grace: 'nonsense' })
    assert(twilight.announceGraceMs() === 300000, 'a malformed announce_grace falls back to the five-minute default')

    // -----------------------------------------------------------------------
    console.log('\n-- the two sun gates are mutually exclusive --')
    {
        const restore = stubDate(12, 0)
        try {
            const ctx = await twilight.buildContext()
            const dawnGate = await twilight.conditionsMatch(twilight.rules()[0].conditions, ctx)
            const duskGate = await twilight.conditionsMatch(twilight.rules()[1].conditions, ctx)
            assert(dawnGate === true && duskGate === false, 'mid-day: dawn gate open, dusk gate closed')
            assert(twilight.eventInstantMs('sundawn', ctx) === new Date(2026, 7, 15, DAWN_HOUR, DAWN_MINUTE).getTime(), 'dawn instant resolves from the built context')
            assert(twilight.eventInstantMs('sundusk', ctx) === new Date(2026, 7, 15, DUSK_HOUR, DUSK_MINUTE).getTime(), 'dusk instant resolves from the built context')
            assert(twilight.eventInstantMs('moonrise', ctx) === null, 'an unknown event key yields no instant')
        } finally { restore() }
    }
    {
        const restore = stubDate(19, 0)
        try {
            const ctx = await twilight.buildContext()
            const dawnGate = await twilight.conditionsMatch(twilight.rules()[0].conditions, ctx)
            const duskGate = await twilight.conditionsMatch(twilight.rules()[1].conditions, ctx)
            assert(dawnGate === false && duskGate === true, 'after dusk: dawn gate closed, dusk gate open')
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- dawn fires on its minute, framed by its own profile, once per day --')
    twilight.config = cfg({ rules: framedRules() })
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE)
        try {
            clearMarkers()
            twilight.resetState()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 1, 'dawn tick speaks exactly once')
            assert(seen.tts[0]?.text === expectedText('sundawn', 'tts', { time: DAWN_CLOCK }), 'speech is the dawn line carrying the event clock time')
            assert(seen.tts[0]?.intro === 'dawn-intro.wav' && seen.tts[0]?.intro_spacing === -1.5, 'the rule\'s own framing rides the utterance')
            assert(markerStore.size === 1, 'the dawn announcement consumes its daily marker')
            assert(lastPrompt == null && seen.periodic.length === 0, 'no AI involvement on the direct-TTS path')
        } finally { restore() }
    }
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE + 1)
        try {
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 0, 'the next tick inside the window stays quiet -- the day\'s dawn slot is consumed')
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- announce_grace bounds catch-up and rejects stale events --')
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE - 1)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 0, 'a tick before the event instant is quiet (the event is not fresh yet)')
        } finally { restore() }
    }
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE + 4)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 1, 'a late tick four minutes after the instant still announces the event')
        } finally { restore() }
    }
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE + 6)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 0, 'six minutes past the instant is outside the five-minute window -- stale event rejected')
        } finally { restore() }
    }
    {
        const restore = stubDate(9, 0)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 0, 'a mid-day tick announces neither dawn nor dusk')
        } finally { restore() }
    }


    // -----------------------------------------------------------------------
    console.log('\n-- dusk fires on its minute with its own framing --')
    {
        const restore = stubDate(DUSK_HOUR, DUSK_MINUTE)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 1, 'dusk tick speaks exactly once')
            assert(seen.tts[0]?.text === expectedText('sundusk', 'tts', { time: DUSK_CLOCK }), 'speech is the dusk line carrying the dusk clock time')
            assert(seen.tts[0]?.intro === 'dusk-intro.wav' && seen.tts[0]?.intro_spacing === undefined, 'dusk carries dusk framing with no spacing override')
        } finally { restore() }
    }
    {
        const restore = stubDate(DUSK_HOUR, DUSK_MINUTE)
        try {
            clearMarkers()
            markerStore.set(twilight.onceMarkerKey(twilight.rules()[0], 'evening'), { date: temporal.getLocalDayString() })
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 1, 'a consumed dawn marker does not silence the dusk announcement')
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- shipped per-rule profiles resolve from the locale tts.yaml --')
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE)
        try {
            twilight.config = cfg()
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            const dawnProfile = ttsTemplate.profiles?.sundawn
            assert(seen.tts.length === 1, 'the shipped dawn rule speaks through its named profile')
            assert(seen.tts[0]?.intro === dawnProfile?.intro && seen.tts[0]?.intro_spacing === dawnProfile?.intro_spacing, 'framing from the active tts.yaml profile reaches the utterance')
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- use_ai routes through the model, with plain-TTS fallbacks --')
    twilight.config = cfg({ rules: framedRules(), use_ai: true })
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE)
        try {
            setAi({ available: true, reply: 'Model dawn announcement' })
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            const dawnAi = expectedText('sundawn', 'ai', { time: DAWN_CLOCK })
            assert(seen.system.length === 1 && seen.system[0].text === dawnAi, 'the bundle ai instruction is echoed to the UI')
            assert(lastPrompt === dawnAi, 'the model receives the interpolated dawn instruction')
            assert(seen.periodic.length === 1 && seen.periodic[0].text === 'Model dawn announcement', 'the model reply is surfaced for rendering')
            assert(seen.tts.length === 0, 'no direct TTS emission when the AI voiced the announcement')
            assert(markerStore.size === 1, 'the AI-path announcement consumes the daily marker too')

            resetSeen()
            await twilight.execute({ trigger: 'manual', force: true })
            assert(seen.tts.length === 0 && seen.periodic.length === 1, 'a forced run re-announces through the AI')

            resetSeen()
            setAi({ available: true, reply: '' })
            clearMarkers()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('sundawn', 'tts', { time: DAWN_CLOCK }), 'an empty AI reply falls back to the plain TTS sentence')

            resetSeen()
            setAi({ available: true, reply: '', failWith: 'provider down' })
            clearMarkers()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 1 && seen.periodic.length === 0, 'a thrown AI error falls back to the plain TTS sentence')

            resetSeen()
            setAi({ available: false })
            clearMarkers()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 1 && lastPrompt == null, 'AI down speaks the plain TTS sentence without touching the model')
            resetAi()
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- silence_between suppresses; force bypasses and leaves the slot intact --')
    twilight.config = cfg({ rules: framedRules(), silence_between: '0500-0900' })
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 0, 'dawn inside the silent window is suppressed')
            resetSeen()
            await twilight.execute({ trigger: 'timer', force: true })
            assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('sundawn', 'tts', { time: DAWN_CLOCK }), 'a forced run bypasses the silent period and speaks')
            assert(markerStore.size === 0, 'a forced run does not consume the daily marker')
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- manual runs preview the next event without consuming it --')
    twilight.config = cfg({ rules: framedRules() })
    {
        const restore = stubDate(12, 0)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'manual' })
            assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('sundusk', 'tts', { time: DUSK_CLOCK }), 'a mid-day manual run previews the dusk event still ahead')
            assert(markerStore.size === 0, 'the preview leaves the daily marker untouched')
        } finally { restore() }
    }
    {
        const restore = stubDate(3, 0)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'manual' })
            assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('sundawn', 'tts', { time: DAWN_CLOCK }), 'a pre-dawn manual run previews the dawn event still ahead')
        } finally { restore() }
    }
    {
        const restore = stubDate(23, 0)
        try {
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'manual' })
            assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('sundusk', 'tts', { time: DUSK_CLOCK }), 'after both events a manual run previews the most recent one')
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- missing coordinates stay silent --')
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE)
        sunUp = false
        try {
            twilight.resetState()
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 0, 'no resolvable sun times -> no announcement')
            resetSeen()
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 0, 'the following tick stays quiet as well')
        } finally {
            sunUp = true
            restore()
        }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- Redis down fails open --')
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE)
        try {
            clearMarkers()
            resetSeen()
            cacheFails = true
            await twilight.execute({ trigger: 'timer' })
            assert(seen.tts.length === 1, 'a Redis outage does not block the announcement (marker check fails open)')
            cacheFails = false
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- off-guard when both AI and TTS are unavailable --')
    {
        const restore = stubDate(DAWN_HOUR, DAWN_MINUTE)
        try {
            setAi({ available: false })
            ttsUp = false
            clearMarkers()
            resetSeen()
            await twilight.execute({ trigger: 'manual' })
            assert(seen.tts.length === 0 && lastPrompt == null, 'no output channel -> run skipped entirely')
            ttsUp = true
            resetAi()
        } finally { restore() }
    }

    // -----------------------------------------------------------------------
    console.log('\n-- the timer is anchored to the interval boundary --')
    {
        twilight.config = cfg()
        const ticks = []
        const origExecute = twilight.execute
        twilight.execute = (data) => { ticks.push(data?.trigger ?? null); return Promise.resolve() }
        twilight.startTimer(1000)
        assert(twilight._timer == null, 'no raw interval is armed before the first boundary tick')
        await new Promise(done => setTimeout(done, 1300))
        assert(ticks.length >= 1, 'the anchored timer fires execute on a tick')
        assert(ticks[0] === 'timer', 'the tick is reported as a timer trigger')
        assert(twilight._timer != null, 'the repeating interval is armed once the anchor fires')
        twilight.cleanup()
        assert(twilight._timer == null, 'cleanup stops the repeating interval')
        twilight.execute = origExecute
    }

} finally {
    unsubs.forEach(unsub => unsub())
    solarProto.getSunTimes = origGetSunTimes
    cacheProto.get = origCacheGet
    cacheProto.set = origCacheSet
    ttsProto.isEnabled = origTtsEnabled
    ttsProto.getProfile = origGetProfile
    resetAi()
    if (failed > 0) process.exitCode = 1
    console.log(`\n${passed} passed, ${failed} failed\n`)
}
