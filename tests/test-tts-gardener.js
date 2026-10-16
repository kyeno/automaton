/**
 * Tests for TtsGardenerAutomation -- moisture band selection, event gating, output routing,
 * AI fallbacks, twice-daily slot scheduling, silent-period suppression, and off-guard.
 *
 * Covers: top-down threshold bands against the shipped production thresholds (20/35/50)
 * including boundary values, worst-plant aggregation across multiple flowers with driest-first
 * affected lists carrying the percent sign, the reactive gate (worsening speaks / repeats stay
 * quiet / recovery resets the baseline so re-drying speaks again), the reactive:false gate (a
 * drop into a slots-only band moves the baseline and stays quiet, the next drop into an urgent
 * band speaks), the event_cooldown gate (a second worsening inside the window is suppressed,
 * the escalation is heard once the window expires, slot reports are never cooled), use_ai:false
 * direct-TTS path, use_ai:true happy path (instruction + UI echo, model reply surfaced, no
 * double-speak), the no-tools clause every ai instruction carries, AI-down / thrown-error
 * / empty-reply fallbacks to plain TTS with no spoken notice, missing-bucket degradation not
 * consuming announcement state, announce_times once-per-day markers consumed in Redis with a
 * grace window and surviving a restart, silence_between suppression with force bypass, the
 * both-channels-off guard, the moisture_property contract (template parity, soil_moisture
 * default, custom key honored), and the mail leg of the stuck-probe warning -- owners receive
 * the very sentence the speaker said, even when speech is gated by stuck_speak, the silent
 * period or a down output channel.
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
import CacheService from '../src/service/cacheService.js'
import I18nLoader from '../src/service/i18nLoader.js'
import TtsService from '../src/service/ttsService.js'
import EmailService from '../src/service/emailService.js'
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

/** State key the shipped production config declares for flower readings, read from the config
 *  itself so automation, config and test can never drift apart silently (zigbee2mqtt exposes
 *  capacitive soil probes as soil_moisture). The stub below publishes exactly this key. */
const moistureKey = typeof shippedConfig.moisture_property === 'string' && shippedConfig.moisture_property.trim()
    ? shippedConfig.moisture_property.trim()
    : 'soil_moisture'

/** Live flower states the stubbed DeviceContainer reports; values may be non-numeric on purpose. */
const flowerStates = new Map()
const dcProto = Object.getPrototypeOf(DeviceContainer)
const origFindByName = dcProto.findByName
dcProto.findByName = (name) => flowerStates.has(name)
    ? { getStateLast: () => ({ [moistureKey]: flowerStates.get(name), battery: 97 }) }
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

// Once-per-day slot markers: CacheService is a frozen singleton, so patch its prototype like
// test-tts-twilight.js does. markerStore stands in for Redis -- it survives gardener.resetState(),
// which is the restart proxy for "a slot already announced today stays announced".
const cacheProto = Object.getPrototypeOf(CacheService)
const origCacheGet = cacheProto.get
const origCacheSet = cacheProto.set
const markerStore = new Map()
cacheProto.get = async (key) => (markerStore.has(key) ? markerStore.get(key) : undefined)
cacheProto.set = async (key, item) => { markerStore.set(key, item); return true }
function clearMarkers() { markerStore.clear() }

// Mail leg: EmailService is a frozen singleton too, so its prototype is patched the same way.
// notify() is recorded instead of queued -- no SMTP relay is contacted by these tests.
const mailProto = Object.getPrototypeOf(EmailService)
const origNotify = mailProto.notify
const seenMail = []
mailProto.notify = async (request) => { seenMail.push(request); return true }
function resetSeenMail() { seenMail.length = 0 }

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

