/**
 * Tests for the date helper's i18n bundle ownership and the TTS weatherman's
 * date-aware opening line.
 *
 * Covers:
 *   A) loadDateBundle() -- per-locale loading, caching, and graceful degradation
 *   B) getDateParts() -- day/month/year resolution with declension-aware words
 *   C) getPeriodWords() / getDurationUnits() -- vocabulary moved out of weatherman.yaml
 *   D) buildTimeSentence() dated runs -- fused {% date %} token,
 *      and the plain (undated) path staying unchanged
 *   E) computeDayPosition() isFirstOfDay -- first run of the calendar day
 *   F) execute() off-guard -- both AI and TTS unavailable skips the run entirely
 *   G) execute() forceFirst -- the "/automation force <name> first" debug poke
 *      renders the dated line at a mid-session clock time
 *
 * Pure clock + config only -- no Redis/MQTT/AI providers needed; dates are passed
 * explicitly so no global Date stubbing is required.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import fs from 'node:fs'
import path from 'node:path'
import { resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import EventBus from '../src/service/eventBus.js'
import I18nLoader from '../src/service/i18nLoader.js'
import TtsService from '../src/service/ttsService.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import temporal from '../src/lib/date.js'
import TtsWeatherManAutomation from '../etc/automation/ttsWeatherManAutomation.js'

// Bootstrap config + logger so logging works in unit-test mode
await ConfigService.init()
LoggerService.init()

const ROOT = resolve(import.meta.dirname, '..')

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

/** Fixed calendar day for deterministic date math (Tuesday 2026-09-01). */
const D = (hour, minute) => new Date(2026, 8 /* September */, 1, hour, minute, 0, 0)

const dir = I18nLoader.getLocale()
const dateBundle = yamlParse(fs.readFileSync(path.join(ROOT, 'etc/i18n', dir, 'date.yaml'), 'utf8'))
const wmBundle = yamlParse(fs.readFileSync(path.join(ROOT, 'etc/i18n', dir, 'weatherman.yaml'), 'utf8'))
// ---------------------------------------------------------------------------
// A. loadDateBundle() -- loading, caching, degradation
// ---------------------------------------------------------------------------
console.log('── loadDateBundle() ──\n')
{
    const loaded = temporal.loadDateBundle()
    assert(loaded !== null, 'bundle loads from the active locale')
    assert(Array.isArray(loaded.day_names) && loaded.day_names.length === 7, 'day_names has 7 entries')
    assert(Array.isArray(loaded.month_names) && loaded.month_names.length === 12, 'month_names has 12 entries')
    assert(typeof loaded.date_sentence === 'string' && loaded.date_sentence.includes('{% day_name %}'), 'date_sentence template present')
    // Caching: a second call returns the same object reference (no re-read).
    assert(temporal.loadDateBundle() === loaded, 'second call returns the cached instance')
}

// ---------------------------------------------------------------------------
// B. getDateParts() -- declension-aware date resolution
// ---------------------------------------------------------------------------
console.log('── getDateParts() ──\n')
{
    // 2026-09-01 is a Tuesday; September is month index 8.
    const parts = temporal.getDateParts(D(12, 0))
    assert(parts.day_name === dateBundle.day_names[2], `day_name resolves to ${dateBundle.day_names[2]} (Tuesday)`)
    assert(parts.day === '1', 'day is the day-of-month number')
    assert(parts.month_name === dateBundle.month_names[8], `month_name resolves to ${dateBundle.month_names[8]} (September)`)
    assert(parts.year === '2026', 'year is the four-digit year')
    assert(parts.year_word === dateBundle.year_word, 'year_word matches the bundle')
    // Every field is always present (no undefined leaks).
    for (const key of ['day_name', 'day', 'month_name', 'year', 'year_word']) {
        assert(typeof parts[key] === 'string', `${key} is always a string`)
    }
}

// ---------------------------------------------------------------------------
// C. getPeriodWords() / getDurationUnits() -- vocabulary moved to date.yaml
// ---------------------------------------------------------------------------
console.log('── getPeriodWords() / getDurationUnits() ──\n')
{
    const words = temporal.getPeriodWords()
    for (const period of ['morning', 'noon', 'afternoon', 'evening', 'night']) {
        assert(typeof words[period] === 'string' && words[period].length > 0, `period word for ${period} present`)
    }
    assert(JSON.stringify(words) === JSON.stringify(dateBundle.period_words), 'period words match the date bundle')

    const units = temporal.getDurationUnits()
    for (const unit of ['day', 'hour', 'minute', 'second']) {
        assert(typeof units[unit] === 'string' && units[unit].length > 0, `duration unit for ${unit} present`)
    }
    // The weatherman bundle no longer carries these keys (they moved to date.yaml).
    assert(wmBundle.period_words === undefined, 'weatherman bundle no longer has period_words')
    assert(wmBundle.duration_units === undefined, 'weatherman bundle no longer has duration_units')
}

