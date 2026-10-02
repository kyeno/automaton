import { config } from 'dotenv'
config()

'use strict'

/**
 * Focused tests for DeviceOfflineMonitor -- spoken warning when a Zigbee device leaves.
 *
 * Drives the real EventBus + ConfigService (with patched get() for dynamic overrides)
 * and stubbed TtsService/I18nLoader prototypes, then pins down:
 *   A) devices:removed -> tts:speak with the localized sentence ({device} interpolated)
 *   B) per-device cooldown suppresses rapid re-warnings; distinct devices are independent
 *   C) alerts.device_offline_tts=false silences everything
 *   D) ignore list entries are never announced
 *   E) unavailable TTS -> nothing is spoken and no cooldown slot is consumed
 *   F) cooldown of 0 disables cooling down entirely
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import EventBus from '../src/service/eventBus.js'
import I18nLoader from '../src/service/i18nLoader.js'
import TtsService from '../src/service/ttsService.js'
import DeviceOfflineMonitor from '../src/monitor/deviceOfflineMonitor.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

let passCount = 0
let failCount = 0

function assert(condition, message) {
    if (condition) {
        passCount++
        console.log(`  PASS ${message}`)
    } else {
        failCount++
        console.error(`  FAIL ${message}`)
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// -- Prototype stubs for frozen singletons ------------------------------------

// TtsService.isEnabled gate
const ttsProto = Object.getPrototypeOf(TtsService)
const originalTtsEnabled = ttsProto.isEnabled
let ttsEnabledFlag = true
ttsProto.isEnabled = function () { return ttsEnabledFlag }

// I18nLoader locale pinning (so the monitor reads pl_PL/alerts.yaml)
const i18nProto = Object.getPrototypeOf(I18nLoader)
const originalGetLocale = i18nProto.getLocale
i18nProto.getLocale = function () { return 'pl_PL' }

// ConfigService dynamic overrides: patch get() to consult an override map first.
const configProto = Object.getPrototypeOf(ConfigService)
const originalConfigGet = configProto.get
const configOverrides = {}
configProto.get = function (key, defaultVal) {
    if (Object.prototype.hasOwnProperty.call(configOverrides, key)) {
        return configOverrides[key]
    }
    return originalConfigGet.call(this, key, defaultVal)
}
function setOverride(key, value) { configOverrides[key] = value }
function clearOverride(key) { delete configOverrides[key] }

async function main() {
    console.log('=== DeviceOfflineMonitor Tests ===\n')

    const spoken = []
    const unsubSpeak = EventBus.subscribe('tts:speak', ({ text }) => spoken.push(text))

    await DeviceOfflineMonitor.init()

    try {
        // A) removal -> localized sentence -------------------------------------------
        console.log('-- A) devices:removed speaks a localized warning --')
        setOverride('alerts.device_offline_tts', true)
        clearOverride('alerts.device_offline_ignore')
        setOverride('alerts.device_offline_cooldown_ms', 0)
        await sleep(20)
        EventBus.emit('devices:removed', 'Balkon Swiatlo')
        await sleep(50)
        assert(spoken.length === 1, `one utterance (got ${spoken.length})`)
        assert(typeof spoken[0] === 'string' && spoken[0].includes('Balkon Swiatlo'), `sentence names the device: "${spoken[0]}"`)
        assert(!spoken[0]?.includes('{device}'), 'placeholder fully interpolated')

        // B) cooldown suppresses rapid re-warnings; distinct devices independent --------
        console.log('-- B) per-device cooldown + independence --')
        spoken.length = 0
        setOverride('alerts.device_offline_cooldown_ms', '30m')
        EventBus.emit('devices:removed', 'Kuchnia Gniazdo')
        await sleep(50)
        EventBus.emit('devices:removed', 'Kuchnia Gniazdo')   // same device again -> suppressed
        await sleep(50)
        EventBus.emit('devices:removed', 'Lazienka Wlacznik')  // different device -> speaks
        await sleep(50)
        assert(spoken.length === 2, `cooldown suppressed repeat but not other device (got ${spoken.length}: ${JSON.stringify(spoken)})`)
        assert(spoken.every((t) => t.includes('Gniazdo') || t.includes('Wlacznik')), 'only the two expected devices were announced')

        // C) master switch off -----------------------------------------------------------
        console.log('-- C) alerts.device_offline_tts=false silences everything --')
        spoken.length = 0
        setOverride('alerts.device_offline_tts', false)
        EventBus.emit('devices:removed', 'Sypialnia Gniazdo')
        await sleep(50)
        assert(spoken.length === 0, 'disabled flag produces no speech')
        setOverride('alerts.device_offline_tts', true)

        // D) ignore list -------------------------------------------------------------------
        console.log('-- D) ignored devices are never announced --')
        spoken.length = 0
        setOverride('alerts.device_offline_cooldown_ms', 0)
        setOverride('alerts.device_offline_ignore', ['Przedpokoj Wlacznik'])
        EventBus.emit('devices:removed', 'Przedpokoj Wlacznik')
        await sleep(50)
        EventBus.emit('devices:removed', 'Salon Roleta Okno Lewe')
        await sleep(50)
        assert(spoken.length === 1 && spoken[0].includes('Roleta'), `ignored device silent, others speak (got ${JSON.stringify(spoken)})`)
        clearOverride('alerts.device_offline_ignore')

        // E) TTS unavailable -> nothing spoken, cooldown slot NOT consumed ------------------
        console.log('-- E) unavailable TTS speaks nothing and keeps the door open --')
        spoken.length = 0
        ttsEnabledFlag = false
        EventBus.emit('devices:removed', 'Balkon Temperatura')
        await sleep(50)
        assert(spoken.length === 0, 'no speech when TTS is down')
        ttsEnabledFlag = true
        // Same device again immediately: because no slot was consumed it must now speak.
        EventBus.emit('devices:removed', 'Balkon Temperatura')
        await sleep(50)
        assert(spoken.length === 1, 'device warned once TTS recovered (cooldown not burned by failed attempt)')

        // F) cooldown 0 disables cooling -----------------------------------------------------
        console.log('-- F) cooldown of 0 re-warns on every leave event --')
        spoken.length = 0
        setOverride('alerts.device_offline_cooldown_ms', 0)
        EventBus.emit('devices:removed', 'Kuchnia Wlacznik Zlew')
        await sleep(30)
        EventBus.emit('devices:removed', 'Kuchnia Wlacznik Zlew')
        await sleep(50)
        assert(spoken.length === 2, `zero cooldown speaks twice for the same device (got ${spoken.length})`)
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exitCode = 1
    } finally {
        unsubSpeak()
        DeviceOfflineMonitor.stop()
        ttsProto.isEnabled = originalTtsEnabled
        i18nProto.getLocale = originalGetLocale
        configProto.get = originalConfigGet
    }

    console.log(`\nResults: ${passCount} passed, ${failCount} failed`)
    process.exit(failCount > 0 ? 1 : 0)
}

main()
