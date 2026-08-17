/**
 * Tests for TtsWeatherMan day-position markers and lib/date duration helpers.
 *
 * Covers: humanToMs() parsing, parseDurationMs() polymorphic resolution, msToHumanPhrase() unit selection, dual-key
 * getTimerIntervalMs() resolution (timer_interval over legacy timer_interval_ms),
 * parseSilenceWindow()/isInSilentPeriodAt(), computeDayPosition() FIRST/LAST/ONLY/NEXT
 * matrix (including overnight wrap and fail-open cases), and buildAiPrompt() assembly
 * order with real i18n bundles. Pure clock + config only -- no Redis/MQTT/AI needed;
 * dates are passed explicitly so no global Date stubbing is required.
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

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import AutomationBase from '../src/automation/base/automationBase.js'
import temporal from '../src/lib/date.js'
import I18nLoader from '../src/service/i18nLoader.js'
import TtsWeatherManAutomation from '../etc/automation/ttsWeatherManAutomation.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

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

class ConcreteAutomation extends AutomationBase {
    execute() {}
}

/** Fixed calendar day for deterministic date math (Saturday 2026-08-15). */
const D = (hour, minute) => new Date(2026, 7 /* August */, 15, hour, minute, 0, 0)

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

// ---------------------------------------------------------------------------
// A. humanToMs parsing
// ---------------------------------------------------------------------------
console.log('\n── humanToMs() ──\n')
{
    const validCases = [
        ['90s', 90 * 1000],
        ['3m 45s', 3 * MINUTE_MS + 45_000],
        ['1h', HOUR_MS],
        ['2d 4h', 2 * 86_400_000 + 4 * HOUR_MS],
        ['  1H ', HOUR_MS],          // case-insensitive, trimmed
        ['540m', 540 * MINUTE_MS],
    ]
    for (const [input, expected] of validCases) {
        assert(temporal.humanToMs(input) === expected, `"${input}" → ${expected} ms`)
    }

    const invalidInputs = ['', '   ', 'abc', '5', '1x', 'h', '1.5h', '1 h', '-5s', '1h extra', null, undefined, 123]
    for (const input of invalidInputs) {
        assert(temporal.humanToMs(input) === null, `invalid ${JSON.stringify(input)} → null`)
    }
}

// ---------------------------------------------------------------------------
// A2. parseDurationMs -- polymorphic config value resolution
// ---------------------------------------------------------------------------
console.log('\n── parseDurationMs() ──\n')
{
    // Legacy plain numbers pass through untouched (already milliseconds).
    assert(temporal.parseDurationMs(90_000) === 90_000, 'plain number passthrough')
    assert(temporal.parseDurationMs(0) === 0, 'zero passes through (disable semantics decided by caller)')
    assert(temporal.parseDurationMs(-5) === -5, 'negative passes through (caller validates bounds)')

    // Human-readable strings resolve via humanToMs().
    assert(temporal.parseDurationMs('25m') === 25 * MINUTE_MS, '"25m" string form')
    assert(temporal.parseDurationMs('1h') === HOUR_MS, '"1h" string form')
    assert(temporal.parseDurationMs('3m 45s') === 3 * MINUTE_MS + 45_000, '"3m 45s" compound form')

    // Garbage in -> null so callers can warn and fall back to their defaults.
    for (const bad of ['abc', '5', '', null, undefined, {}, [], NaN]) {
        assert(temporal.parseDurationMs(bad) === null, `invalid ${JSON.stringify(bad)} → null`)
    }
}

// ---------------------------------------------------------------------------
// B. msToHumanPhrase unit selection
// ---------------------------------------------------------------------------
console.log('\n── msToHumanPhrase() ──\n')
{
    const units = { day: 'days', hour: 'hours', minute: 'minutes', second: 'seconds' }
    const phraseCases = [
        [86_400_000, '1 days'],                            // largest fitting unit pair wins
        [5 * HOUR_MS + 30 * MINUTE_MS, '5 hours 30 minutes'], // exact two-part compound
        [90 * MINUTE_MS, '1 hours 30 minutes'],            // no misleading rounded "2 hours"
        [45 * MINUTE_MS, '45 minutes'],                    // sub-hour stays single-unit
        [90_000, '1 minutes 30 seconds'],                  // not a misleading "2 minutes"
        [1500, '2 seconds'],                               // sub-minute rounds up at .5 s
    ]
    for (const [ms, expected] of phraseCases) {
        assert(temporal.msToHumanPhrase(ms, units) === expected, `${ms} ms → "${expected}"`)
    }

    // Missing words fall through to the next smaller available unit.
    assert(
        temporal.msToHumanPhrase(HOUR_MS, { minute: 'min' }) === '60 min',
        'missing hour word falls back to minute word'
    )
    assert(temporal.msToHumanPhrase(HOUR_MS, {}) === null, 'no unit words → null')
    assert(temporal.msToHumanPhrase(400, units) === null, 'sub-half-second with no match → null')
    for (const bad of [null, -5, NaN, Infinity]) {
        assert(temporal.msToHumanPhrase(bad, units) === null, `invalid ${String(bad)} → null`)
    }
}

