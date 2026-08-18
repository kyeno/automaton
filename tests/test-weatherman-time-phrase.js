/**
 * Tests for TtsWeatherMan opening time-of-day line rendering (buildTimeSentence()).
 *
 * Covers: explicit digit-frame templates (generic + exact hour), midnight/noon
 * disambiguation via localized period words, smart-style fallback to model-spelled
 * hours, stupid_ai_engine style selection (false / true / absent), variant picker
 * hooks (:00 -> exact_hour; :30/:45 reserved fractions), and i18n degradation paths
 * (missing time_sentence subtree, missing period_words). Pure clock + config only --
 * no Redis/MQTT/AI needed; dates are passed explicitly so no global Date stubbing is
 * required.
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

/** Fixed calendar day for deterministic date math (Saturday 2026-08-15). */
const D = (hour, minute) => new Date(2026, 7 /* August */, 15, hour, minute, 0, 0)

// ---------------------------------------------------------------------------
// Setup -- real bundle via init(), same approach as test-weatherman-day-position.js
// ---------------------------------------------------------------------------
const wm = new TtsWeatherManAutomation()
await wm.init()   // loads #bundle from the active locale + starts a harmless hourly timer (stopped below)

const locale = I18nLoader.getLanguage()
const LOCALE_MAP = { pl: 'pl_PL', en: 'en_US' }
const dir = LOCALE_MAP[locale] || 'pl_PL'
const bundlePath = path.join(ROOT, 'etc/i18n', dir, 'weatherman.yaml')
const bundle = yamlParse(fs.readFileSync(bundlePath, 'utf8'))
console.log(`\n(using ${dir} weatherman bundle)\n`)

/** Hour token value exactly as buildTimeSentence() computes it for a given moment. */
function hoursToken(now) {
    const h24 = now.getHours()
    return String(I18nLoader.is12HourFormat() ? ((h24 + 11) % 12) + 1 : h24)
}

/** Localized period word for a moment against the real bundle's period_words map. */
function periodWord(now) {
    const period = temporal.getCurrentTimePeriod(now)
    return (period && bundle.period_words?.[period]) || period || ''
}

// ---------------------------------------------------------------------------
// A. explicit style -- generic frame
// ---------------------------------------------------------------------------
console.log('\n── buildTimeSentence(): explicit default frame ──\n')
{
    wm.isStupidAiEngine = () => true      // pin the style under test regardless of global config

    const now = D(21, 32)
    assert(temporal.getCurrentTimePeriod(now) === 'evening', 'sanity: 21:00 in August is evening')
    const out = wm.buildTimeSentence(now)
    let expected = String(bundle.time_sentence.explicit.default)
        .replace('{% hours %}', hoursToken(now))
        .replace('{% minutes %}', '32')
        .replace('{% time_of_day %}', periodWord(now))
    assert(out === expected, `default frame renders clock parts → "${out}"`)
    assert(!out.includes('{%'), 'no unresolved placeholders leak into output')
}

// ---------------------------------------------------------------------------
// B. explicit style -- exact hour (:00)
// ---------------------------------------------------------------------------
console.log('\n── buildTimeSentence(): exact hour ──\n')
{
    const now = D(9, 0)
    assert(temporal.getCurrentTimePeriod(now) === 'morning', 'sanity: 09:00 in August is morning')
    const out = wm.buildTimeSentence(now)
    let expected = String(bundle.time_sentence.explicit.exact_hour)
        .replace('{% hours %}', hoursToken(now))
        .replace('{% time_of_day %}', periodWord(now))
    assert(out === expected, `exact-hour template selected at :00 → "${out}"`)
    assert(!/minut/i.test(out), 'no minutes mentioned on the hour')
    assert(!out.includes('{%'), 'no unresolved placeholders leak into output')
}

// ---------------------------------------------------------------------------
// C. midnight vs noon disambiguation (the original Piper TTS failure mode)
// ---------------------------------------------------------------------------
console.log('\n── buildTimeSentence(): midnight / noon ambiguity ──\n')
{
    const midnight = D(0, 0)
    assert(temporal.getCurrentTimePeriod(midnight) === 'night', 'sanity: 00:00 is night')
    if (I18nLoader.is12HourFormat()) {
        // Midnight must render as "12" + a night word -- never bare "0", never ambiguous with noon.
        assert(hoursToken(midnight) === '12', '12h format maps midnight to hour 12')
    } else {
        assert(hoursToken(midnight) === '0', '24h format keeps midnight as hour 0')
    }
    let expectedMid = String(bundle.time_sentence.explicit.exact_hour)
        .replace('{% hours %}', hoursToken(midnight))
        .replace('{% time_of_day %}', periodWord(midnight))
    const outMid = wm.buildTimeSentence(midnight)
    assert(outMid === expectedMid, `midnight → "${outMid}"`)

    const noon = D(12, 0)
    assert(temporal.getCurrentTimePeriod(noon) === 'noon', 'sanity: 12:00 in August is noon')
    const outNoon = wm.buildTimeSentence(noon)
    assert(outMid !== outNoon, `midnight and noon render differently ("${outMid}" vs "${outNoon}")`)
}

