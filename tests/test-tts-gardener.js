/**
 * Tests for TtsGardenerAutomation -- moisture band selection, event gating, output routing,
 * AI fallbacks, twice-daily slot scheduling, silent-period suppression, and off-guard.
 *
 * Covers: top-down threshold bands against the shipped production thresholds (20/35/50)
 * including boundary values, worst-plant aggregation across multiple flowers with driest-first
 * affected lists, the reactive gate (worsening speaks / repeats stay quiet / recovery resets
 * the baseline so re-drying speaks again), use_ai:false direct-TTS path, use_ai:true happy
 * path (instruction + UI echo, model reply surfaced, no double-speak), AI-down / thrown-error
 * / empty-reply fallbacks to plain TTS with no spoken notice, missing-bucket degradation not
 * consuming announcement state, announce_times once-per-day consumption with grace window,
 * silence_between suppression with force bypass, and the both-channels-off guard.
 *
 * Expected speech is derived from the ACTIVE locale's gardener bundle at runtime, so the same
 * assertions hold under pl_PL or en_US. Devices are stubbed on DeviceContainer's prototype;
 * AiAssistant/TtsService availability are stubbed like the WeatherMan/Greeter tests do.
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
import AiAssistant from '../src/ai/aiAssistant.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import TtsGardenerAutomation from '../etc/automation/ttsGardenerAutomation.js'

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

const localeDir = I18nLoader.getLocale()
const bundlePath = resolve(ROOT, 'etc', 'i18n', localeDir, 'gardener.yaml')
const bundle = yamlParse(fs.readFileSync(bundlePath, 'utf8'))
console.log(`\n(using ${localeDir} gardener bundle)\n`)

const shippedConfig = yamlParse(
    fs.readFileSync(resolve(ROOT, 'etc', 'automation', 'tts-gardener.yaml'), 'utf8')
)

/** Fill a bundle template's runtime placeholders from an explicit token map (test-side mirror). */
function expectedText(bucket, channel, tokens) {
    const tpl = bundle[bucket]?.[channel]
    assert(typeof tpl === 'string' && tpl.trim() !== '', `${bucket}.${channel} exists in active bundle`)
    return String(tpl).replace(/\{%\s*([a-z_]+)\s*%}/g, (_m, key) => tokens[key])
}

/** Live flower states the stubbed DeviceContainer reports; values may be non-numeric on purpose. */
const flowerStates = new Map()
const dcProto = Object.getPrototypeOf(DeviceContainer)
const origFindByName = dcProto.findByName
dcProto.findByName = (name) => flowerStates.has(name)
    ? { getStateLast: () => ({ moisture: flowerStates.get(name), battery: 97 }) }
    : null

// Deterministic output-channel guard: pretend the TTS server is up so execute()'s off-guard
// never depends on ambient environment. Flippable per scenario; restored at the end.
let ttsUp = true
const ttsProto = Object.getPrototypeOf(TtsService)
const origTtsEnabled = ttsProto.isEnabled
ttsProto.isEnabled = () => ttsUp

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
}
function resetAi() {
    aiProto.isAvailable = origIsAvailable
    aiProto.processMessage = origProcessMessage
    lastPrompt = null
}

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
        triggers_zigbee: ['Flower Test A'],
        use_ai: false,
        silence_between: null,
        announce_times: ['0830', '1900'],
        ...overrides
    }
}

const gardener = new TtsGardenerAutomation()   // constructor loads YAML; no init() -> no timers/subscriptions

