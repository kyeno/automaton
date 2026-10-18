/**
 * Numeric history: real report ingestion, weighted SQL, freshness, retention and WeatherMan facts.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ConfigService from '../src/service/configService.js'
import CacheService from '../src/service/cacheService.js'
import DatabaseService from '../src/service/databaseService.js'
import SensorHistoryService from '../src/service/sensorHistoryService.js'
import LoggerService from '../src/service/loggerService.js'
import I18nLoader from '../src/service/i18nLoader.js'
import Sensor from '../src/device/type/sensor.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import TtsService from '../src/service/ttsService.js'
import { parse as yamlParse } from 'yaml'
import EventBus from '../src/service/eventBus.js'
import WeatherMan from '../etc/automation/ttsWeatherManAutomation.js'
import { durationWords, countedUnit } from '../src/lib/polish.js'

await ConfigService.init(['locale.language: pl_PL'])
LoggerService.init()
await I18nLoader.init()
const originals = []
function stub(instance, method, fn) {
    const proto = Object.getPrototypeOf(instance)
    const original = proto[method]
    originals.push(() => { proto[method] = original })
    proto[method] = fn
}
for (const level of ['debug', 'info', 'warn', 'trace']) stub(LoggerService, level, () => {})
stub(CacheService, 'set', async () => true)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-numeric-history-'))
const dbFile = path.join(dir, 'samples.db')
const originalNow = Date.now
let now = originalNow()
Date.now = () => now
const HOUR = 3_600_000
const start = now - 3 * HOUR
const sensor = new Sensor('Weather Test', 'test-weather', {})
const report = (timestamp, state) => {
    now = timestamp
    sensor.handleMqttMessage({ topic: 'zigbee2mqtt/Weather Test', message: JSON.stringify(state) })
}
const stats = (from, to, property = 'temperature', maxGap = 2 * HOUR) => DatabaseService.sensorWindowStats({ device: 'Weather Test', property, from, to, maxGap })
const wm = new WeatherMan()
try {
    await DatabaseService.init(dbFile)
    await SensorHistoryService.init()
    await SensorHistoryService.init()
    await sensor.setCachedState({ temperature: 90 })
    assert.equal(stats(start, start + HOUR).samples, 0, 'restoring cached state is not a fresh measurement')
    report(start, { temperature: 10, humidity: 50, pressure: 1000, battery: 100 })
    report(start + 50 * 60_000, { temperature: 20 })
    let result = stats(start, start + HOUR)
    assert.ok(Math.abs(result.mean - 11.6666666667) < 1e-6, 'time weighting reflects fifty minutes at 10 and ten at 20')
    assert.equal(result.coverageMs, HOUR)
    assert.equal(stats(start, start + HOUR, 'battery').mean, null, 'unrequested numeric fields are not collected')
    assert.equal(stats(start, start + HOUR, 'humidity').samples, 1, 'partial reports never manufacture another humidity sample')
    for (let i = 51; i < 60; i++) report(start + i * 60_000, { temperature: 20 })
    assert.ok(Math.abs(stats(start, start + HOUR).mean - result.mean) < 1e-6, 'bursty equal readings do not bias the mean')
    assert.equal(stats(start, start + HOUR, 'temperature', 10 * 60_000).coverageMs, 20 * 60_000, 'stale intervals are capped rather than filled indefinitely')
    report(start + 60 * 60_000, { temperature: null, humidity: 'wrong', pressure: true })
    assert.equal(stats(start, start + HOUR).max, 20, 'invalid values do not enter numeric history')

    // Adjacent complete windows: rising temperature, stable humidity and falling pressure.
    const end = start + 3 * HOUR
    for (let i = 0; i <= 12; i++) {
        report(start + HOUR + i * 10 * 60_000, { temperature: i < 6 ? 20 : 22, humidity: i < 6 ? 50 : 50.5, pressure: i < 6 ? 1000 : 999 })
    }
    await wm.init()
    wm.config = { ...wm.config, sensors: { temperature: 'Weather Test', humidity: 'Weather Test', pressure: 'Weather Test' }, history: { window: '1h', max_gap: '30m', min_coverage: 0.8 } }
    const tokens = wm.buildHistoryTokens(end)
    assert.ok(tokens.temperature_history.includes('wyższa') && tokens.temperature_history.includes('2 stopnie'))
    assert.ok(tokens.humidity_history.includes('zbliżona') && tokens.humidity_history.includes('50,5 procenta'))
    assert.ok(tokens.pressure_history.includes('niższe') && tokens.pressure_history.includes('1 hektopaskal'))
    assert.ok(tokens.temperature_history.includes('jednej godziny'), 'history uses declined words for the time window')
    assert.ok(!Object.values(tokens).join('').includes('{%'), 'no unresolved trend placeholders reach the model')
    assert.ok(Object.values(wm.buildHistoryTokens(end + 2 * HOUR)).every((value) => !value), 'stale/sparse history quietly omits claims')
    wm.config.history.enabled = false
    assert.ok(Object.values(wm.buildHistoryTokens(end)).every((value) => !value))
    wm.config.history.enabled = true

    // The existing presenter prefix and segment assembly receive finished historical facts.
    let aiPrompt = ''
    stub(DeviceContainer, 'findByName', (name) => name === 'Weather Test' ? sensor : null)
    stub(AiAssistant, 'isAvailable', () => true)
    stub(TtsService, 'isEnabled', () => true)
    stub(AiAssistant, 'processMessage', async (text) => { aiPrompt = text; return 'Generated report' })
    wm.config = { ...wm.config, use_ai: true, silence_between: null, video_player_suppression: {} }
    await wm.execute({ trigger: 'test', force: true })
    const bundle = yamlParse(fs.readFileSync(path.resolve('etc/i18n/pl_PL/weatherman.yaml'), 'utf8'))
    assert.equal(aiPrompt.split('\n')[0], bundle.ai_prefix, 'the complete configured presenter prefix is preserved')
    assert.ok(aiPrompt.includes('jednej godziny') && aiPrompt.includes('wyższa'), 'computed history reaches the real AI prompt')
    assert.ok(aiPrompt.includes('za jedną godzinę'), 'next-update grammar is ready for the small model')
    assert.ok(!aiPrompt.includes('{%') && !aiPrompt.includes('{{'), 'all facts are interpolated before AI')
    const direct = []
    const unsub = EventBus.subscribe('tts:speak', (payload) => direct.push(payload.text))
    try {
        stub(AiAssistant, 'processMessage', async () => { throw new Error('model unavailable') })
        await wm.execute({ trigger: 'test', force: true })
        assert.equal(direct.length, 1, 'failed AI speaks one direct report')
        assert.ok(direct[0].includes('jednej godziny') && direct[0].includes('wyższa'), 'fallback retains historical facts')
        assert.ok(!direct[0].includes(bundle.ai_prefix), 'presenter instructions are never spoken by fallback')
    } finally { unsub() }

    await DatabaseService.close()
    await DatabaseService.init(dbFile)
    assert.equal(wm.buildHistoryTokens(end).temperature_history, tokens.temperature_history, 'history survives SQLite reopen')
    now = end + 8 * 24 * HOUR
    DatabaseService.pruneSensorSamples(7 * 24 * HOUR)
    assert.equal(stats(start, end).samples, 0, 'periodic retention bounds stored rows')
    SensorHistoryService.stop()
    report(now, { temperature: 40 })
    assert.equal(stats(now, now + HOUR).samples, 0, 'stop releases the measurement subscription')

    assert.equal(durationWords(HOUR, 'genitive'), 'jednej godziny')
    assert.equal(durationWords(2 * HOUR, 'genitive'), 'dwóch godzin')
    assert.equal(durationWords(5 * HOUR, 'genitive'), 'pięciu godzin')
    assert.equal(durationWords(HOUR, 'accusative'), 'jedną godzinę')
    assert.equal(durationWords(2 * HOUR, 'accusative'), 'dwie godziny')
    assert.equal(durationWords(22 * 60_000, 'genitive'), 'dwudziestu dwóch minut')
    assert.equal(durationWords(90 * 60_000, 'genitive'), 'jednej godziny trzydziestu minut')
    assert.equal(durationWords(12 * HOUR, 'accusative'), 'dwanaście godzin')
    assert.equal(durationWords(-1), null)
    assert.equal(countedUnit(1.2, ['stopień', 'stopnie', 'stopni', 'stopnia']), 'stopnia')
    console.log('Sensor history, weighted SQL, Polish speech and WeatherMan integration passed')
} finally {
    wm.cleanup()
    SensorHistoryService.stop()
    await DatabaseService.close()
    Date.now = originalNow
    for (const restore of originals.reverse()) restore()
    fs.rmSync(dir, { recursive: true, force: true })
}
