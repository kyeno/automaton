/**
 * AI conversation isolation and turn serialization -- regression test.
 *
 * Replays the production failure where system-origin weather ticks accumulated in the
 * shared in-memory history during uptime (slower/larger prompts over time, interactive
 * replies referencing prior weather reports) and where a failed tick could leave an
 * orphan user message with no assistant reply behind. Also pins FIFO serialization so
 * concurrent callers (chat input vs periodic automation) can never interleave pushes or
 * tool loops against one conversation.
 *
 * Stubs OpenAiProvider.chat with scripted responses + a call recorder; drives the real
 * processMessage() pipeline. No network or MQTT required; if Redis is running, any
 * pre-existing conversation cache entry is saved and restored around the run.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

// Minimal env so provider construction succeeds even outside a fully configured checkout
process.env['AI_API_URL'] = process.env['AI_API_URL'] || 'http://localhost:11434/v1'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import I18nLoader from '../src/service/i18nLoader.js'
import OpenAiProvider from '../src/ai/providers/openaiProvider.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import ChatMessageOrigin from '../src/enum/aiChatMessageOrigin.js'

const CONVERSATION_KEY = 'ai:conversation:default'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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

console.log('\n── AI conversation isolation + serialization ──\n')

await ConfigService.init()
LoggerService.init()
try { await CacheService.init() } catch { /* Redis optional for this test */ }
await I18nLoader.init()

// Save any pre-existing conversation cache so the run does not clobber live chat state
let savedCache = null
if (CacheService.isConnected()) {
    try {
        const existing = await CacheService.get(CONVERSATION_KEY)
        if (existing !== undefined && existing !== null) savedCache = existing
    } catch { savedCache = null }
}

// Scripted model responses with a call recorder (messages snapshot + timing per call).
const originalChat = OpenAiProvider.prototype.chat
const calls = []          // { messages: Array, startedAt, finishedAt }
let scripted = []         // values to return, or Error instances to throw
OpenAiProvider.prototype.chat = async function (messages) {
    const rec = { messages: JSON.parse(JSON.stringify(messages)), startedAt: Date.now() }
    calls.push(rec)
    const next = scripted.length ? scripted.shift() : { role: 'assistant', content: '' }
    await sleep(60)       // widen the window enough that unserialized turns WOULD overlap
    rec.finishedAt = Date.now()
    if (next instanceof Error) throw next
    return next
}

await AiAssistant.init()

try {
    assert(AiAssistant.isAvailable(), 'AI assistant available with stubbed provider')

    const baseline = () => AiAssistant.getMessages().length   // system prompt only after clear

    // ── 1. Successful system tick leaves zero trace in shared history ────────────────
    console.log('── 1. system-origin success isolation ──')
    AiAssistant.clearConversation()
    const l0 = baseline()
    scripted = [{ role: 'assistant', content: 'Raport pogody A.' }]
    let reply = await AiAssistant.processMessage('WEATHER_ALPHA outside is warm today.', { origin: ChatMessageOrigin.SYSTEM })
    assert(reply === 'Raport pogody A.', 'system turn still returns its reply to the caller')
    assert(baseline() === l0, `history length unchanged after successful weather tick (${baseline()} vs ${l0})`)

    // ── 2. Failed system tick rejects AND leaves no orphan user message ──────────────
    console.log('── 2. system-origin failure isolation ──')
    AiAssistant.clearConversation()
    const l1 = baseline()
    scripted = [new Error('Fetch timed out after 500ms')]
    let threw = false
    try {
        await AiAssistant.processMessage('WEATHER_BETA storm rolling in.', { origin: ChatMessageOrigin.SYSTEM })
    } catch (error) {
        threw = true
        assert(/timed out/.test(error.message), 'failure propagates to the automation caller')
    }
    assert(threw, 'failed system tick rejects instead of resolving silently')
    assert(baseline() === l1, `no orphan user message left behind by a failed tick (${baseline()} vs ${l1})`)
    const orphans = AiAssistant.getMessages().filter(m => typeof m.content === 'string' && m.content.includes('WEATHER_BETA'))
    assert(orphans.length === 0, 'weather prompt text absent from history after failure')
    // ── 3. Context purity -- prior weather ticks invisible to later user turns ──────
    console.log('── 3. context purity for subsequent user turns ──')
    AiAssistant.clearConversation()
    scripted = [{ role: 'assistant', content: 'A.' }]
    await AiAssistant.processMessage('WEATHER_ALPHA first report.', { origin: ChatMessageOrigin.SYSTEM })
    scripted = [{ role: 'assistant', content: 'B.' }]
    await AiAssistant.processMessage('WEATHER_BETA second report.', { origin: ChatMessageOrigin.SYSTEM })

    calls.length = 0
    scripted = [{ role: 'assistant', content: 'ok' }]
    reply = await AiAssistant.processMessage('I co?', {})   // default origin: user
    const lastCall = calls[calls.length - 1]
    assert(reply === 'ok', 'user turn still completes normally')
    assert(lastCall.messages.length === 2, `user call sees only [system, user] (${lastCall.messages.length} msgs sent)`)
    assert(JSON.stringify(lastCall.messages).includes('I co?'), 'current user message present in the API payload')
    assert(!JSON.stringify(lastCall.messages).includes('WEATHER_'), 'no prior weather tick text leaked into the user-turn prompt')

    // ── 4. FIFO serialization -- concurrent turns never interleave ───────────────────
    console.log('── 4. concurrent turns serialize in request order ──')
    AiAssistant.clearConversation()
    const l4 = baseline()
    calls.length = 0
    scripted = [{ role: 'assistant', content: 'reply-one' }, { role: 'assistant', content: 'reply-two' }]
    const p1 = AiAssistant.processMessage('first-req', {})
    const p2 = AiAssistant.processMessage('second-req', {})   // fires while first is mid-flight
    const [r1, r2] = await Promise.all([p1, p2])
    assert(r1 === 'reply-one' && r2 === 'reply-two', 'each caller receives its own reply (FIFO)')

    const [cA, cB] = calls.slice(-2)
    const overlap = cA.startedAt < cB.finishedAt && cB.startedAt < cA.finishedAt
    assert(calls.length >= 2 && !overlap, `chat calls do not temporally overlap (${calls.length} recorded)`)
    assert(baseline() === l4 + 4, 'both user turns fully present afterwards (no cross-contamination)')
} finally {
    OpenAiProvider.prototype.chat = originalChat
    if (CacheService.isConnected()) {
        try {
            if (savedCache !== null) await CacheService.set(CONVERSATION_KEY, savedCache)
            else await CacheService.delete(CONVERSATION_KEY)
        } catch { /* best effort restore */ }
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : '') + `\n${'═'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)