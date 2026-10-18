import { config } from 'dotenv'
config()

'use strict'

/**
 * Focused tests for NetworkDeviceOfflineMonitor -- spoken warning when a mission-critical
 * LAN host goes offline.
 *
 * Drives the real EventBus + ConfigService (patched get() for dynamic overrides) with
 * stubbed NetworkPresence / TtsService / I18nLoader prototypes, then pins down:
 *   A) offline transition speaks the localized per-device sentence
 *   B) online transition is silent while recovery speech is off
 *   C) recovery speaks only with alerts.network_offline_announce_recovery: true
 *   D) startup sweep announces hosts already found down at boot
 *   E) per-device cooldown override wins over the family default
 *   F) per-device tts_profile / tts_options overrides reach the payload
 *   G) ignore list entries are never announced
 *   H) master switch silences every host
 *   I) a configured name absent from network.yaml is reported once at startup
 *   J) unavailable TTS speaks nothing and consumes no cooldown slot
 *   K) configuredDevices() shape (null entries, overrides, junk values)
 *
 * No Redis/MQTT needed -- presence labels come from the stubbed in-memory record.
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
import NetworkPresence from '../src/monitor/networkPresence.js'
import NetworkDeviceOfflineMonitor from '../src/monitor/networkDeviceOfflineMonitor.js'

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

const loggerProto = Object.getPrototypeOf(LoggerService)
const ttsProto = Object.getPrototypeOf(TtsService)
const presenceProto = Object.getPrototypeOf(NetworkPresence)
const i18nProto = Object.getPrototypeOf(I18nLoader)

// TtsService.isEnabled gate and profile registry (wave files are not part of the repo).
const originalTtsEnabled = ttsProto.isEnabled
let ttsEnabledFlag = true
ttsProto.isEnabled = function () { return ttsEnabledFlag }

const profileRegistry = {
    alarm: { intro: 'alarm-intro.wav', outro: 'alarm-outro.wav', intro_spacing: -1.5 }
}
const originalGetProfile = ttsProto.getProfile
ttsProto.getProfile = function (name) {
    return profileRegistry[String(name ?? '').trim().toLowerCase()] ?? null
}

// I18nLoader locale pinning (so the monitor reads pl_PL/alerts.yaml).
const originalGetLocale = i18nProto.getLocale
i18nProto.getLocale = function () { return 'pl_PL' }

// Per-device wording is optional in templates. Supply it explicitly for override coverage.
const monitorProto = Object.getPrototypeOf(NetworkDeviceOfflineMonitor)
const originalReadBundle = monitorProto.readBundle
monitorProto.readBundle = () => ({
    network_device_offline: { default: 'Uwaga, {device} jest offline.', 'core-server': 'Uwaga, serwer core jest offline.' },
    network_device_online: { default: '{device} znowu działa.', 'dns-server': 'Serwer DNS znowu działa.' },
})

// NetworkPresence: the announce list is validated against getDeviceNames(), and the
// label the monitor speaks about comes from the in-memory sweep record.
const originalDeviceNames = presenceProto.getDeviceNames
const monitoredNames = ['core-server', 'dns-server', 'nas-server']
presenceProto.getDeviceNames = function () { return [...monitoredNames] }

const originalLastLabel = presenceProto.getLastLabel
const labelBoard = {}
presenceProto.getLastLabel = function (name) {
    const key = String(name ?? '').toLowerCase()
    return Object.prototype.hasOwnProperty.call(labelBoard, key) ? labelBoard[key] : null
}
function setLabel(name, label) { labelBoard[String(name).toLowerCase()] = label }

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

// Announce list: one host per shape -- plain defaults, profile override, options
// override, cooldown override, and a host network.yaml does not monitor (wifi-router).
const ANNOUNCE_LIST = {
    'core-server': null,
    'dns-server': { cooldown: 0, tts_profile: 'alarm' },
    'wifi-router': { cooldown: 0, tts_options: { intro: 'router-intro.wav' } },
    'nas-server': { cooldown: '5m' }
}


async function main() {
    console.log('=== NetworkDeviceOfflineMonitor Tests ===\n')

    const payloads = []
    const spoken = []
    const unsubSpeak = EventBus.subscribe('tts:speak', (payload) => {
        payloads.push(payload)
        spoken.push(payload.text)
    })

    // Capture the startup sweep callback instead of waiting out its 15s timer, and
    // collect the warnings init() emits (the missing-name report happens there).
    const initWarnings = []
    const originalWarn = loggerProto.warn
    loggerProto.warn = function (message, tag) {
        initWarnings.push(message)
        return originalWarn.call(this, message, tag)
    }
    const realSetTimeout = global.setTimeout
    const bootCallbacks = []
    global.setTimeout = function (fn, ms, ...rest) {
        if (ms >= 1000) { bootCallbacks.push(fn); return { fake: true } }
        return realSetTimeout.call(global, fn, ms, ...rest)
    }

    setOverride('alerts.network_offline_devices', ANNOUNCE_LIST)
    setOverride('alerts.network_offline_tts', true)
    setOverride('alerts.network_offline_cooldown', '30m')
    setOverride('alerts.network_offline_ignore', [])
    setOverride('alerts.network_offline_tts_profile', '')
    setOverride('alerts.network_offline_announce_boot', true)
    setOverride('alerts.network_offline_announce_recovery', false)

    await NetworkDeviceOfflineMonitor.init()
    global.setTimeout = realSetTimeout
    loggerProto.warn = originalWarn

    try {
        // I) startup report for a name network.yaml does not monitor ----------------
        console.log('-- I) a name missing from network.yaml is reported once at startup --')
        const missingNotices = initWarnings.filter((m) => m.includes('wifi-router') && m.includes('not monitored'))
        assert(missingNotices.length === 1, `missing host reported once (got ${missingNotices.length})`)
        assert(initWarnings.filter((m) => m.includes('not monitored')).length === 1,
            'known hosts produce no warning')

        // K) configuredDevices() shape ------------------------------------------------
        console.log('-- K) configuredDevices() shape --')
        const devices = NetworkDeviceOfflineMonitor.configuredDevices()
        assert(devices.length === 4, `four hosts configured (got ${devices.length})`)
        assert(devices.map((d) => d.name).join(',') === 'core-server,dns-server,nas-server,wifi-router',
            `sorted by name (${devices.map((d) => d.name).join(', ')})`)
        const core = devices.find((d) => d.name === 'core-server')
        const dns = devices.find((d) => d.name === 'dns-server')
        assert(core.overrides.cooldown === undefined, 'null entry yields empty overrides (family defaults)')
        assert(dns.overrides.tts_profile === 'alarm', 'per-device overrides carried through')
        setOverride('alerts.network_offline_devices', { 'core-server': 'not-an-object', '': null })
        const junky = NetworkDeviceOfflineMonitor.configuredDevices()
        assert(junky.length === 1 && junky[0].name === 'core-server' && junky[0].overrides.cooldown === undefined,
            `junk override values degrade to defaults, empty names dropped (got ${JSON.stringify(junky)})`)
        setOverride('alerts.network_offline_devices', ANNOUNCE_LIST)

        // A) offline transition speaks ------------------------------------------------
        console.log('-- A) offline transition speaks the localized sentence --')
        setLabel('core-server', 'offline')
        EventBus.emit('network:core-server', { name: 'core-server', status: 'offline' })
        await sleep(50)
        assert(spoken.length === 1, `one utterance (got ${spoken.length})`)
        assert(spoken[0] === 'Uwaga, serwer core jest offline.',
            `per-device sentence from alerts.yaml: "${spoken[0]}"`)
        assert(Object.keys(payloads[0]).length === 1, 'no framing fields when nothing is configured')

        // B) online transition stays silent by default --------------------------------
        console.log('-- B) recovery is silent while announce_recovery is off --')
        spoken.length = 0
        setLabel('core-server', 'online')
        EventBus.emit('network:core-server', { name: 'core-server', status: 'online' })
        await sleep(50)
        assert(spoken.length === 0, 'online transition speaks nothing')

        // C) recovery speaks only when enabled ---------------------------------------
        console.log('-- C) announce_recovery=true speaks the way back --')
        setLabel('dns-server', 'online')
        EventBus.emit('network:dns-server', { name: 'dns-server', status: 'online' })
        await sleep(50)
        assert(spoken.length === 0, 'still silent with the switch off')
        setOverride('alerts.network_offline_announce_recovery', true)
        EventBus.emit('network:dns-server', { name: 'dns-server', status: 'online' })
        await sleep(50)
        assert(spoken.length === 1 && spoken[0] === 'Serwer DNS znowu działa.',
            `recovery sentence spoken (got ${JSON.stringify(spoken)})`)
        setOverride('alerts.network_offline_announce_recovery', false)

        // D) startup sweep announces hosts already down ------------------------------
        console.log('-- D) startup sweep announces hosts already offline at boot --')
        spoken.length = 0
        setLabel('core-server', 'offline')   // cooldown slot from A is still hot
        setLabel('wifi-router', 'offline')
        assert(bootCallbacks.length === 1, `startup sweep scheduled once (got ${bootCallbacks.length})`)
        for (const run of bootCallbacks) run()
        await sleep(50)
        assert(spoken.length === 1 && spoken[0].includes('router'),
            `only the host outside its cooldown announced (got ${JSON.stringify(spoken)})`)


        // E) per-device cooldown override --------------------------------------------
        console.log('-- E) per-device cooldown overrides the family default --')
        spoken.length = 0
        setLabel('dns-server', 'offline')
        EventBus.emit('network:dns-server', { name: 'dns-server', status: 'offline' })
        await sleep(30)
        EventBus.emit('network:dns-server', { name: 'dns-server', status: 'offline' })
        await sleep(50)
        assert(spoken.length === 2, `cooldown 0 re-warns every transition (got ${spoken.length})`)
        EventBus.emit('network:core-server', { name: 'core-server', status: 'offline' })
        await sleep(50)
        assert(spoken.length === 2, 'family 30m cooldown still suppresses core-server')

        // F) per-device framing overrides ---------------------------------------------
        console.log('-- F) per-device tts_profile / tts_options reach the payload --')
        payloads.length = 0
        EventBus.emit('network:dns-server', { name: 'dns-server', status: 'offline' })
        await sleep(50)
        EventBus.emit('network:wifi-router', { name: 'wifi-router', status: 'offline' })
        await sleep(50)
        const dnsPayload = payloads[0] ?? {}
        const routerPayload = payloads[1] ?? {}
        assert(dnsPayload.intro === 'alarm-intro.wav' && dnsPayload.outro === 'alarm-outro.wav'
            && dnsPayload.intro_spacing === -1.5, `profile override applied (${JSON.stringify(dnsPayload)})`)
        assert(routerPayload.intro === 'router-intro.wav' && routerPayload.outro === undefined,
            `options override applied (${JSON.stringify(routerPayload)})`)
        assert(payloads.every((p) => p.output_endpoint === undefined),
            'framing never carries output_endpoint')

        // G) ignore list ---------------------------------------------------------------
        console.log('-- G) ignored hosts are never announced --')
        spoken.length = 0
        setOverride('alerts.network_offline_ignore', ['NAS-Server'])
        EventBus.emit('network:nas-server', { name: 'nas-server', status: 'offline' })
        await sleep(50)
        EventBus.emit('network:wifi-router', { name: 'wifi-router', status: 'offline' })
        await sleep(50)
        assert(spoken.length === 1 && spoken[0].includes('router'),
            `ignored host silent, others speak (got ${JSON.stringify(spoken)})`)
        setOverride('alerts.network_offline_ignore', [])

        // H) master switch --------------------------------------------------------------
        console.log('-- H) alerts.network_offline_tts=false silences every host --')
        spoken.length = 0
        setOverride('alerts.network_offline_tts', false)
        EventBus.emit('network:wifi-router', { name: 'wifi-router', status: 'offline' })
        EventBus.emit('network:dns-server', { name: 'dns-server', status: 'offline' })
        await sleep(50)
        assert(spoken.length === 0, 'disabled switch produces no speech')
        setOverride('alerts.network_offline_tts', true)

        // J) unavailable TTS keeps the door open ---------------------------------------
        console.log('-- J) unavailable TTS speaks nothing and keeps the door open --')
        spoken.length = 0
        ttsEnabledFlag = false
        setLabel('nas-server', 'offline')
        EventBus.emit('network:nas-server', { name: 'nas-server', status: 'offline' })
        await sleep(50)
        assert(spoken.length === 0, 'no speech when TTS is down')
        ttsEnabledFlag = true
        EventBus.emit('network:nas-server', { name: 'nas-server', status: 'offline' })
        await sleep(50)
        assert(spoken.length === 1, 'host announced once TTS recovered (cooldown not burned)')
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exitCode = 1
    } finally {
        unsubSpeak()
        NetworkDeviceOfflineMonitor.stop()
        loggerProto.warn = originalWarn
        ttsProto.isEnabled = originalTtsEnabled
        ttsProto.getProfile = originalGetProfile
        monitorProto.readBundle = originalReadBundle
        i18nProto.getLocale = originalGetLocale
        presenceProto.getDeviceNames = originalDeviceNames
        presenceProto.getLastLabel = originalLastLabel
        configProto.get = originalConfigGet
    }

    console.log(`\nResults: ${passCount} passed, ${failCount} failed`)
    process.exit(failCount > 0 ? 1 : 0)
}

main()