// ---------------------------------------------------------------------------
// C. getTimerIntervalMs dual-key resolution
// ---------------------------------------------------------------------------
console.log('\n── getTimerIntervalMs() ──\n')
{
    let n = 0
    const mk = (cfg) => new ConcreteAutomation({ name: `timer-test-${++n}`, config: cfg })

    assert(mk({ timer_interval: '3m 45s' }).getTimerIntervalMs() === 225_000, 'human "3m 45s" parsed')
    assert(mk({ timer_interval: '90s', timer_interval_ms: 1 }).getTimerIntervalMs() === 90_000, 'new key wins over legacy')
    assert(mk({ timer_interval_ms: 75_000 }).getTimerIntervalMs() === 75_000, 'legacy numeric still works')
    assert(mk({}).getTimerIntervalMs() === 0, 'missing both keys → default disabled')
    assert(mk({ timer_interval: 'bogus' }).getTimerIntervalMs() === 0, 'invalid human value fails open to disabled')
    assert(mk({ timer_interval: '30d' }).getTimerIntervalMs() === 0, 'above 32-bit setInterval cap rejected')
    assert(mk({ timer_interval: '24h' }).getTimerIntervalMs() === 86_400_000, '"24h" accepted (under cap)')
}

// ---------------------------------------------------------------------------
// D. parseSilenceWindow / isInSilentPeriodAt
// ---------------------------------------------------------------------------
console.log('\n── parseSilenceWindow() / isInSilentPeriodAt() ──\n')
{
    const a = new ConcreteAutomation({ name: 'win', config: { silence_between: '0230-1030' } })
    const win = a.parseSilenceWindow()
    assert(win?.startMin === 150 && win?.endMin === 630, '"0230-1030" → startMin=150 endMin=630')

    const at = (h, m) => a.isInSilentPeriodAt(D(h, m))
    assert(at(3, 0) === true, '03:00 inside window')
    assert(at(10, 29) === true, '10:29 inside (just before exclusive end)')
    assert(at(10, 30) === false, '10:30 outside (end boundary exclusive)')
    assert(at(2, 29) === false, '02:29 outside (before inclusive start)')

    // Overnight wrap-around.
    const b = new ConcreteAutomation({ name: 'wrap', config: { silence_between: '2300-0600' } })
    const bw = (h, m) => b.isInSilentPeriodAt(D(h, m))
    assert(bw(23, 30) === true, 'overnight: 23:30 inside')
    assert(bw(0, 0) === true, 'overnight: midnight inside')
    assert(bw(5, 59) === true, 'overnight: 05:59 inside')
    assert(bw(6, 0) === false, 'overnight: 06:00 outside (exclusive end)')
    assert(bw(12, 0) === false, 'overnight: noon outside')

    assert(new ConcreteAutomation({ name: 'deg', config: { silence_between: '0500-0500' } }).parseSilenceWindow() === null, 'degenerate window → null')
    assert(new ConcreteAutomation({ name: 'bad', config: { silence_between: '5am-9pm' } }).isInSilentPeriodAt(D(7, 0)) === false, 'malformed format fails open')
}