// ---------------------------------------------------------------------------
// D. buildTimeSentence() dated runs -- fused {% date %}
// ---------------------------------------------------------------------------
console.log('── buildTimeSentence(): dated runs ──\n')
{
    const wm = new TtsWeatherManAutomation()
    await wm.init()

    const now = D(21, 32)
    const expectedDate = dateBundle.date_sentence
        .replace('{% day_name %}', dateBundle.day_names[2])
        .replace('{% day %}', '1')
        .replace('{% month_name %}', dateBundle.month_names[8])
        .replace('{% year %}', '2026')
        .replace('{% year_word %}', dateBundle.year_word)

    // Dated run (first of day) fuses the date into the clock sentence.
    const outDated = wm.buildTimeSentence(now, wmBundle, { isFirstOfDay: true })
    assert(outDated.includes(expectedDate), `dated line contains the fused date → "${outDated}"`)
    assert(!outDated.includes('{%'), 'no unresolved placeholders leak into the dated line')

    // Undated run (mid-session) does NOT include the date.
    const outPlain = wm.buildTimeSentence(now, wmBundle, {})
    assert(!outPlain.includes(expectedDate), 'undated line has no date')
    assert(outPlain !== outDated, 'undated and dated lines differ')

    // Dated exact-hour variant (fuses the date, drops the minutes).
    const nowHour = D(21, 0)
    const outDatedHour = wm.buildTimeSentence(nowHour, wmBundle, { isFirstOfDay: true })
    assert(outDatedHour.includes(expectedDate), `dated exact-hour line contains the fused date → "${outDatedHour}"`)
    assert(!outDatedHour.includes('{%'), 'no unresolved placeholders in the dated exact-hour line')

    await wm.cleanup()
}

// ---------------------------------------------------------------------------
// E. computeDayPosition() isFirstOfDay -- first run of the calendar day
// ---------------------------------------------------------------------------
console.log('── computeDayPosition(): isFirstOfDay ──\n')
{
    const wm = new TtsWeatherManAutomation()
    wm.config = { timer_interval: '1h', silence_between: '0230-1030' }

    // 00:30 is within one hour of midnight → first of the day.
    let p = wm.computeDayPosition(D(0, 30))
    assert(p.isFirstOfDay === true, '00:30 (30 min after midnight) → isFirstOfDay')

    // 01:30 is two hours after midnight → not first of the day (1h interval).
    p = wm.computeDayPosition(D(1, 30))
    assert(p.isFirstOfDay === false, '01:30 (90 min after midnight) → not isFirstOfDay')

    // isFirstOfDay is independent of the silence window: a mid-session run near
    // midnight is still "first of the day" even though it is not first of the session.
    p = wm.computeDayPosition(D(0, 30))
    assert(p.isFirst === false && p.isFirstOfDay === true, '00:30 is mid-session but first of the day')

    // Disabled timer → no periodic notion of a day, so isFirstOfDay stays false.
    wm.config = { silence_between: '0230-1030' }
    p = wm.computeDayPosition(D(0, 30))
    assert(p.isFirstOfDay === false, 'disabled timer → isFirstOfDay off')
}

