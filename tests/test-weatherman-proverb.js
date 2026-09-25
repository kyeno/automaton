/**
 * Tests for the ttsWeatherMan proverb segment (add_proverb).
 *
 * Pins the contract of the `add_proverb` flag and, above all, the SEGMENT ORDER,
 * because the i18n wording depends on it:
 *   ai_prefix -> [opener] -> core message -> [proverb] -> [next-update closer]
 * The proverb sits after the report body but BEFORE the next-update closer, so the
 * next-update time stays the last thing said. That is also why ai_proverb makes no
 * positional claim of its own: a "close with this" wording would be false here, and
 * reusing ai_prefix's "Na koniec / Finally" anchor would compete with the anecdote
 * instruction the prefix already carries.
 *
 * Covers: flag off, strict-boolean gate, order on BOTH paths, the last-run shape
 * (no closer, so the proverb becomes last), per-path wording, {% proverb %}
 * resolving to a real line from proverbs.txt, no token leaks, and 40 consecutive
 * draws all landing on real entries.
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

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import I18nLoader from '../src/service/i18nLoader.js'
import { countLines, readLineAt } from '../src/lib/randomLine.js'
import TtsWeatherManAutomation from '../etc/automation/ttsWeatherManAutomation.js'

await ConfigService.init()
LoggerService.init()

const ROOT = resolve(import.meta.dirname, '..')

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

// Same bootstrap as the sibling weatherman tests: init() loads the real bundle.
const wm = new TtsWeatherManAutomation()
await wm.init()

const locale = I18nLoader.getLocale()
const bundle = yamlParse(fs.readFileSync(path.join(ROOT, 'etc/i18n', locale, 'weatherman.yaml'), 'utf8'))
// Active list first (local override); fall back to the shipped starter template on
// fresh clones where no proverbs.txt has been copied out yet.
const proverbsCandidates = ['proverbs.txt', 'proverbs.txt.dist'].map(n => path.join(ROOT, 'etc/i18n', locale, n))
const proverbsPath = proverbsCandidates.find(p => fs.existsSync(p))
assert(proverbsPath, `a proverb list exists for ${locale} (copy proverbs.txt.dist to proverbs.txt)`)
const realProverbCount = countLines(proverbsPath, { commentChar: '#' })

/** Every real proverb in the shipped file, for membership checks. */
const knownProverbs = Array.from({ length: realProverbCount }, (_, i) => readLineAt(proverbsPath, i, { commentChar: '#' }))

/** Stable text markers, read from the bundle rather than hard-coded. */
const AI_PROVERB_HEAD = String(bundle.ai_proverb).split('{% proverb %}')[0].trim()
const TTS_PROVERB_HEAD = String(bundle.tts_proverb).split('{% proverb %}')[0].trim()
const NEXT_HEAD = String(bundle.ai_message_next).split('{%')[0].trim()
const OPENER_FIRST = bundle.ai_message_first

console.log(`\n(using ${locale} weatherman bundle)\n`)

/** The shipped config has the flag off; each case sets what it needs explicitly. */
function withProverb(enabled) {
    wm.config = { ...wm.config, add_proverb: enabled }
}

const META = { isFirst: true, isLast: false, nextIntervalMs: 3600_000 }
const LAST_META = { isFirst: false, isLast: true, nextIntervalMs: null }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 Fixtures \u2500\u2500\n')

assert(typeof bundle.ai_proverb === 'string' && bundle.ai_proverb.includes('{% proverb %}'),
    'bundle defines ai_proverb with a {% proverb %} token')
assert(typeof bundle.tts_proverb === 'string' && bundle.tts_proverb.includes('{% proverb %}'),
    'bundle defines tts_proverb with a {% proverb %} token')
assert(bundle.ai_proverb !== bundle.tts_proverb,
    'ai_proverb and tts_proverb differ (direction vs. spoken wording)')
assert(realProverbCount > 0, `proverbs.txt holds ${realProverbCount} proverb(s) for ${locale}`)

// The proverb is no longer terminal, so ai_proverb must not claim to be a closing
// line -- and it must not reuse ai_prefix's "at the end" anchor either.
const END_ANCHOR = /na koniec|na sam koniec|\bfinally\b|zako\u0144cz|close your report/i
assert(!END_ANCHOR.test(String(bundle.ai_proverb)),
    'ai_proverb makes no terminal/positional claim (it is not the last segment)')

// ---------------------------------------------------------------------------
// Flag off
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 add_proverb: false \u2500\u2500\n')