try {
    // -----------------------------------------------------------------------
    console.log('\n-- bundle structure (all buckets, both channels) --')
    for (const bucket of ['critical', 'dry', 'slightly_dry', 'healthy']) {
        assert(typeof bundle[bucket]?.tts === 'string' && bundle[bucket].tts.trim(), `${bucket}.tts present`)
        assert(typeof bundle[bucket]?.ai === 'string' && bundle[bucket].ai.trim(), `${bucket}.ai present`)
    }

    // -----------------------------------------------------------------------
    console.log('\n-- threshold bands pick the right bucket (shipped 20/35/50 rules) --')
    gardener.config = cfg()
    const idx = (v) => gardener.bandIndexFor(v)
    assert((await idx(15)) === 0, '15% -> critical band (first rule)')
    assert((await idx(30)) === 1, '30% -> dry band')
    assert((await idx(45)) === 2, '45% -> slightly_dry band')
    assert((await idx(60)) === 3, '60% -> healthy band (last rule)')
    assert((await idx(20)) === 0, 'boundary 20% stays in critical (lte inclusive)')
    assert((await idx(35)) === 1, 'boundary 35% stays in dry (lte inclusive)')
    assert((await idx(50)) === 2, 'boundary 50% stays in slightly_dry (gt exclusive)')
    assert((await idx(51)) === 3, '51% crosses into healthy (gt strict)')

    // -----------------------------------------------------------------------
    console.log('\n-- use_ai:false speaks the bucket line directly on worsening --')
    flowerStates.set('Flower Test A', 45)
    gardener.config = cfg()
    gardener.resetState()
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const singleTokens = { affected_flowers: 'Flower Test A (45)', driest_flower: 'Flower Test A', driest_moisture: '45' }
    assert(seen.tts.length === 1, 'single-flower event speaks exactly once')
    assert(seen.tts[0]?.text === expectedText('slightly_dry', 'tts', singleTokens), 'speech is the interpolated slightly_dry tts line with live values')
    assert(lastPrompt == null && seen.periodic.length === 0, 'no AI involvement on direct-TTS path')

    // -----------------------------------------------------------------------
    console.log('\n-- reactive gate: repeats quiet / worsening speaks / recovery resets baseline --')
    flowerStates.set('Flower Test A', 45)   // same level as just announced
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    assert(seen.tts.length === 0, 'repeat of an already-announced level stays quiet')

    flowerStates.set('Flower Test A', 30)   // worsens into dry band
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const dryTokens = { affected_flowers: 'Flower Test A (30)', driest_flower: 'Flower Test A', driest_moisture: '30' }
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('dry', 'tts', dryTokens), 'worsening to the next band speaks that bucket once')

    flowerStates.set('Flower Test A', 70)   // watered back up -> healthy again
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    assert(seen.tts.length === 0, 'recovery is observed but not announced')

    flowerStates.set('Flower Test A', 49)   // dries out AGAIN after recovery
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const redryTokens = { affected_flowers: 'Flower Test A (49)', driest_flower: 'Flower Test A', driest_moisture: '49' }
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('slightly_dry', 'tts', redryTokens), 're-drying after a silent recovery speaks again (baseline was reset by the recovery)')

    // -----------------------------------------------------------------------
    console.log('\n-- multiple flowers: worst plant drives the bucket, list is driest-first --')
    flowerStates.set('Flower Test A', 45)   // slightly_dry
    flowerStates.set('Flower Test B', 30)   // dry -> overall worst
    gardener.config = cfg({ triggers_zigbee: ['Flower Test A', 'Flower Test B'] })
    gardener.resetState()
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test B,zigbee:Flower Test A' })
    const multiTokens = { affected_flowers: 'Flower Test B (30), Flower Test A (45)', driest_flower: 'Flower Test B', driest_moisture: '30' }
    assert(seen.tts.length === 1, 'batched event speaks exactly once for the whole garden')
    assert(seen.tts[0]?.text === expectedText('dry', 'tts', multiTokens), 'worst bucket wins and both plants are named driest-first with values')

    // -----------------------------------------------------------------------
    console.log('\n-- use_ai:true happy path speaks through the model only --')
    flowerStates.delete('Flower Test B')
    flowerStates.set('Flower Test A', 18)   // critical band
    gardener.config = cfg({ use_ai: true })
    setAi({ available: true, reply: 'Podlej kwiatki!' })
    gardener.resetState()
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const critTokens = { affected_flowers: 'Flower Test A (18)', driest_flower: 'Flower Test A', driest_moisture: '18' }
    const expectedInstruction = expectedText('critical', 'ai', critTokens)
    assert(lastPrompt === expectedInstruction, 'AI receives the interpolated ai.critical instruction')
    assert(seen.system[0]?.text === lastPrompt, 'UI system echo matches exactly what went to the model')
    assert(seen.periodic.length === 1 && seen.periodic[0].text === 'Podlej kwiatki!', "model's reply surfaced as periodic response")
    assert(seen.tts.length === 0, 'no double-speak when AI handled it (its own tts:speak is fired by AiAssistant)')

    // -----------------------------------------------------------------------
    console.log('\n-- use_ai:true fallbacks speak plain TTS once, no spoken notice --')
    setAi({ available: false })   // AI down entirely
    resetSeen()
    await gardener.execute({ trigger: 'manual' })   // immediate kind always speaks
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('critical', 'tts', critTokens), 'AI unavailable -> plain TTS sentence spoken once')
    assert(seen.system.length === 0 && seen.periodic.length === 0, 'AI-down fallback posts no UI notice (warn log only)')

    setAi({ available: true, failWith: 'provider exploded' })   // provider throws mid-flight
    resetSeen()
    lastPrompt = null
    await gardener.execute({ trigger: 'manual' })
    assert(lastPrompt === expectedInstruction, 'thrown case still sent the instruction to the model first')
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('critical', 'tts', critTokens), 'thrown AI error -> plain TTS sentence spoken once')
    assert(seen.periodic.length === 0, 'no periodic response when the provider threw')

    setAi({ available: true, reply: '' })   // empty reply
    resetSeen()
    lastPrompt = null
    await gardener.execute({ trigger: 'manual' })
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('critical', 'tts', critTokens), 'empty AI reply -> plain TTS sentence spoken once')
    assert(seen.periodic.length === 0, 'empty reply is not surfaced as a periodic response')

    // -----------------------------------------------------------------------
    console.log('\n-- missing bucket section degrades to a warning without speaking --')
    gardener.config = cfg({ rules: [{ name: 'Only band', conditions: { moisture: { lte: 99 } }, sentence: 'gardener.nope' }] })
    resetSeen()
    await gardener.execute({ trigger: 'manual' })
    assert(seen.tts.length === 0 && seen.periodic.length === 0, 'unknown bundle key -> nothing spoken on either path')

    // -----------------------------------------------------------------------
    console.log('\n-- announce_times slots fire once per day within their grace window --')
    const now = new Date()
    const pad2 = (n) => String(n).padStart(2, '0')
    const nowHHmm = `${pad2(now.getHours())}${pad2(now.getMinutes())}`
    flowerStates.set('Flower Test A', 70)   // healthy garden for the scheduled report
    gardener.config = cfg({ announce_times: [nowHHmm] })
    gardener.resetState()
    assert(gardener.dueAnnounceSlot(new Date()) === nowHHmm, `slot ${nowHHmm} is due inside its grace window`)
    resetSeen()
    await gardener.execute({ trigger: 'timer' })
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('healthy', 'tts', {}), 'due slot speaks a full status report even when everything is fine')
    assert(gardener.dueAnnounceSlot(new Date()) == null, 'spoken slot is consumed for the rest of today')
    resetSeen()
    await gardener.execute({ trigger: 'timer' })
    assert(seen.tts.length === 0, 'second tick the same day does not re-fire the slot')
    gardener.resetState()
    assert(gardener.dueAnnounceSlot(new Date()) === nowHHmm, 'a fresh cycle (restart/next day proxy) can fire it again')

    const farHour = (now.getHours() + 3) % 24
    const farHHmm = `${pad2(farHour)}${pad2(now.getMinutes())}`
    gardener.config = cfg({ announce_times: [farHHmm] })
    assert(gardener.dueAnnounceSlot(new Date()) == null, `slot ${farHHmm} outside its window is not due`)
    resetSeen()
    await gardener.execute({ trigger: 'timer' })
    assert(seen.tts.length === 0, 'tick with no slot due stays quiet')

    // -----------------------------------------------------------------------
    console.log('\n-- silence_between suppresses events; force bypasses --')
    flowerStates.set('Flower Test A', 45)
    gardener.config = cfg({ silence_between: '0500-0900' })
    const restoreDate = stubDate(6, 30)   // 06:30 -- inside the silent window
    try {
        gardener.resetState()
        resetSeen()
        await gardener.execute({ trigger: 'zigbee:Flower Test A' })
        assert(seen.tts.length === 0, 'event during silent period is suppressed before any speech')
        resetSeen()
        await gardener.execute({ trigger: 'zigbee:Flower Test A', force: true })
        const forcedTokens = { affected_flowers: 'Flower Test A (45)', driest_flower: 'Flower Test A', driest_moisture: '45' }
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('slightly_dry', 'tts', forcedTokens), 'forced run bypasses the silent period and speaks normally')
    } finally {
        restoreDate()
    }

    // -----------------------------------------------------------------------
    console.log('\n-- off-guard when both AI and TTS are unavailable --')
    setAi({ available: false })
    lastPrompt = null   // any call to processMessage from here on would prove the guard failed
    ttsUp = false
    gardener.config = cfg()
    gardener.resetState()
    resetSeen()
    await gardener.execute({ trigger: 'manual' })
    assert(seen.tts.length === 0 && lastPrompt == null, 'no output channel -> run skipped entirely')

    // -----------------------------------------------------------------------
    console.log('\n-- unreadable sensors are skipped without silencing the rest --')
    flowerStates.set('Flower Test A', 45)     // good reading
    flowerStates.set('Flower Test B', 'wet')  // non-numeric value on purpose
    gardener.config = cfg({ triggers_zigbee: ['Flower Test A', 'Flower Test B', 'Flower Missing'] })
    const readings = gardener.readFlowerMoisture()
    assert(readings.length === 1 && readings[0].name === 'Flower Test A' && readings[0].moisture === 45, 'only the numeric reading survives; bad/missing devices are dropped with warnings')

} finally {
    unsubs.forEach(unsub => unsub())
    dcProto.findByName = origFindByName
    ttsProto.isEnabled = origTtsEnabled
    resetAi()
    if (failed > 0) process.exitCode = 1
    console.log(`\n${passed} passed, ${failed} failed\n`)
}
