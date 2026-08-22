/**
 * Tests for OpenAiProvider request timeout handling and per-request abort isolation.
 *
 * Pins the behaviours behind the Aug-22 weather-report outages without waiting anywhere
 * near a real LLM latency budget -- all timeouts are emulated with millisecond-scale
 * values against a local HTTP stand-in that controls how long each response takes:
 *   A) fetch_timeout_ms resolution ("5m" from automaton.yaml -> 300000ms; constructor
 *      override wins over config file)
 *   B) slow backend rejects with "Fetch timed out after <configured>ms", status 408
 *      (kept in the non-retried 4xx band), and exactly ONE request reaches the server
 *   C) concurrent requests on one instance no longer share AbortController/timer state:
 *      while request A sits past its own deadline, request B still completes within ITS
 *      own budget (under the old shared-timer design A's stale timer aborted B early)
 *   D) fast success path parses normally and sends an intact request body
 *
 * No Redis/MQTT/AI needed; the only network traffic is loopback to our own stub server.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import http from 'node:http'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import OpenAiProvider from '../src/ai/providers/openaiProvider.js'

await ConfigService.init()
LoggerService.init()

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Stub server -- dispatch hook decides per-request latency and payload
// ---------------------------------------------------------------------------
let dispatch = null
const hits = []
const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
        hits.push(Date.now())
        try {
            await dispatch(req, res, JSON.parse(body))
        } catch (error) {
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: error.message } }))
        }
    })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/v1`

function okResponse(res, content) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
}

console.log('\n── OpenAiProvider timeout handling ──\n')

try {
    // -----------------------------------------------------------------------
    // A. fetch_timeout_ms resolution
    // -----------------------------------------------------------------------
    console.log('── A. timeout configuration resolution ──')
    {
        const fromConfig = new OpenAiProvider({ apiUrl: base, model: 'test-model' })
        assert(fromConfig.getFetchTimeoutMs() === 300_000,
            'fetch_timeout_ms "5m" in automaton.yaml resolves to 300000ms (raised default era)')

        const overridden = new OpenAiProvider({ apiUrl: base, model: 'test-model', fetchTimeoutMs: 42 })
        assert(overridden.getFetchTimeoutMs() === 42, 'constructor override wins over config file')
    }

    // -----------------------------------------------------------------------
    // B. slow backend -> configured-timeout error, non-retried, single request
    // -----------------------------------------------------------------------
    console.log('── B. timeout rejection semantics ──')
    dispatch = async (_req, res) => { await sleep(900); okResponse(res, 'too-late') }
    {
        hits.length = 0
        const provider = new OpenAiProvider({
            apiUrl: base, model: 'test-model', maxTokens: 16, temperature: 0.1,
            maxRetries: 3, retryDelayMs: 50, fetchTimeoutMs: 400
        })
        provider.init()

        let err = null
        try {
            await provider.chat([{ role: 'user', content: 'hi' }])
        } catch (e) { err = e }

        assert(err !== null, 'slow backend rejects instead of hanging forever')
        assert(/Fetch timed out after 400ms/.test(err?.message || ''),
            `error names the CONFIGURED budget ("${err?.message}")`)
        assert(err?.status === 408, 'timeout mapped to status 408 so chat() treats it as final')
        assert(hits.length === 1, `no retry storm for a timed-out request (server saw ${hits.length} hit(s))`)
    }
    // -----------------------------------------------------------------------
    // C. per-request abort isolation under concurrency
    //    A starts first and runs past its own deadline; B starts mid-flight and
    //    finishes inside ITS OWN budget -- but AFTER A's stale deadline would have
    //    fired. Old shared-timer code aborted B at that moment; new code must not.
    // -----------------------------------------------------------------------
    console.log('── C. concurrent requests keep independent deadlines ──')
    dispatch = async (_req, res) => {
        const i = hits.length   // 1-based arrival index
        await sleep(i === 1 ? 900 : 450)
        okResponse(res, i === 1 ? 'slow' : 'fast')
    }
    {
        hits.length = 0
        const provider = new OpenAiProvider({
            apiUrl: base, model: 'test-model', maxTokens: 16, temperature: 0.1,
            maxRetries: 3, retryDelayMs: 50, fetchTimeoutMs: 600
        })
        provider.init()

        const pa = provider.chat([{ role: 'user', content: 'A' }]).catch(e => ({ err: e }))
        await sleep(250)                       // B enters while A is still in flight
        const pb = provider.chat([{ role: 'user', content: 'B' }])
        const [ra, rb] = await Promise.all([pa, pb.catch(e => ({ err: e }))])

        assert(ra?.err && /timed out after 600ms/.test(ra.err.message),
            'request A times out at its own deadline')
        assert(rb && !rb.err && rb.content === 'fast',
            `request B completes within its OWN budget despite A's stale deadline (got ${JSON.stringify(rb)})`)
        assert(hits.length === 2, `both requests hit the server exactly once (${hits.length} total)`)
    }

    // -----------------------------------------------------------------------
    // D. fast success path -- parsing and request shape intact
    // -----------------------------------------------------------------------
    console.log('── D. fast success path ──')
    let capturedBody = null
    dispatch = async (_req, res, body) => { capturedBody = body; okResponse(res, 'hello') }
    {
        hits.length = 0
        const provider = new OpenAiProvider({
            apiUrl: base, model: 'test-model', maxTokens: -1, temperature: 0.2, fetchTimeoutMs: 500
        })
        provider.init()

        const reply = await provider.chat([{ role: 'user', content: 'ping' }])
        assert(reply.role === 'assistant' && reply.content === 'hello', 'response parsed to assistant message')
        assert(capturedBody?.model === 'test-model' && Array.isArray(capturedBody?.messages),
            'request body carries model + messages')
        assert(capturedBody?.max_tokens === undefined, 'max_tokens -1 omitted from request (unlimited)')
        assert(hits.length === 1, 'single clean round-trip, no retries')
    }
} finally {
    server.close()
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(50)}\n  Results: ${passed}/${passed + failed} passed` + (failed ? `, ${failed} FAILED` : '') + `\n${'═'.repeat(50)}\n`)
process.exit(failed > 0 ? 1 : 0)