// ---------------------------------------------------------------------------
// E. computeDayPosition matrix (weatherman instance, explicit dates)
// ---------------------------------------------------------------------------
console.log('\n── computeDayPosition() ──\n')
{
    const wm = new TtsWeatherManAutomation()
    const origConfig = wm.config   // restored before the prompt-assembly section below

    // Standard setup mirroring the shipped tts-weatherman.yaml defaults.
    wm.config = { timer_interval: '1h', silence_between: '0230-1030' }
    const I = HOUR_MS

    let p = wm.computeDayPosition(D(15, 0))
    assert(p.isFirst === false && p.isLast === false, 'mid-session 15:00 → neither first nor last')
    assert(p.nextIntervalMs === I, 'mid-session next tick is exactly one interval away')

    p = wm.computeDayPosition(D(11, 0))
    assert(p.isFirst === true && p.isLast === false, '11:00 (30 min after wake-up) → FIRST')
    assert(p.nextIntervalMs === I, 'first run still has a plain-interval next tick')

    p = wm.computeDayPosition(D(10, 45))
    assert(p.isFirst === true && p.isLast === false, '10:45 (15 min after wake-up) → FIRST')

    p = wm.computeDayPosition(D(1, 45))
    assert(p.isFirst === false && p.isLast === true, '01:45 (45 min before sleep) → LAST')
    assert(p.nextIntervalMs === 9 * I, 'last run skips the silent window until 10:45 (9 ticks)')

    p = wm.computeDayPosition(D(2, 45))
    assert(p.isFirst === false && p.isLast === false && p.nextIntervalMs === null, 'inside silence → defensive all-false/null')

    // Session shorter than the interval → every run is both first and last ("only").
    wm.config = { timer_interval: '24h', silence_between: '0600-1800' }
    p = wm.computeDayPosition(D(22, 0))
    assert(p.isFirst === true && p.isLast === true, 'session < interval at 22:00 → ONLY (first+last)')
    assert(p.nextIntervalMs === 24 * HOUR_MS, 'ONLY case next tick still one full interval away')
    p = wm.computeDayPosition(D(2, 0))
    assert(p.isFirst === true && p.isLast === true, 'session < interval across midnight at 02:00 → ONLY')

    // No silence window → no sessions; NEXT still works off the plain interval.
    wm.config = { timer_interval: '30m' }
    p = wm.computeDayPosition(D(12, 0))
    assert(p.isFirst === false && p.isLast === false, 'no silence window → never first/last')
    assert(p.nextIntervalMs === 30 * MINUTE_MS, 'NEXT falls back to plain interval without silence')

    // Disabled timer → nothing periodic to predict.
    wm.config = { silence_between: '0230-1030' }
    p = wm.computeDayPosition(D(15, 0))
    assert(p.isFirst === false && p.isLast === false && p.nextIntervalMs === null, 'disabled timer → all markers off')

    // -----------------------------------------------------------------------
    // F. buildAiPrompt assembly order (real i18n bundle via init())
    // -----------------------------------------------------------------------
    console.log('\n── buildAiPrompt() ──\n')

    wm.config = origConfig   // restore shipped config for a realistic prompt
    await wm.init()          // loads #bundle + starts a harmless hourly timer (stopped below)

    const locale = I18nLoader.getLanguage()
    const LOCALE_MAP = { pl: 'pl_PL', en: 'en_US' }
    const dir = LOCALE_MAP[locale] || 'pl_PL'
    const bundlePath = path.join(ROOT, 'etc/i18n', dir, 'weatherman.yaml')
    const bundle = yamlParse(fs.readFileSync(bundlePath, 'utf8'))
    console.log(`  (using ${dir} weatherman bundle)\n`)

    const CORE = 'CORE WEATHER MESSAGE'

    let out = wm.buildAiPrompt(CORE, {})
    assert(out === `${bundle.ai_prefix}\n${CORE}`, 'no day-position meta → prefix + core only (legacy behaviour)')

    out = wm.buildAiPrompt(CORE, { isFirst: true })
    let lines = out.split('\n')
    assert(lines.length >= 3 && lines[0] === bundle.ai_prefix, 'FIRST: prefix stays first line')
    assert(lines.includes(bundle.ai_message_first), 'FIRST: opener marker present')
    assert(lines.at(-1) === CORE, 'FIRST: core message last (no closer for first runs)')
    assert(
        lines.indexOf(bundle.ai_message_first) < lines.indexOf(CORE),
        'FIRST: opener sits between prefix and message'
    )

    out = wm.buildAiPrompt(CORE, { isLast: true })
    lines = out.split('\n')
    assert(lines.includes(bundle.ai_message_last) && !lines.includes(bundle.ai_message_first), 'LAST: only the last marker applies')
    assert(lines.at(-1) === CORE, 'LAST: no closer appended')

    // ONLY takes priority over FIRST/LAST.
    out = wm.buildAiPrompt(CORE, { isFirst: true, isLast: true, nextIntervalMs: I })
    lines = out.split('\n')
    assert(lines.includes(bundle.ai_message_only), 'ONLY: dedicated marker used when both apply')
    assert(!out.includes(bundle.ai_message_first) && !out.includes(bundle.ai_message_last), 'ONLY: first/last markers suppressed')
    assert(!out.includes('{%'), 'ONLY: no unresolved placeholders leak into prompt')

    // Middle-of-session run → closer with resolved {% next_interval %}.
    const phrase = temporal.msToHumanPhrase(I, bundle.duration_units ?? {})
    const expectedCloser = String(bundle.ai_message_next).replace('{% next_interval %}', phrase)
    out = wm.buildAiPrompt(CORE, { nextIntervalMs: I })
    lines = out.split('\n')
    assert(lines[0] === bundle.ai_prefix, 'NEXT: prefix stays first line')
    assert(lines.at(-2) === CORE, 'NEXT: core message directly above the closer')
    assert(lines.at(-1) === expectedCloser, `NEXT: closer resolves to "${expectedCloser}"`)
    assert(!out.includes('{%'), 'NEXT: placeholder fully interpolated')

    // FIRST suppresses the closer even when a next interval is known.
    out = wm.buildAiPrompt(CORE, { isFirst: true, nextIntervalMs: I })
    assert(out.includes(bundle.ai_message_first) && !out.includes(String(bundle.ai_message_next)), 'FIRST+next: opener only, no closer')

    await wm.cleanup()   // stop the timer started by init() so the process can exit
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : '') + `\n${'═'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)