/** Same stub with a day offset, for the stuck-probe watchdog's day-scale cycles. */
function stubDateTime(day, hour, minute) {
    const OriginalDate = global.Date
    class FakeDate extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) super(2026, 7 /* August */, day, hour, minute, 0, 0)
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
        event_cooldown: 0,           // scenarios gate on the cooldown explicitly, not implicitly
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
    flowerStates.set('Flower Test A', 30)   // dry band -- reactive
    gardener.config = cfg()
    gardener.resetState()
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const singleTokens = { affected_flowers: 'Flower Test A (30%)', driest_flower: 'Flower Test A', driest_moisture: '30%' }
    assert(seen.tts.length === 1, 'single-flower event speaks exactly once')
    assert(seen.tts[0]?.text === expectedText('dry', 'tts', singleTokens), 'speech is the interpolated dry tts line with live values')
    assert(seen.tts[0]?.text.includes('30%'), 'plain TTS speech carries the percent sign, not a bare number')
    assert(lastPrompt == null && seen.periodic.length === 0, 'no AI involvement on direct-TTS path')

    // -----------------------------------------------------------------------
    console.log('\n-- reactive gate: repeats quiet / worsening speaks / recovery resets baseline --')
    flowerStates.set('Flower Test A', 30)   // same level as just announced
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    assert(seen.tts.length === 0, 'repeat of an already-announced level stays quiet')

    flowerStates.set('Flower Test A', 15)   // worsens into critical band
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const critGateTokens = { affected_flowers: 'Flower Test A (15%)', driest_flower: 'Flower Test A', driest_moisture: '15%' }
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('critical', 'tts', critGateTokens), 'worsening to the next band speaks that bucket once')

    flowerStates.set('Flower Test A', 70)   // watered back up -> healthy again
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    assert(seen.tts.length === 0, 'recovery is observed but not announced')

    flowerStates.set('Flower Test A', 30)   // dries out AGAIN after recovery
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const redryTokens = { affected_flowers: 'Flower Test A (30%)', driest_flower: 'Flower Test A', driest_moisture: '30%' }
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('dry', 'tts', redryTokens), 're-drying after a silent recovery speaks again (baseline was reset by the recovery)')

    // -----------------------------------------------------------------------
    console.log('\n-- reactive:false bands are slots-only: baseline moves, voice does not --')
    flowerStates.set('Flower Test A', 70)   // watered back to healthy
    gardener.config = cfg()
    gardener.resetState()
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    assert(seen.tts.length === 0, 'a healthy garden with nothing to report stays quiet')

    flowerStates.set('Flower Test A', 45)   // worsens into "Getting dry" -- reactive: false
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    assert(seen.tts.length === 0, 'a drop into a reactive:false band is not announced by an event')

    flowerStates.set('Flower Test A', 44)   // same band, no worsening
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    assert(seen.tts.length === 0, 'drifting inside the same non-reactive band stays quiet')

    flowerStates.set('Flower Test A', 18)   // crosses into "Critical drought" -- reactive: true
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const fromQuietBandTokens = { affected_flowers: 'Flower Test A (18%)', driest_flower: 'Flower Test A', driest_moisture: '18%' }
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('critical', 'tts', fromQuietBandTokens), 'the next drop into a reactive band speaks -- the quiet runs moved the baseline, not the voice')

    // -----------------------------------------------------------------------
    console.log('\n-- multiple flowers: worst plant drives the bucket, list is driest-first --')
    flowerStates.set('Flower Test A', 45)   // slightly_dry
    flowerStates.set('Flower Test B', 30)   // dry -> overall worst
    gardener.config = cfg({ triggers_zigbee: ['Flower Test A', 'Flower Test B'] })
    gardener.resetState()
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test B,zigbee:Flower Test A' })
    const multiTokens = { affected_flowers: 'Flower Test B (30%), Flower Test A (45%)', driest_flower: 'Flower Test B', driest_moisture: '30%' }
    assert(seen.tts.length === 1, 'batched event speaks exactly once for the whole garden')
    assert(seen.tts[0]?.text === expectedText('dry', 'tts', multiTokens), 'worst bucket wins and both plants are named driest-first with values')

    // -----------------------------------------------------------------------
    console.log('\n-- event_cooldown throttles event reports; slots and forced runs are never cooled --')
    flowerStates.delete('Flower Test B')
    flowerStates.set('Flower Test A', 30)   // dry band -- reactive
    gardener.config = cfg({ event_cooldown: '30m', announce_times: ['1200'] })
    gardener.resetState()
    clearMarkers()
    let coolRestore = stubDate(12, 0)
    try {
        resetSeen()
        await gardener.execute({ trigger: 'zigbee:Flower Test A' })
        const coolTokens = { affected_flowers: 'Flower Test A (30%)', driest_flower: 'Flower Test A', driest_moisture: '30%' }
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('dry', 'tts', coolTokens), 'first worsening speaks and arms the cooldown')

        flowerStates.set('Flower Test A', 15)   // escalates into critical one minute later
        coolRestore(); coolRestore = stubDate(12, 1)
        resetSeen()
        await gardener.execute({ trigger: 'zigbee:Flower Test A' })
        assert(seen.tts.length === 0, 'escalation inside the cooldown window is suppressed')

        coolRestore(); coolRestore = stubDate(12, 31)
        resetSeen()
        await gardener.execute({ trigger: 'zigbee:Flower Test A' })
        const coolCritTokens = { affected_flowers: 'Flower Test A (15%)', driest_flower: 'Flower Test A', driest_moisture: '15%' }
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('critical', 'tts', coolCritTokens), 'the escalation the cooldown swallowed is heard once the window expires -- the suppressed run kept the old baseline')

        //  The report above re-armed the cooldown, so 12:32 sits deep inside the window and
        //  the scheduled slot has to speak through it.
        coolRestore(); coolRestore = stubDate(12, 32)
        gardener.config = cfg({ event_cooldown: '30m', announce_times: ['1232'] })
        resetSeen()
        await gardener.execute({ trigger: 'timer' })
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('critical', 'tts', coolCritTokens), 'the scheduled slot speaks while the cooldown is still active -- slots are never cooled')

        coolRestore(); coolRestore = stubDate(12, 33)
        resetSeen()
        await gardener.execute({ trigger: 'manual', force: true })
        assert(seen.tts.length === 1, 'a forced run speaks immediately, cooldown notwithstanding')
    } finally {
        coolRestore()
    }

    // -----------------------------------------------------------------------
    console.log('\n-- use_ai:true happy path speaks through the model only --')
    flowerStates.delete('Flower Test B')
    flowerStates.set('Flower Test A', 18)   // critical band
    gardener.config = cfg({ use_ai: true })
    setAi({ available: true, reply: 'Podlej kwiatki!' })
    gardener.resetState()
    resetSeen()
    await gardener.execute({ trigger: 'zigbee:Flower Test A' })
    const critTokens = { affected_flowers: 'Flower Test A (18%)', driest_flower: 'Flower Test A', driest_moisture: '18%' }
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
    assert(seen.system.length === 1 && seen.system[0].text === seen.tts[0].text,
        'AI-down fallback echoes the sentence it spoke into the UI (warn log only, no model notice)')
    assert(seen.periodic.length === 0, 'AI-down fallback posts no periodic response')

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
    clearMarkers()
    assert((await gardener.dueAnnounceSlot(new Date())) === nowHHmm, `slot ${nowHHmm} is due inside its grace window`)
    assert(gardener.slotMarkerKey(nowHHmm) === `auto:${gardener.name}:once:announce_slot_${nowHHmm}`, `slot marker key is the shared once-marker key (${gardener.slotMarkerKey(nowHHmm)})`)
    resetSeen()
    await gardener.execute({ trigger: 'timer' })
    assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('healthy', 'tts', {}), 'due slot speaks a full status report even when everything is fine')
    assert(markerStore.has(gardener.slotMarkerKey(nowHHmm)), 'the spoken slot consumed its once-per-day marker in Redis')
    assert((await gardener.dueAnnounceSlot(new Date())) == null, 'spoken slot is consumed for the rest of today')
    resetSeen()
    await gardener.execute({ trigger: 'timer' })
    assert(seen.tts.length === 0, 'second tick the same day does not re-fire the slot')
    gardener.resetState()
    assert((await gardener.dueAnnounceSlot(new Date())) == null, 'a restart (resetState) does not hand a spoken slot its daily budget back')
    clearMarkers()
    assert((await gardener.dueAnnounceSlot(new Date())) === nowHHmm, 'a fresh day (marker expired) fires the slot again')

    const farHour = (now.getHours() + 3) % 24
    const farHHmm = `${pad2(farHour)}${pad2(now.getMinutes())}`
    gardener.config = cfg({ announce_times: [farHHmm] })
    assert((await gardener.dueAnnounceSlot(new Date())) == null, `slot ${farHHmm} outside its window is not due`)
    resetSeen()
    await gardener.execute({ trigger: 'timer' })
    assert(seen.tts.length === 0, 'tick with no slot due stays quiet')

    // -----------------------------------------------------------------------
    console.log('\n-- silence_between suppresses events; force bypasses --')
    flowerStates.set('Flower Test A', 30)
    gardener.config = cfg({ silence_between: '0500-0900' })
    const restoreDate = stubDate(6, 30)   // 06:30 -- inside the silent window
    try {
        gardener.resetState()
        resetSeen()
        await gardener.execute({ trigger: 'zigbee:Flower Test A' })
        assert(seen.tts.length === 0, 'event during silent period is suppressed before any speech')
        resetSeen()
        await gardener.execute({ trigger: 'zigbee:Flower Test A', force: true })
        const forcedTokens = { affected_flowers: 'Flower Test A (30%)', driest_flower: 'Flower Test A', driest_moisture: '30%' }
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('dry', 'tts', forcedTokens), 'forced run bypasses the silent period and speaks normally')
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
    console.log('\n-- moisture_property drives which state key is read --')
    const distConfig = yamlParse(
        fs.readFileSync(resolve(ROOT, 'etc', 'automation', 'tts-gardener.yaml.dist'), 'utf8')
    )
    assert(distConfig.moisture_property === 'soil_moisture',
        'shipped template reads the real zigbee2mqtt soil-probe key (soil_moisture)')
    assert(shippedConfig.moisture_property === distConfig.moisture_property,
        `live moisture_property matches the shipped template (${shippedConfig.moisture_property})`)

    // -----------------------------------------------------------------------
    console.log('\n-- gating keys and the no-tools instruction ship in config and bundles --')
    assert(shippedConfig.event_cooldown === distConfig.event_cooldown,
        `event_cooldown present in live config and shipped template (${shippedConfig.event_cooldown})`)
    const reactiveFlags = (rules) => rules.map(r => String(r.reactive)).join(',')
    assert(reactiveFlags(shippedConfig.rules) === reactiveFlags(distConfig.rules),
        `reactive flags match the shipped template (${reactiveFlags(shippedConfig.rules)})`)
    assert(shippedConfig.rules[0].reactive === true && shippedConfig.rules[1].reactive === true,
        'the urgent bands are allowed to speak on their own')
    assert(shippedConfig.rules[2].reactive === false && shippedConfig.rules[3].reactive === false,
        'getting-dry and healthy are left to the scheduled slots')
    gardener.config = cfg({ rules: [{ name: 'No flag', conditions: { moisture: { lte: 99 } }, sentence: 'gardener.healthy' }] })
    assert(gardener.rules()[0].reactive === true, 'a rule with no reactive key defaults to reactive')

    const noToolsClause = localeDir === 'pl_PL' ? 'Nie używaj narzędzi' : 'Do not use tools'
    const distBundle = yamlParse(fs.readFileSync(resolve(ROOT, 'etc', 'i18n', localeDir, 'gardener.yaml.dist'), 'utf8'))
    for (const bucket of ['critical', 'dry', 'slightly_dry', 'healthy']) {
        assert(String(bundle[bucket]?.ai).includes(noToolsClause), `${bucket}.ai tells the model to use no tools (live bundle)`)
        assert(String(distBundle[bucket]?.ai).includes(noToolsClause), `${bucket}.ai tells the model to use no tools (template)`)
    }

    const savedFindByName = dcProto.findByName
    dcProto.findByName = (name) => {
        if (name === 'Flower Default Probe') return { getStateLast: () => ({ soil_moisture: 45, battery: 97 }) }
        if (name === 'Flower Legacy Probe') return { getStateLast: () => ({ moisture: 12, battery: 90 }) }
        return savedFindByName(name)
    }
    try {
        gardener.config = cfg({ triggers_zigbee: ['Flower Default Probe'], moisture_property: undefined })
        const defaults = gardener.readFlowerMoisture()
        assert(defaults.length === 1 && defaults[0].moisture === 45,
            'no moisture_property configured -> reads soil_moisture')

        gardener.config = cfg({ triggers_zigbee: ['Flower Legacy Probe'], moisture_property: 'moisture' })
        const legacy = gardener.readFlowerMoisture()
        assert(legacy.length === 1 && legacy[0].moisture === 12,
            'an explicit moisture_property is honored end-to-end')

        gardener.config = cfg({ triggers_zigbee: ['Flower Legacy Probe'], moisture_property: 'soil_moisture' })
        assert(gardener.readFlowerMoisture().length === 0,
            'a key the device does not report yields no reading, never a silent zero')
    } finally {
        dcProto.findByName = savedFindByName
    }

    // -----------------------------------------------------------------------
    console.log('\n-- unreadable sensors are skipped without silencing the rest --')
    flowerStates.set('Flower Test A', 45)     // good reading
    flowerStates.set('Flower Test B', 'wet')  // non-numeric value on purpose
    gardener.config = cfg({ triggers_zigbee: ['Flower Test A', 'Flower Test B', 'Flower Missing'] })
    const readings = gardener.readFlowerMoisture()
    assert(readings.length === 1 && readings[0].name === 'Flower Test A' && readings[0].moisture === 45, 'only the numeric reading survives; bad/missing devices are dropped with warnings')

    // -----------------------------------------------------------------------
    console.log('\n-- stuck-probe watchdog: periodic snapshot, a probe that did not move is named --')
    ttsUp = true
    setAi({ available: false })
    const stuckCfg = (o = {}) => cfg({
        triggers_zigbee: ['Flower Test A', 'Flower Test B'],
        announce_times: [],
        stuck_check_interval: '24h',
        stuck_warn_cooldown: '12h',
        stuck_speak: true,
        ...o
    })
    const snapshotKey = gardener.stuckSnapshotKey()
    const warnKey = gardener.stuckWarnMarkerKey()
    const snapshotAt = () => markerStore.get(snapshotKey)?.takenAt
    const stuckTokensFor = (intervalMs, flowers = 'Flower Test A (40%)') => ({
        stuck_flowers: flowers,
        stuck_window: gardener.stuckWindowPhrase(intervalMs)
    })
    const stuckTokens = stuckTokensFor(24 * 3_600_000)

    clearMarkers()
    gardener.resetState()
    gardener.config = stuckCfg()
    flowerStates.set('Flower Test A', 40)
    flowerStates.set('Flower Test B', 30)
    let restoreStuckDate = stubDateTime(15, 10, 0)
    try {
        //  First run: baseline only, nothing spoken.
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(markerStore.has(snapshotKey), 'first due run records the baseline snapshot')
        assert(JSON.stringify(markerStore.get(snapshotKey).readings) === JSON.stringify({ 'Flower Test A': 40, 'Flower Test B': 30 }),
            'the baseline holds every readable probe')
        assert(seen.tts.length === 0, 'the baseline run says nothing')
        const baselineAt = snapshotAt()

        //  Interval not elapsed: no comparison, snapshot untouched.
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 10, 30)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 0 && snapshotAt() === baselineAt, 'no comparison and no speech inside the interval')

        //  Next cycle: A frozen on the same value, B moved.
        restoreStuckDate()
        restoreStuckDate = stubDateTime(16, 10, 5)
        flowerStates.set('Flower Test A', 40)
        flowerStates.set('Flower Test B', 25)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('stuck', 'tts', stuckTokens),
            'the probe that did not move is named in the spoken warning')
        assert(markerStore.has(warnKey), 'the spoken warning stores its cooldown marker')
        assert(snapshotAt() === Date.now() && markerStore.get(snapshotKey).readings['Flower Test B'] === 25,
            'the snapshot rolls forward to the fresh readings')
        const rolledAt = snapshotAt()

        //  Every probe moved: all-clear, snapshot rolled, nothing spoken.
        restoreStuckDate()
        restoreStuckDate = stubDateTime(17, 10, 5)
        flowerStates.set('Flower Test A', 41)
        flowerStates.set('Flower Test B', 26)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 0, 'a garden where every probe moved stays quiet')
        assert(snapshotAt() === Date.now() && rolledAt !== snapshotAt(), 'the all-clear cycle still rolls the snapshot forward')

        //  Warn cooldown: 6h cycles, 12h between spoken warnings.
        gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: '12h' })
        clearMarkers()
        gardener.resetState()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 10, 0)
        flowerStates.set('Flower Test A', 40)
        flowerStates.set('Flower Test B', 33)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 0, 'cooldown scenario: the baseline is silent')
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 16, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 1, 'first detection speaks')
        const warnedAt = markerStore.get(warnKey)?.at
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 22, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 0, 'a detection inside the warn cooldown stays quiet')
        assert(snapshotAt() === Date.now() && markerStore.get(warnKey).at === warnedAt, 'the cooled detection rolls the snapshot and keeps its marker')
        restoreStuckDate()
        restoreStuckDate = stubDateTime(16, 5, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 1, 'a detection past the warn cooldown speaks again')

        //  stuck_speak:false keeps the warning in the logs only.
        gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: 0, stuck_speak: false })
        clearMarkers()
        gardener.resetState()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 10, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 16, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 0 && !markerStore.has(warnKey), 'stuck_speak:false never speaks and marks no cooldown')

        //  Silent period: snapshot keeps being taken, warning suppressed.
        gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: 0, silence_between: '2200-0800' })
        clearMarkers()
        gardener.resetState()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 23, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(16, 5, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(snapshotAt() === Date.now(), 'the snapshot keeps being taken during the silent period')
        assert(seen.tts.length === 0, 'the stuck warning is suppressed by the silent period')

        //  Output channels down: data recording continues, nothing is spoken.
        gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: 0, silence_between: null })
        ttsUp = false
        clearMarkers()
        gardener.resetState()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 10, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 16, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(snapshotAt() === Date.now() && seen.tts.length === 0, 'a down output channel never stops the snapshot')
        ttsUp = true

        //  The watchdog also runs from execute(), ahead of the slot gate.
        gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: 0, announce_times: [] })
        clearMarkers()
        gardener.resetState()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 10, 0)
        flowerStates.set('Flower Test A', 40)
        flowerStates.set('Flower Test B', 33)
        resetSeen()
        await gardener.execute({ trigger: 'timer' })
        assert(seen.tts.length === 0 && markerStore.has(snapshotKey), 'execute() records the baseline before the slot gate')
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 16, 0)
        flowerStates.set('Flower Test B', 34)
        resetSeen()
        await gardener.execute({ trigger: 'timer' })
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('stuck', 'tts', stuckTokensFor(6 * 3_600_000)),
            'a timer run with no slot due still voices the stuck warning')

        //  Redis outage: the in-memory baseline keeps the watchdog running.
        clearMarkers()
        gardener.resetState()
        gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: 0 })
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 10, 0)
        resetSeen()
        await gardener.runStuckWatchdog()
        const savedCacheGet = cacheProto.get
        cacheProto.get = async () => { throw new Error('redis is down') }
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 16, 0)
        flowerStates.set('Flower Test B', 35)
        resetSeen()
        await gardener.runStuckWatchdog()
        cacheProto.get = savedCacheGet
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('stuck', 'tts', stuckTokensFor(6 * 3_600_000)),
            'a Redis outage falls back to the in-memory baseline and still warns')

        //  Restart: the snapshot lives in Redis, the in-memory mirror is gone.
        clearMarkers()
        gardener.resetState()
        gardener.config = stuckCfg({ stuck_check_interval: '24h', stuck_warn_cooldown: 0 })
        markerStore.set(snapshotKey, { takenAt: Date.now() - 25 * 3_600_000, readings: { 'Flower Test A': 40, 'Flower Test B': 33 } })
        restoreStuckDate()
        restoreStuckDate = stubDateTime(16, 11, 0)
        flowerStates.set('Flower Test A', 40)
        flowerStates.set('Flower Test B', 33)
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 1 && seen.tts[0].text === expectedText('stuck', 'tts',
            stuckTokensFor(24 * 3_600_000, 'Flower Test A (40%), Flower Test B (33%)')),
            'after a restart the comparison runs against the snapshot from Redis')

        //  Disabled watchdog and interval parsing.
        gardener.config = stuckCfg({ stuck_check_interval: 0 })
        clearMarkers()
        gardener.resetState()
        resetSeen()
        await gardener.runStuckWatchdog()
        assert(!markerStore.has(snapshotKey) && seen.tts.length === 0, 'stuck_check_interval 0 disables the watchdog')
        assert(gardener.stuckWatchEnabled() === false && gardener.stuckIntervalMs() === 0, 'interval 0 reports the watchdog as off')
        gardener.config = stuckCfg({ stuck_check_interval: 'nonsense' })
        assert(gardener.stuckIntervalMs() === 24 * 3_600_000, 'an unparseable interval falls back to the 24h default')
        gardener.config = stuckCfg({ stuck_warn_cooldown: '3h' })
        assert(gardener.stuckWarnCooldownMs() === 3 * 3_600_000, 'warn cooldown accepts duration strings')
    } finally {
        restoreStuckDate()
    }

    // -----------------------------------------------------------------------
    console.log('\n-- stuck comparison rules and shipped keys --')
    assert(JSON.stringify(gardener.findStuckProbes(
        [{ name: 'A', moisture: 40 }, { name: 'B', moisture: 41 }, { name: 'C', moisture: 12 }],
        { takenAt: 0, readings: { A: 40, B: 41.5, D: 7 } }
    )) === JSON.stringify([{ name: 'A', moisture: 40 }]),
        'only probes present on both sides with byte-identical readings are stuck')
    assert(gardener.findStuckProbes([{ name: 'A', moisture: Number.NaN }], { takenAt: 0, readings: { A: Number.NaN } }).length === 0,
        'a non-numeric reading is never judged')
    assert(shippedConfig.stuck_check_interval === distConfig.stuck_check_interval
        && shippedConfig.stuck_warn_cooldown === distConfig.stuck_warn_cooldown
        && shippedConfig.stuck_speak === distConfig.stuck_speak,
        `stuck keys present in live config and shipped template (${shippedConfig.stuck_check_interval})`)
    const stuckDist = yamlParse(fs.readFileSync(resolve(ROOT, 'etc', 'i18n', localeDir, 'gardener.yaml.dist'), 'utf8'))
    assert(typeof stuckDist.stuck?.tts === 'string' && typeof stuckDist.stuck?.ai === 'string',
        `stuck bucket ships in the ${localeDir} template`)
    assert(String(bundle.stuck?.ai).includes(noToolsClause), 'stuck.ai tells the model to use no tools (live bundle)')
    assert(String(stuckDist.stuck.ai).includes(noToolsClause), 'stuck.ai tells the model to use no tools (template)')

    // -----------------------------------------------------------------------
    console.log('\n-- stuck warning mails the owners, speech gated or not --')
    gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: 0, stuck_speak: false })
    clearMarkers()
    gardener.resetState()
    restoreStuckDate = stubDateTime(15, 10, 0)
    flowerStates.set('Flower Test A', 40)
    flowerStates.set('Flower Test B', 33)
    try {
        await gardener.runStuckWatchdog()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 16, 0)
        flowerStates.set('Flower Test B', 34)   // B moved; only A is frozen
        resetSeen()
        resetSeenMail()
        await gardener.runStuckWatchdog()
        const mailTokens = stuckTokensFor(6 * 3_600_000)
        assert(seen.tts.length === 0, 'stuck_speak:false keeps the speaker quiet')
        assert(seenMail.length === 1, 'the gated warning still mails the owners once')
        assert(seenMail[0]?.kind === 'gardener_stuck', 'the mail leg names the gardener_stuck kind')
        assert(seenMail[0]?.tokens?.stuck_flowers === mailTokens.stuck_flowers
            && seenMail[0]?.tokens?.stuck_window === mailTokens.stuck_window,
            'the mail carries the stuck tokens of the probes that did not move')
        assert(seenMail[0]?.message === expectedText('stuck', 'tts', mailTokens),
            'the mail body is the very sentence the speaker would have said')
        assert(!markerStore.has(warnKey), 'a mail-only warning marks no speech cooldown')

        //  Spoken run: voice and mail carry the identical text.
        gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: 0, stuck_speak: true })
        clearMarkers()
        gardener.resetState()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 10, 0)
        flowerStates.set('Flower Test B', 33)
        await gardener.runStuckWatchdog()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 16, 0)
        flowerStates.set('Flower Test B', 34)
        resetSeen()
        resetSeenMail()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 1 && seenMail.length === 1 && seenMail[0].message === seen.tts[0].text,
            'a spoken warning mails exactly the text the speaker said')
        assert(markerStore.has(warnKey), 'the spoken warning still stores its own speech cooldown marker')

        //  Silent period: the owner asleep gets the mail, the speaker stays quiet.
        gardener.config = stuckCfg({ stuck_check_interval: '6h', stuck_warn_cooldown: 0, silence_between: '2200-0800' })
        clearMarkers()
        gardener.resetState()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(15, 23, 0)
        flowerStates.set('Flower Test B', 33)
        await gardener.runStuckWatchdog()
        restoreStuckDate()
        restoreStuckDate = stubDateTime(16, 5, 0)
        flowerStates.set('Flower Test B', 34)
        resetSeen()
        resetSeenMail()
        await gardener.runStuckWatchdog()
        assert(seen.tts.length === 0 && seenMail.length === 1,
            'the silent period gates the speaker only -- the mail goes out')
    } finally {
        restoreStuckDate()
    }

    // -----------------------------------------------------------------------
    console.log('\n-- in-flight slot guard: a slow report cannot be double-fired by the next tick --')
    flowerStates.set('Flower Test A', 30)   // dry band
    gardener.config = cfg({ use_ai: true, announce_times: ['1230'] })
    gardener.resetState()
    clearMarkers()
    let releaseAi = null
    const inFlightRestore = stubDate(12, 30)
    try {
        //  A controllable AI reply: the first tick's report hangs on it until we release it, so the
        //  second tick lands inside the grace window before the once-marker is set.
        let aiCalls = 0
        const aiGate = new Promise(resolve => { releaseAi = resolve })
        aiProto.isAvailable = () => true
        aiProto.processMessage = async (text) => {
            lastPrompt = text
            aiCalls++
            await aiGate
            return 'slow reply'
        }

        resetSeen()
        const first = gardener.execute({ trigger: 'timer' })   // takes the slot's in-flight guard, hangs on the AI

        //  Yield until the first run has reached the model -- the guard is taken before that point.
        for (let i = 0; i < 500 && lastPrompt == null; i++) {
            await new Promise(resolve => setImmediate(resolve))
        }
        assert(lastPrompt != null, 'the first tick reached the model and is holding the slot in flight')

        //  Second tick inside the grace window: the once-marker is not set yet, but the slot is in flight.
        const second = gardener.execute({ trigger: 'timer' })
        for (let i = 0; i < 50; i++) {
            await new Promise(resolve => setImmediate(resolve))
        }

        assert(aiCalls === 1, 'the second tick did not reach the model -- the slot is in flight')
        assert(seen.tts.length === 0, 'nothing spoken yet -- the first is still inside the AI call')

        //  Release the AI: the first run finishes, speaks, and sets the once-marker.
        releaseAi()
        await first
        await second

        assert(aiCalls === 1, 'exactly one report reached the model despite two ticks in the same slot')
        assert(markerStore.has(gardener.slotMarkerKey('1230')), 'the once-marker is set once, after the successful speech')
    } finally {
        inFlightRestore()
        resetAi()
        if (releaseAi) releaseAi()   // unblock any in-flight AI call
    }

} finally {
    unsubs.forEach(unsub => unsub())
    mailProto.notify = origNotify
    dcProto.findByName = origFindByName
    ttsProto.isEnabled = origTtsEnabled
    cacheProto.get = origCacheGet
    cacheProto.set = origCacheSet
    resetAi()
    if (failed > 0) process.exitCode = 1
    console.log(`\n${passed} passed, ${failed} failed\n`)
}
