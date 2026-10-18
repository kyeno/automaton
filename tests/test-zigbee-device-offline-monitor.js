import { config } from 'dotenv'
config()

'use strict'

/**
 * Focused tests for ZigbeeDeviceOfflineMonitor -- spoken warning when a Zigbee device leaves.
 *
 * Drives the real EventBus + ConfigService (with patched get() for dynamic overrides)
 * and stubbed TtsService/I18nLoader prototypes, then pins down:
 *   A) devices:removed -> tts:speak with the localized sentence ({device} interpolated)
 *   B) per-device cooldown suppresses rapid re-warnings; distinct devices are independent
 *   C) alerts.zigbee_offline_tts=false silences everything
 *   D) ignore list entries are never announced
 *   E) unavailable TTS -> nothing is spoken and no cooldown slot is consumed
 *   F) cooldown of 0 disables cooling down entirely
 *   G) the pre-rename alerts.device_offline_* family keeps working, warning once
 *   H) sentence resolution -- plain template, per-device map, default entry, fallbacks
 *   I) tts_profile / tts_options framing reaches the tts:speak payload
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
import ZigbeeDeviceOfflineMonitor from '../src/monitor/zigbeeDeviceOfflineMonitor.js'

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

// LoggerService prototype -- sections G/I swap warn() to capture emitted warnings.
const loggerProto = Object.getPrototypeOf(LoggerService)

// AlertMonitorBase prototype -- section H swaps bundle() to feed a synthetic alerts bundle.
const baseProto = Object.getPrototypeOf(Object.getPrototypeOf(ZigbeeDeviceOfflineMonitor))

// TtsService profile registry stub (wave files are not part of the repo, so the
// locale profiles: registry is empty by default and nothing would resolve).
const profileRegistry = {
    alarm: { intro: 'alarm-intro.wav', outro: 'alarm-outro.wav', intro_spacing: -1.5 }
}
const ttsProtoForProfiles = ttsProto
const originalGetProfile = ttsProtoForProfiles.getProfile
ttsProtoForProfiles.getProfile = function (name) {
    return profileRegistry[String(name ?? '').trim().toLowerCase()] ?? null
}

async function main() {
    console.log('=== ZigbeeDeviceOfflineMonitor Tests ===\n')

    const spoken = []
    const payloads = []
    const unsubSpeak = EventBus.subscribe('tts:speak', (payload) => {
        payloads.push(payload)
        spoken.push(payload.text)
    })

    await ZigbeeDeviceOfflineMonitor.init()

    try {
        // A) removal -> localized sentence -------------------------------------------
        console.log('-- A) devices:removed speaks a localized warning --')
        setOverride('alerts.zigbee_offline_tts', true)
        clearOverride('alerts.zigbee_offline_ignore')
        setOverride('alerts.zigbee_offline_cooldown_ms', 0)
        await sleep(20)
        EventBus.emit('devices:removed', 'Balkon Swiatlo')
        await sleep(50)
        assert(spoken.length === 1, `one utterance (got ${spoken.length})`)
        assert(typeof spoken[0] === 'string' && spoken[0].includes('Balkon Swiatlo'), `sentence names the device: "${spoken[0]}"`)
        assert(!spoken[0]?.includes('{device}'), 'placeholder fully interpolated')

        // B) cooldown suppresses rapid re-warnings; distinct devices independent --------
        console.log('-- B) per-device cooldown + independence --')
        spoken.length = 0
        setOverride('alerts.zigbee_offline_cooldown_ms', '30m')
        EventBus.emit('devices:removed', 'Kitchen Outlet')
        await sleep(50)
        EventBus.emit('devices:removed', 'Kitchen Outlet')   // same device again -> suppressed
        await sleep(50)
        EventBus.emit('devices:removed', 'Lazienka Wlacznik')  // different device -> speaks
        await sleep(50)
        assert(spoken.length === 2, `cooldown suppressed repeat but not other device (got ${spoken.length}: ${JSON.stringify(spoken)})`)
        assert(spoken.every((t) => t.includes('Kitchen Outlet') || t.includes('Lazienka Wlacznik')), 'only the two expected devices were announced')

        // C) master switch off -----------------------------------------------------------
        console.log('-- C) alerts.zigbee_offline_tts=false silences everything --')
        spoken.length = 0
        setOverride('alerts.zigbee_offline_tts', false)
        EventBus.emit('devices:removed', 'Bedroom Outlet')
        await sleep(50)
        assert(spoken.length === 0, 'disabled flag produces no speech')
        setOverride('alerts.zigbee_offline_tts', true)

        // D) ignore list -------------------------------------------------------------------
        console.log('-- D) ignored devices are never announced --')
        spoken.length = 0
        setOverride('alerts.zigbee_offline_cooldown_ms', 0)
        setOverride('alerts.zigbee_offline_ignore', ['Przedpokoj Wlacznik'])
        EventBus.emit('devices:removed', 'Przedpokoj Wlacznik')
        await sleep(50)
        EventBus.emit('devices:removed', 'Salon Roleta Okno Lewe')
        await sleep(50)
        assert(spoken.length === 1 && spoken[0].includes('Roleta'), `ignored device silent, others speak (got ${JSON.stringify(spoken)})`)
        clearOverride('alerts.zigbee_offline_ignore')

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
        setOverride('alerts.zigbee_offline_cooldown_ms', 0)
        EventBus.emit('devices:removed', 'Kitchen Sink Switch')
        await sleep(30)
        EventBus.emit('devices:removed', 'Kitchen Sink Switch')
        await sleep(50)
        assert(spoken.length === 2, `zero cooldown speaks twice for the same device (got ${spoken.length})`)

        // G) pre-rename key family keeps working, warned once ---------------------------
        console.log('-- G) legacy alerts.device_offline_* family honoured with a one-time warning --')
        spoken.length = 0
        const warnings = []
        const originalWarn = loggerProto.warn
        loggerProto.warn = function (message, tag) {
            warnings.push(message)
            return originalWarn.call(this, message, tag)
        }
        // Hide the new family so the base must fall through to the legacy keys.
        setOverride('alerts.zigbee_offline_tts', null)
        setOverride('alerts.zigbee_offline_cooldown_ms', null)
        setOverride('alerts.device_offline_tts', false)
        EventBus.emit('devices:removed', 'Kitchen Motion Sensor')
        await sleep(50)
        assert(spoken.length === 0, 'legacy master switch off silences the monitor')
        setOverride('alerts.device_offline_tts', true)
        setOverride('alerts.device_offline_cooldown_ms', 0)
        EventBus.emit('devices:removed', 'Kitchen Motion Sensor')
        await sleep(50)
        EventBus.emit('devices:removed', 'Salon Czujnik Ruchu')
        await sleep(50)
        assert(spoken.length === 2, `legacy family speaks when enabled (got ${spoken.length})`)
        const deprecationNotices = warnings.filter((m) => m.includes('Deprecated config key'))
        assert(deprecationNotices.length === 1, `deprecation warned exactly once (got ${deprecationNotices.length})`)
        assert(deprecationNotices[0]?.includes('alerts.device_offline_') && deprecationNotices[0].includes('alerts.zigbee_offline_'),
            `deprecation notice names both families: "${deprecationNotices[0]}"`)
        loggerProto.warn = originalWarn
        clearOverride('alerts.device_offline_tts')
        clearOverride('alerts.device_offline_cooldown_ms')
        clearOverride('alerts.zigbee_offline_tts')
        clearOverride('alerts.zigbee_offline_cooldown_ms')

        // H) alerts bundle shapes -------------------------------------------------------
        console.log('-- H) sentence resolution (plain template, per-device map, default, fallbacks) --')
        const syntheticBundle = {
            plain_key: 'Plain: {device} left.',
            map_key: { default: 'Default for {device}', 'Alpha Sensor': 'Named alpha {device}' }
        }
        const originalBundle = baseProto.bundle
        baseProto.bundle = function () { return syntheticBundle }
        assert(ZigbeeDeviceOfflineMonitor.sentence('plain_key', 'Anything') === 'Plain: Anything left.',
            'plain string template interpolates {device}')
        assert(ZigbeeDeviceOfflineMonitor.sentence('map_key', 'alpha sensor') === 'Named alpha alpha sensor',
            `per-device map matches case-insensitively (got "${ZigbeeDeviceOfflineMonitor.sentence('map_key', 'alpha sensor')}")`)
        assert(ZigbeeDeviceOfflineMonitor.sentence('map_key', 'Other') === 'Default for Other',
            'per-device map falls back to the default entry')
        assert(ZigbeeDeviceOfflineMonitor.sentence('missing_key', 'Zed', 'Built-in {device}') === 'Built-in Zed',
            'missing key uses the caller-supplied fallback')
        assert(ZigbeeDeviceOfflineMonitor.sentence('missing_key', 'Zed') === 'Zed',
            'missing key and fallback degrade to naming the device')
        baseProto.bundle = originalBundle

        // I) framing reaches the payload ------------------------------------------------
        console.log('-- I) tts_profile / tts_options framing reaches the tts:speak payload --')
        spoken.length = 0
        payloads.length = 0
        setOverride('alerts.zigbee_offline_cooldown_ms', 0)
        setOverride('alerts.zigbee_offline_tts_profile', 'alarm')
        EventBus.emit('devices:removed', 'Bedroom Sensor')
        await sleep(50)
        const framed = payloads[0] ?? {}
        assert(framed.intro === 'alarm-intro.wav' && framed.outro === 'alarm-outro.wav' && framed.intro_spacing === -1.5,
            `profile framing spread into the payload (${JSON.stringify(framed)})`)

        setOverride('alerts.zigbee_offline_tts_options', { intro: 'custom.wav', intro_spacing: 0 })
        EventBus.emit('devices:removed', 'Bedroom Sensor')
        await sleep(50)
        const mixed = payloads[1] ?? {}
        assert(mixed.intro === 'custom.wav' && mixed.outro === 'alarm-outro.wav' && mixed.intro_spacing === 0,
            `explicit tts_options wins key by key (${JSON.stringify(mixed)})`)

        setOverride('alerts.zigbee_offline_tts_options', null)
        setOverride('alerts.zigbee_offline_tts_profile', 'no-such-profile')
        const profileWarnings = []
        loggerProto.warn = function (message, tag) {
            profileWarnings.push(message)
            return originalWarn.call(this, message, tag)
        }
        EventBus.emit('devices:removed', 'Przedpokoj Czujnik')
        await sleep(50)
        EventBus.emit('devices:removed', 'Przedpokoj Czujnik')
        await sleep(50)
        loggerProto.warn = originalWarn
        const plainPayloads = payloads.slice(-2)
        assert(plainPayloads.length === 2 && plainPayloads.every((p) => Object.keys(p).length === 1),
            `unknown profile keeps the payload plain { text } (${JSON.stringify(plainPayloads)})`)
        assert(profileWarnings.filter((m) => m.includes('no-such-profile')).length === 1,
            `missing profile warns once, not per utterance (got ${profileWarnings.filter((m) => m.includes('no-such-profile')).length})`)
        clearOverride('alerts.zigbee_offline_tts_profile')
        clearOverride('alerts.zigbee_offline_tts_options')
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exitCode = 1
    } finally {
        unsubSpeak()
        ZigbeeDeviceOfflineMonitor.stop()
        ttsProto.isEnabled = originalTtsEnabled
        ttsProto.getProfile = originalGetProfile
        i18nProto.getLocale = originalGetLocale
        configProto.get = originalConfigGet
    }

    console.log(`\nResults: ${passCount} passed, ${failCount} failed`)
    process.exit(failCount > 0 ? 1 : 0)
}

main()