withProverb(false)
{
    const ai = wm.buildAiPrompt('CORE', META)
    const tts = wm.buildDirectTtsText('CORE', META)
    assert(!ai.includes(AI_PROVERB_HEAD), 'AI prompt carries no proverb line')
    assert(!tts.includes(TTS_PROVERB_HEAD), 'direct TTS carries no proverb line')
    const aiLines = ai.split('\n')
    assert(aiLines[aiLines.length - 1].startsWith(NEXT_HEAD),
        'AI prompt unchanged: next-update closer still last')
    assert(tts.trim().endsWith('.'), 'direct TTS unchanged and still complete')
}

// Strict boolean gate, mirroring the greeter/gardener use_ai switch.
withProverb('true')
assert(!wm.buildDirectTtsText('CORE', META).includes(TTS_PROVERB_HEAD),
    'truthy non-boolean "true" does NOT enable the proverb')
withProverb(1)
assert(!wm.buildDirectTtsText('CORE', META).includes(TTS_PROVERB_HEAD),
    'truthy non-boolean 1 does NOT enable the proverb')
withProverb(undefined)
assert(!wm.buildDirectTtsText('CORE', META).includes(TTS_PROVERB_HEAD),
    'absent flag does NOT enable the proverb')

// ---------------------------------------------------------------------------
// Flag on -- both paths, and segment order
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 add_proverb: true \u2500\u2500\n')

withProverb(true)
{
    const aiLines = wm.buildAiPrompt('CORE', META).split('\n')
    const tts = wm.buildDirectTtsText('CORE', META)

    const iOpener = aiLines.indexOf(OPENER_FIRST)
    const iCore = aiLines.indexOf('CORE')
    const iProverb = aiLines.findIndex(l => l.startsWith(AI_PROVERB_HEAD))
    const iNext = aiLines.findIndex(l => l.startsWith(NEXT_HEAD))

    assert(iOpener >= 0 && iOpener < iCore, 'opener precedes the core message')
    assert(iCore < iProverb, 'proverb follows the core message')
    assert(iProverb < iNext, 'proverb precedes the next-update closer')
    assert(iNext === aiLines.length - 1, 'next-update closer is the LAST segment')
    assert(!aiLines.some(l => l.includes('{%')), 'no unresolved tokens in the prompt')

    assert(tts.includes(TTS_PROVERB_HEAD), 'direct TTS uses the spoken tts_proverb wording')
    const tCore = tts.indexOf('CORE')
    const tProverb = tts.indexOf(TTS_PROVERB_HEAD)
    const tNext = tts.indexOf(NEXT_HEAD)
    assert(tCore >= 0 && tCore < tProverb && tProverb < tNext,
        'direct TTS order: core -> proverb -> next-update closer')

    // The drawn line must be a real entry from proverbs.txt, never a header comment.
    const drawn = aiLines[iProverb].slice(String(bundle.ai_proverb).split('{% proverb %}')[0].length).trim()
    assert(drawn.length > 0 && !drawn.startsWith('#'),
        `drawn proverb is a real entry -> "${drawn}"`)
    assert(knownProverbs.includes(drawn), 'drawn proverb comes from the shipped proverbs.txt')
}

// Last run of a session carries no "next update" line, so the proverb becomes last.
withProverb(true)
{
    const aiLines = wm.buildAiPrompt('CORE', LAST_META).split('\n')
    const last = aiLines[aiLines.length - 1]
    assert(last.startsWith(AI_PROVERB_HEAD), 'last run still gets the proverb, now last')
    assert(aiLines[aiLines.length - 2] === 'CORE',
        'on the last run the proverb directly follows the core message')
    assert(!aiLines.some(l => l.includes('{%')), 'no unresolved tokens on the last run')
}

// Each path resolves its OWN i18n key. A raw non-containment check isn't viable here because the
// pl_PL ai_proverb deliberately embeds the spoken lead-in ("I pamiętajcie:"), so we verify each path
// emits its own proverb lead positively instead of asserting mutual exclusion.
withProverb(true)
{
    const ai = wm.buildAiPrompt('CORE', META)
    const tts = wm.buildDirectTtsText('CORE', META)
    assert(ai.includes(AI_PROVERB_HEAD), 'AI prompt uses the ai_proverb direction wording')
    assert(tts.includes(TTS_PROVERB_HEAD), 'direct TTS uses the tts_proverb spoken wording')
}

// Repeated draws must all resolve to real proverbs (the draw is re-randomized per
// call; a stale-index or cache bug would eventually emit a comment or null).
withProverb(true)
{
    let allGood = true
    for (let i = 0; i < 40; i++) {
        const tts = wm.buildDirectTtsText('CORE', META)
        if (!knownProverbs.some(p => tts.includes(p))) allGood = false
    }
    assert(allGood, '40 consecutive draws all emit a real proverb')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)