// ---------------------------------------------------------------------------
// F. execute() off-guard -- both AI and TTS unavailable skips the run
// ---------------------------------------------------------------------------
console.log('── execute(): both-off guard ──\n')
{
    const wm = new TtsWeatherManAutomation()
    await wm.init()

    const seen = { tts: [], system: [] }
    const unsubs = [
        EventBus.subscribe('tts:speak', p => seen.tts.push(p)),
        EventBus.subscribe('ai:systemMessage', p => seen.system.push(p)),
    ]

    // Patch the frozen singletons' prototypes (same pattern as the AI-fallback test).
    const aiProto = Object.getPrototypeOf(AiAssistant)
    const ttsProto = Object.getPrototypeOf(TtsService)
    const originalAiAvailable = aiProto.isAvailable
    const originalTtsEnabled = ttsProto.isEnabled

    // Stub the wall clock to a mid-session instant (15:00, outside the default
    // 02:30-10:30 silence window) so the non-forced AI-only / TTS-only runs below are
    // not suppressed by the silent-period guard. Without this, those two assertions
    // depend on the real time of day and the suite is flaky (same pattern as section G).
    const OriginalDate = global.Date
    class FakeDate extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) super(2026, 8 /* September */, 1, 15, 0, 0, 0)
            else super(...args)
        }
        static now() { return new FakeDate().getTime() }
    }
    Object.setPrototypeOf(FakeDate.prototype, OriginalDate.prototype)
    global.Date = FakeDate

    try {
        // Both unavailable → the run is skipped before any context build or emission.
        aiProto.isAvailable = () => false
        ttsProto.isEnabled = () => false
        await wm.execute({ trigger: 'test' })
        assert(seen.tts.length === 0, 'both-off: no direct TTS emission')
        assert(seen.system.length === 0, 'both-off: no AI system message')

        // AI available, TTS off → the run proceeds (AI path).
        seen.tts.length = 0
        seen.system.length = 0
        aiProto.isAvailable = () => true
        ttsProto.isEnabled = () => false
        await wm.execute({ trigger: 'test' })
        assert(seen.system.length >= 1, 'AI-only: run proceeds (system message emitted)')

        // AI off, TTS available → the run proceeds (direct TTS path).
        seen.tts.length = 0
        seen.system.length = 0
        aiProto.isAvailable = () => false
        ttsProto.isEnabled = () => true
        await wm.execute({ trigger: 'test' })
        assert(seen.tts.length >= 1, 'TTS-only: run proceeds (direct TTS emitted)')
    } finally {
        aiProto.isAvailable = originalAiAvailable
        ttsProto.isEnabled = originalTtsEnabled
        global.Date = OriginalDate
        for (const unsub of unsubs) unsub()
        await wm.cleanup()
    }
}

// ---------------------------------------------------------------------------
// G. execute() forceFirst -- the "/automation force <name> first" debug poke
// ---------------------------------------------------------------------------
console.log('── execute(): forceFirst debug poke ──\n')
{
    const wm = new TtsWeatherManAutomation()
    await wm.init()

    const seen = { tts: [] }
    const unsub = EventBus.subscribe('tts:speak', p => seen.tts.push(p))

    // Patch the frozen singletons' prototypes (same pattern as the off-guard test).
    const aiProto = Object.getPrototypeOf(AiAssistant)
    const ttsProto = Object.getPrototypeOf(TtsService)
    const originalAiAvailable = aiProto.isAvailable
    const originalTtsEnabled = ttsProto.isEnabled

    // Stub the wall clock to a mid-session instant (15:00, inside the 10:30-02:30
    // session) so computeDayPosition() is deterministic (all markers false) no
    // matter when the suite runs.
    const OriginalDate = global.Date
    class FakeDate extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) super(2026, 8 /* September */, 1, 15, 0, 0, 0)
            else super(...args)
        }
        static now() { return new FakeDate().getTime() }
    }
    Object.setPrototypeOf(FakeDate.prototype, OriginalDate.prototype)
    global.Date = FakeDate

    // The dated time line the forceFirst run should produce (same bundle + clock).
    const now = new Date(2026, 8, 1, 15, 0, 0, 0)
    const expectedDatedLine = wm.buildTimeSentence(now, wmBundle, { isFirst: true })

    try {
        // Direct TTS path (AI off, TTS on) so the emitted text is the raw message.
        aiProto.isAvailable = () => false
        ttsProto.isEnabled = () => true

        // Control: a plain forced run at 15:00 is mid-session -> undated line.
        await wm.execute({ trigger: 'test', force: true })
        assert(seen.tts.length === 1, 'control: forced mid-session run emits one TTS message')
        assert(!seen.tts[0].text.includes(expectedDatedLine), 'control: mid-session forced run stays undated')

        // forceFirst:true pretends this is the first run -> dated line at 15:00.
        seen.tts.length = 0
        await wm.execute({ trigger: 'test', force: true, forceFirst: true })
        assert(seen.tts.length === 1, 'forceFirst: forced run emits one TTS message')
        assert(seen.tts[0].text.includes(expectedDatedLine), `forceFirst: mid-session run is dated → "${seen.tts[0].text}"`)
    } finally {
        aiProto.isAvailable = originalAiAvailable
        ttsProto.isEnabled = originalTtsEnabled
        unsub()
        global.Date = OriginalDate
        await wm.cleanup()
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : '') + `\n${'═'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)