// ---------------------------------------------------------------------------
// D. smart style (stupid_ai_engine: false) + absent-flag default
// ---------------------------------------------------------------------------
console.log('\n── buildTimeSentence(): smart style & flag defaults ──\n')
{
    wm.isStupidAiEngine = () => false
    // {% time %} resolves from the live clock -- tolerate a minute rollover between calls.
    const before = I18nLoader.formatTime()
    const out = wm.buildTimeSentence(new Date())
    const after = I18nLoader.formatTime()
    const tpl = String(bundle.time_sentence.smart.default)
    assert(
        out === tpl.replace('{% time %}', before) || out === tpl.replace('{% time %}', after),
        `smart template leaves {% time %} for the model → "${out}"`
    )
    assert(!out.includes('{%'), 'no unresolved placeholders leak into output')

    // Global switch wiring -- resolved through real ConfigService state loaded from automaton.yaml.
    delete wm.isStupidAiEngine
    assert(wm.isStupidAiEngine() === true, 'shipped automaton.yaml enables the global weak-model switch')
    const now = D(21, 32)
    let expected = String(bundle.time_sentence.explicit.default)
        .replace('{% hours %}', hoursToken(now))
        .replace('{% minutes %}', '32')
        .replace('{% time_of_day %}', periodWord(now))
    assert(wm.buildTimeSentence(now) === expected, 'enabled switch selects the explicit frame (also the default when the key is absent)')
}

// ---------------------------------------------------------------------------
// E. degradation & fail-open paths (synthetic bundles via optional param)
// ---------------------------------------------------------------------------
console.log('\n── buildTimeSentence(): degradation & fail-open ──\n')
{
    // Legacy bundle without decoupled templates -> no opening line at all.
    assert(wm.buildTimeSentence(D(9, 0), { base: 'x', ai_prefix: 'y' }) === '', 'bundle without time_sentence → empty string')
    assert(wm.buildTimeSentence(D(9, 0), null) === '', 'null bundle → empty string')

    // Requested style subtree missing in the bundle -> skip gracefully.
    const onlyExplicit = { time_sentence: { explicit: { default: 'X{% hours %}' } } }
    wm.isStupidAiEngine = () => false
    assert(wm.buildTimeSentence(D(9, 32), onlyExplicit) === '', 'smart requested but only explicit present → empty string')
    delete wm.isStupidAiEngine   // restore real ConfigService resolution for remaining cases
    assert(wm.buildTimeSentence(D(9, 32), onlyExplicit) === `X${hoursToken(D(9, 32))}`, 'explicit template rendered from injected bundle')

    // Missing period_words -> raw English period name as fallback.
    const noWords = { time_sentence: { explicit: { default: '[{% time_of_day %}]h{% hours %}m{% minutes %}' } } }
    const now = D(21, 32)
    const outNoWords = wm.buildTimeSentence(now, noWords)
    assert(outNoWords === `[${temporal.getCurrentTimePeriod(now)}]h${hoursToken(now)}m32`, `missing period words fall back to raw name → "${outNoWords}"`)

    // exact_hour absent at :00 -> generic default still applies.
    const noExact = { time_sentence: { explicit: { default: 'D h{% hours %} m{% minutes %}' } } }
    assert(wm.buildTimeSentence(D(9, 0), noExact) === `D h${hoursToken(D(9, 0))} m0`, ':00 without exact_hour falls back to default template')

    // Reserved fraction hooks route when a locale defines them...
    const withHalf = { time_sentence: { explicit: { default: 'DEF', half_past: 'HALF' } } }
    assert(wm.buildTimeSentence(D(9, 30), withHalf) === 'HALF', ':30 picks up half_past template when present')
    assert(wm.buildTimeSentence(D(9, 45), withHalf) === 'DEF', ':45 without quarter_to stays on default')
    // ...but shipped bundles keep the generic frame (no translations yet).
    let expectedShipped = String(bundle.time_sentence.explicit.default)
        .replace('{% hours %}', hoursToken(D(9, 30)))
        .replace('{% minutes %}', '30')
        .replace('{% time_of_day %}', periodWord(D(9, 30)))
    assert(wm.buildTimeSentence(D(9, 30)) === expectedShipped, 'shipped bundle at :30 still uses the generic frame')
}

await wm.cleanup()   // stop the timer started by init() so the process can exit

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : '') + `\n${'═'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)