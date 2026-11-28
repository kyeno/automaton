/**
 * Test MPC-HC end-frame shutdown using a fake clock, player, sequence and AI.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { setImmediate } from 'node:timers/promises'

import AiAssistant from '../src/ai/aiAssistant.js'
import MpcProvider from '../src/monitor/providers/mpc.js'
import NetworkPresence from '../src/monitor/networkPresence.js'
import Monitor from '../src/monitor/videoPlayerMonitor.js'
import SequenceContainer from '../src/sequence/container/sequenceContainer.js'
import EventBus from '../src/service/eventBus.js'
import I18nLoader from '../src/service/i18nLoader.js'
import LoggerService from '../src/service/loggerService.js'
import TtsService from '../src/service/ttsService.js'

const proto = Object.getPrototypeOf
const end = 7_483_921
const windowMs = 900_000
const pollMs = 4_000
const response = ({ state = 'Paused', position = end, duration = end, file = 'movie.mkv' } = {}) =>
    `<p id="version">1.9.16.63</p><p id="statestring">${state}</p><p id="file">${file}</p>` +
    `<p id="filepath">${file ? `movies/${file}` : ''}</p><p id="position">${position}</p><p id="duration">${duration}</p>`

const provider = new MpcProvider()
for (const state of ['Paused', 'Stopped']) {
    assert.deepEqual(provider.extractIdleTimeline(response({ state })), { media: 'movies/movie.mkv', atEnd: true })
}
assert.deepEqual(provider.extractIdleTimeline(response({ position: end - 1 })), { media: 'movies/movie.mkv', atEnd: false })
for (const bad of [{ state: 'Playing' }, { state: 'Opening' }, { duration: 0, position: 0 }, { position: '' }, { position: end + 1 }, { file: '' }]) {
    assert.equal(provider.extractIdleTimeline(response(bad)), null)
}

let now = 0
let body = response()
let result = 'completed'
let runAccepted = true
let locale = 'en_US'
let aiReply = ''
const runs = []
const requests = []
const spoken = []

for (const level of ['info', 'debug', 'warn']) mock.method(proto(LoggerService), level, () => {})
mock.method(MpcProvider.prototype, 'fetch', async () => {
    if (body === null) throw new Error('read timed out')
    return body
})
mock.method(proto(NetworkPresence), 'getPresence', async () => 'online')
mock.method(proto(SequenceContainer), 'resolveSequence', (name) => ({
    async run(phase) { runs.push([name, phase]); return runAccepted },
    getLastRunResult: () => ({ status: result })
}))
mock.method(proto(I18nLoader), 'getLocale', () => locale)
mock.method(proto(TtsService), 'getProfile', (name) => {
    assert.equal(name, 'couch_sleepover')
    return { intro: 'profile.wav', outro: 'outro.wav' }
})
mock.method(proto(AiAssistant), 'isAvailable', () => true)
mock.method(proto(AiAssistant), 'processMessage', async (instruction, options) => {
    requests.push({ instruction, options })
    if (aiReply) EventBus.emit('tts:speak', { text: aiReply, ...options.tts })
    return aiReply
})
const unsubscribe = EventBus.subscribe('tts:speak', (payload) => spoken.push(payload))

const endpoint = { host: '192.0.2.10', port: 13579, path: '/variables.html', parser: 'mpc' }
const enabled = { ...endpoint, end_frame_shutdown: {
    sequence: 'home_cinema', tts_profile: 'couch_sleepover', tts_options: { intro: 'override.wav' }
} }

async function start(entry) {
    Monitor.stop()
    now = 0
    body = response()
    await Monitor.init({ videoPlayers: { test: entry } })
    await setImmediate()
}

async function poll(page, delta = pollMs) {
    now += delta
    body = page
    await Monitor.checkNow()
    await setImmediate()
}

async function dwell(ms, page = response()) {
    for (let remaining = ms; remaining > 0; remaining -= pollMs) {
        await poll(page, Math.min(remaining, pollMs))
    }
}

try {
    Monitor._setClock(() => now)
    await start(endpoint)
    await dwell(windowMs + pollMs)
    assert.deepEqual(runs, [], 'no shutdown without opt-in')

    await start(enabled)
    await dwell(windowMs - 1)
    assert.equal(runs.length, 0)
    await poll(response({ state: 'Stopped' }), 1)
    assert.deepEqual(runs, [['home_cinema', 'OFF']])
    assert.match(requests[0].instruction, /I turned off the home cinema/)
    assert.equal(requests[0].options.allowTools, false)
    assert.deepEqual(requests[0].options.tts, { intro: 'override.wav', outro: 'outro.wav' })
    assert.deepEqual(spoken[0], {
        text: 'I turned off the home cinema because someone might have fallen asleep on the couch.',
        intro: 'override.wav', outro: 'outro.wav'
    })
    await poll(null)
    await dwell(windowMs + pollMs)
    assert.equal(runs.length, 1, 'a lost reply does not re-arm a power toggle')

    result = 'partial_failure'
    locale = 'pl_PL'
    await poll(response({ state: 'Playing' }))
    await poll(response())
    for (const interrupt of [null, response({ position: 0 }), response({ file: 'new.mkv' }), response({ state: 'Playing' })]) {
        await dwell(windowMs - pollMs)
        await poll(interrupt)
        assert.equal(runs.length, 1, 'no shutdown at a broken dwell boundary')
        await poll(response())
    }
    await dwell(windowMs - pollMs)
    await poll(response(), 20_000)
    assert.equal(runs.length, 1, 'a long observation gap resets the timer')
    await dwell(windowMs)
    assert.equal(runs.length, 2)
    assert.match(requests[1].instruction, /nie udało się potwierdzić/)
    assert.match(spoken[1].text, /nie udało się potwierdzić/)

    await poll(response({ file: 'another.mkv' }))
    aiReply = 'Wyłączyłem kino domowe.'
    result = 'completed'
    await dwell(windowMs, response({ file: 'another.mkv' }))
    assert.equal(runs.length, 3)
    assert.match(requests[2].instruction, /Wyłączyłem kino domowe/)
    assert.deepEqual(spoken[2], { text: aiReply, intro: 'override.wav', outro: 'outro.wav' })

    await poll(response({ file: 'next.mkv' }))
    await dwell(windowMs - pollMs, response({ file: 'next.mkv' }))
    await start(enabled)
    await poll(response({ file: 'next.mkv' }))
    assert.equal(runs.length, 3, 'restart discards the old dwell')
    runAccepted = false
    await dwell(windowMs, response({ file: 'next.mkv' }))
    assert.equal(runs.length, 4)
    assert.equal(spoken.length, 3, 'no announcement for a sequence that never ran')
} finally {
    Monitor.stop()
    Monitor._setClock(null)
    unsubscribe()
    mock.restoreAll()
}