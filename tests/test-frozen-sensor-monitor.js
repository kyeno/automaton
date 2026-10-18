/**
 * Frozen sensor monitor integration tests: real SQLite and announcement pipeline,
 * simulated device events/clock/AI/email. No live services or hardware required.
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
import DatabaseService from '../src/service/databaseService.js'
import StateService from '../src/service/stateService.js'
import EventBus from '../src/service/eventBus.js'
import LoggerService from '../src/service/loggerService.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import TtsService from '../src/service/ttsService.js'
import EmailService from '../src/service/emailService.js'
import FrozenSensorMonitor, { FROZEN_SENSOR_STATE_KEY } from '../src/monitor/frozenSensorMonitor.js'

const HOUR = 3_600_000
const MINUTE = 60_000
const RealDate = Date
let now = new RealDate(2026, 9, 19, 12).getTime()
class Clock extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
}
global.Date = Clock
const originalSetInterval = global.setInterval
const originalClearInterval = global.clearInterval
const timers = []
global.setInterval = (callback, ms) => {
    const timer = { callback, ms, cleared: false, unref() {} }
    timers.push(timer)
    return timer
}
global.clearInterval = (timer) => { timer.cleared = true }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-frozen-monitor-'))
const dbFile = path.join(dir, 'state.db')
const originals = []
function stub(singleton, method, replacement) {
    const proto = Object.getPrototypeOf(singleton)
    const original = proto[method]
    originals.push(() => { proto[method] = original })
    proto[method] = replacement
}
let settings = {
    enabled: true, unchanged_for: '24h', reminder_interval: '15m',
    silence_between: null, speak: true, use_ai: true,
    devices: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Plant ${i}`, { property: 'soil_moisture', unit: '%' }])),
}
const readings = new Map(Array.from({ length: 10 }, (_, i) => [`Plant ${i}`, 30 + i]))
const mail = []
const prompts = []
const speech = []
let ttsUp = true
let aiUp = true
let mailAccept = true
let mailThrow = false
let aiHandler = async () => 'Grouped AI warning'
for (const level of ['debug', 'info', 'warn', 'error', 'trace']) stub(LoggerService, level, () => {})
stub(ConfigService, 'get', (key, fallback) => key === 'alerts.frozen_sensors' ? settings : fallback)
stub(DeviceContainer, 'findByName', (name) => readings.has(name) ? { getStateLast: () => ({ soil_moisture: readings.get(name) }) } : null)
stub(AiAssistant, 'isAvailable', () => aiUp)
stub(AiAssistant, 'processMessage', async (text) => { prompts.push(text); return aiHandler() })
stub(TtsService, 'isEnabled', () => ttsUp)
stub(EmailService, 'notify', async (request) => { mail.push(request); if (mailThrow) throw new Error('SMTP request failed'); return mailAccept })
const unsub = EventBus.subscribe('tts:speak', (payload) => speech.push(payload.text))
const frozen = () => StateService.get(FROZEN_SENSOR_STATE_KEY) ?? []
const advance = async (ms) => { now += ms; await FrozenSensorMonitor.tick() }

try {
    await DatabaseService.init(dbFile)
    await FrozenSensorMonitor.init()
    await FrozenSensorMonitor.init()
    assert.equal(timers.length, 1, 'idempotent init installs only one independent timer')
    assert.equal(timers[0].ms, MINUTE)
    assert.equal(frozen().length, 0, 'first reading is only a baseline')
    assert.equal(mail.length, 0)
    await advance(24 * HOUR - MINUTE)
    assert.equal(frozen().length, 0, 'not detected before a full unchanged interval')
    await advance(MINUTE)
    assert.equal(frozen().length, 10)
    assert.equal(mail.length, 1, 'ten simultaneous freezes produce ONE mail')
    assert.equal(mail[0].kind, 'sensor_frozen')
    for (const name of readings.keys()) assert.ok(mail[0].message.includes(name), `grouped email names ${name}`)
    assert.equal(prompts.length, 1, 'ten freezes produce one grouped AI announcement')
    assert.equal(speech.length, 0, 'AI routing does not also speak plain TTS')
    assert.ok(prompts[0].includes('Plant 0') && prompts[0].includes('Plant 9'))
    await advance(14 * MINUTE)
    assert.equal(prompts.length, 1)
    now += MINUTE
    timers[0].callback()
    await FrozenSensorMonitor.tick()
    assert.equal(prompts.length, 2, 'independent timer voices the 15-minute reminder without a gardener slot')
    assert.equal(mail.length, 1, 'reminders never mail')
    assert.ok(frozen().every((probe) => probe.emailPending === false), 'runtime list reflects accepted initial mail')

    // Reopen real SQLite to prove both frozen state and the reminder marker survive restart.
    await FrozenSensorMonitor.stop()
    await DatabaseService.close()
    now += MINUTE
    await DatabaseService.init(dbFile)
    await FrozenSensorMonitor.init()
    assert.equal(frozen().length, 10)
    assert.equal(mail.length, 1, 'restart never re-mails an accepted detection')
    assert.equal(prompts.length, 2, 'restart preserves speech cooldown')

    readings.set('Plant 0', 41)
    EventBus.publish('zigbee:Plant 0')
    assert.equal(frozen().length, 9, 'different numeric reading clears frozen state synchronously')
    readings.set('Plant 1', null)
    await advance(15 * MINUTE)
    assert.equal(frozen().length, 9, 'missing value does not falsely recover a sensor')
    assert.ok(!prompts.at(-1).includes('Plant 0') && !prompts.at(-1).includes('Plant 1'), 'reminder omits recovered and unreadable probes')
    readings.set('Plant 1', 31)

    settings.silence_between = '0000-2359'
    const beforeQuiet = prompts.length
    await advance(24 * HOUR)
    assert.equal(mail.length, 2, 'a later freeze of the recovered probe starts a new mailed incident')
    assert.ok(mail.at(-1).message.includes('Plant 0'))
    assert.equal(prompts.length, beforeQuiet, 'monitor quiet hours mute only speech')
    readings.set('Plant 0', 42)
    EventBus.publish('zigbee:Plant 0')
    assert.equal(frozen().length, 9, 'recovery still runs during quiet hours')
    settings.silence_between = null
    await FrozenSensorMonitor.tick()
    assert.equal(prompts.length, beforeQuiet + 1, 'overdue reminder resumes after quiet hours')
    assert.equal(mail.length, 2, 'next-day sweeps of ongoing incidents do not re-mail')

    // A reading that changes and returns is not continuously frozen.
    readings.set('Plant 0', 43)
    EventBus.publish('zigbee:Plant 0')
    now += HOUR
    readings.set('Plant 0', 42)
    EventBus.publish('zigbee:Plant 0')
    await advance(23 * HOUR)
    assert.ok(!frozen().some((probe) => probe.name === 'Plant 0'))
    assert.equal(mail.length, 2, 'equal endpoints do not hide intervening reading changes')

    // A slow AI request cannot duplicate reminders, and does not block recovery events.
    await advance(MINUTE)
    let release
    let entered
    const started = new Promise((resolve) => { entered = resolve })
    aiHandler = () => { entered(); return new Promise((resolve) => { release = resolve }) }
    now += 15 * MINUTE
    const first = FrozenSensorMonitor.tick()
    await started
    const count = prompts.length
    const second = FrozenSensorMonitor.tick()
    readings.set('Plant 2', 70)
    EventBus.publish('zigbee:Plant 2')
    assert.ok(!frozen().some((probe) => probe.name === 'Plant 2'), 'event recovery proceeds while AI is in flight')
    release('Completed warning')
    await Promise.all([first, second])
    assert.equal(prompts.length, count, 'overlapping sweeps share the same AI request')
    aiHandler = async () => 'Grouped AI warning'

    aiUp = false
    await advance(15 * MINUTE)
    assert.equal(speech.length, 1, 'AI outage uses plain TTS fallback')
    ttsUp = false
    const beforeOutage = prompts.length + speech.length
    await advance(15 * MINUTE)
    assert.equal(prompts.length + speech.length, beforeOutage, 'no output channel means no consumed reminder')
    ttsUp = true
    await FrozenSensorMonitor.tick()
    assert.equal(speech.length, 2, 'reminder retries immediately once an output channel returns')

    // Removed devices and changed properties cannot leave stale incidents behind.
    delete settings.devices['Plant 3']
    await FrozenSensorMonitor.tick()
    assert.ok(!frozen().some((probe) => probe.name === 'Plant 3'))
    settings.devices['Plant 4'].property = 'other_property'
    await FrozenSensorMonitor.tick()
    assert.ok(!frozen().some((probe) => probe.name === 'Plant 4'))

    // Failed mail stays pending across restart and batches into a single retry.
    settings = { ...settings, devices: { Retry: { property: 'soil_moisture', unit: '%' } }, speak: false }
    readings.set('Retry', 40)
    await FrozenSensorMonitor.tick()
    mailAccept = false
    await advance(24 * HOUR)
    const failedMailCount = mail.length
    assert.equal(frozen()[0].name, 'Retry')
    await FrozenSensorMonitor.stop()
    await DatabaseService.close()
    await DatabaseService.init(dbFile)
    mailAccept = true
    await FrozenSensorMonitor.init()
    assert.equal(mail.length, failedMailCount + 1, 'pending initial mail retries after restart')
    await advance(HOUR)
    assert.equal(mail.length, failedMailCount + 1, 'accepted retry is not repeated')

    // A mail exception must not prevent the independent spoken reminder.
    aiUp = true
    settings.speak = true
    readings.set('Retry', 41)
    EventBus.publish('zigbee:Retry')
    mailThrow = true
    const promptsBeforeMailFailure = prompts.length
    await advance(24 * HOUR)
    assert.equal(prompts.length, promptsBeforeMailFailure + 1, 'mail failure does not block grouped speech')
    assert.equal(frozen()[0].emailPending, true)
    mailThrow = false
    await advance(MINUTE)
    assert.equal(frozen()[0].emailPending, false, 'failed mail remains pending until accepted')

    // Database failure retains in-memory incidents and flushes them when storage returns.
    await DatabaseService.close()
    readings.set('Retry', 42)
    EventBus.publish('zigbee:Retry')
    assert.equal(frozen().length, 0)
    await DatabaseService.init(dbFile)
    await FrozenSensorMonitor.tick()
    const durable = await DatabaseService.getRuntimeState(FROZEN_SENSOR_STATE_KEY)
    assert.equal(durable.probes[0].value, 42)
    assert.equal(durable.probes[0].detectedAt, null)

    await FrozenSensorMonitor.stop()
    readings.set('Retry', 42)
    EventBus.publish('zigbee:Retry')
    assert.equal(StateService.get(FROZEN_SENSOR_STATE_KEY), undefined, 'stop removes runtime state and event subscriptions')
    assert.ok(timers.every((timer) => timer.cleared), 'stop clears every installed sweep timer')
    console.log('Frozen sensor monitor: batching, reminders, recovery, persistence, quiet hours and failures passed')
} finally {
    await FrozenSensorMonitor.stop()
    await DatabaseService.close()
    unsub()
    for (const restore of originals.reverse()) restore()
    global.setInterval = originalSetInterval
    global.clearInterval = originalClearInterval
    global.Date = RealDate
    fs.rmSync(dir, { recursive: true, force: true })
}
