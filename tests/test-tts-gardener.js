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
 * default, custom key honored). Sensor health has independent FrozenSensorMonitor tests.
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
    dcProto.findByName = origFindByName
    ttsProto.isEnabled = origTtsEnabled
    cacheProto.get = origCacheGet
    cacheProto.set = origCacheSet
    resetAi()
    if (failed > 0) process.exitCode = 1
    console.log(`\n${passed} passed, ${failed} failed\n`)
}
