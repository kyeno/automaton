/**
 * Force-run guard tests for RuleBasedAutomationBase.execute().
 *
 * Verifies the "/automation force" contract end-to-end through the real template-method
 * execute() flow with a fake target device and a stubbed Redis layer (CacheService methods
 * patched via its prototype since the singleton itself is frozen):
 *   - natural runs are still suppressed inside the silence window (baseline),
 *   - force:true bypasses the silent period AND an already-consumed once-per-day marker,
 *     without writing or refreshing any marker (a forced/delegated run never consumes a slot),
 *   - human-interaction cooldowns are intentionally NOT bypassed by force -- even a forced
 *     run defers to a device someone just touched.
 * No MQTT broker or live Redis required; the clock is stubbed like test-silence-between.js.
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
import os from 'node:os'
import path from 'node:path'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'
import temporal from '../src/lib/date.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

// Bootstrap config + logger so logging works in unit-test mode
await ConfigService.init()
LoggerService.init()

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

/**
 * Stub Date so we can test arbitrary times without waiting for the real clock.
 * Returns a cleanup function to restore the original Date constructor.
 */
function stubDate(hour, minute) {
    const OriginalDate = global.Date
    class FakeDate extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) {
                super(2026, 7 /* August */, 15, hour, minute, 0, 0)
            } else {
                super(...args)
            }
        }
        static now() { return new FakeDate().getTime() }
    }
    Object.setPrototypeOf(FakeDate.prototype, OriginalDate.prototype)
    global.Date = FakeDate
    return () => { global.Date = OriginalDate }
}

// -- Fixtures ----------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-force-test-'))
const configPath = path.join(tmpDir, 'force-probe.yaml')
fs.writeFileSync(configPath, [
    'silence_between: "0500-0900"',
    'rules:',
    '  - name: "Force probe rule"',
    '    once: true',
    '    action: "on"',
].join('\n'))

/** Minimal device stand-in recording every command it receives. */
class ProbeDevice {
    getName() { return 'Force Probe Target' }
    getStateOrigin() { return null }   // not HUMAN -> local cooldown fallback passes
    getStateLastAt() { return '' }
    receiveCommand(payload, source) { this.received.push({ payload, source }) }
    received = []
}

/** Concrete rule-based automation wired to the fake device; counts hook invocations. */
class ForceProbeAutomation extends RuleBasedAutomationBase {
    constructor(name, cfgPath) {
        super({ name, configPath: cfgPath })
        this.device = new ProbeDevice()
        this.loadCalls = 0
        this.resolveCalls = 0
        this.conditionEvals = 0
    }

    /** Count how often rule evaluation was actually reached (bypass guards aside). */
    async conditionsMatch(conditions, context) {
        this.conditionEvals++
        return super.conditionsMatch(conditions, context)
    }

    loadDevices() {
        this.loadCalls++
        return new Map([['probe', this.device]])
    }

    resolveCommand(_dev, _tk, _rules) {
        this.resolveCalls++
        return { payload: 'on' }
    }
}

// -- Stubbed Redis layer -------------------------------------------------------------
// The CacheService singleton is frozen, so patch its prototype instead; restore on exit.

const cacheProto = Object.getPrototypeOf(CacheService)
const origGet = cacheProto.get
const origSet = cacheProto.set
const origCooldown = cacheProto.getHumanCooldownRemaining

const redisMock = {
    onceStore: new Map(),          // key -> stored marker value (mirrors #hasActedToday shape)
    cooldownRemainingMs: null,     // > 0 means an active human-interaction cooldown
}
cacheProto.get = async (key) => (redisMock.onceStore.has(key) ? redisMock.onceStore.get(key) : undefined)
cacheProto.set = async (key, item) => { redisMock.onceStore.set(key, item); return true }
cacheProto.getHumanCooldownRemaining = async () => redisMock.cooldownRemainingMs

function restoreCacheService() {
    cacheProto.get = origGet
    cacheProto.set = origSet
    cacheProto.getHumanCooldownRemaining = origCooldown
}

const auto = new ForceProbeAutomation('ForceProbeAutomation', configPath)

try {
    // -- S1: baseline suppression inside the silence window -------------------------

    console.log('\n\u2500\u2500 Silent period \u2500\u2500\n')

    {
        const restore = stubDate(6, 30)   // inside 0500-0900
        await auto.execute({ trigger: 'manual' })
        assert(auto.loadCalls === 0, 'natural run returns before any work begins when silenced')
        assert(auto.device.received.length === 0, 'no device command during a suppressed natural run')
        restore()
    }

    // -- Force bypasses the silent period and does NOT consume the once-slot ---------

    {
        const restore = stubDate(6, 30)   // still inside 0500-0900
        await auto.execute({ trigger: 'manual', force: true })
        assert(auto.loadCalls === 1 && auto.resolveCalls >= 1, 'forced run proceeds past the silent-period guard and resolves its target')
        assert(
            auto.device.received.length === 1 && auto.device.received[0].payload === 'on'
                && auto.device.received[0].source === DeviceCommandSource.AUTOMATION,
            'device receives the automation-sourced command despite the silence window'
        )
        assert(redisMock.onceStore.size === 0, 'forced run does NOT consume the once-slot (marker left unwritten)')
        restore()
    }

    // -- Once-per-day markers are owned by natural runs ------------------------------

    console.log('\n\u2500\u2500 Once-per-day markers \u2500\u2500\n')

    {
        // Outside the silence window; no marker exists yet (the forced run above wrote none).
        const restore = stubDate(12, 0)
        const fakeDay = temporal.getLocalDayString(new Date())   // captured under the SAME stubbed clock the run uses
        const receivedBefore = auto.device.received.length
        await auto.execute({ trigger: 'manual' })
        assert(auto.device.received.length === receivedBefore + 1, 'natural run dispatches end-to-end outside the silence window')
        assert(redisMock.onceStore.size === 1, 'a natural run that acted consumes the once-slot')
        const [markerKey, markerValue] = [...redisMock.onceStore.entries()][0]
        assert(markerKey.includes(':once:') && markerValue.date === fakeDay, "marker carries today's date under the same clock the run used")
        restore()
    }

    {
        const receivedBefore = auto.device.received.length
        const resolveBefore = auto.resolveCalls
        const evalsBefore = auto.conditionEvals
        const restore = stubDate(12, 0)
        await auto.execute({ trigger: 'manual' })
        assert(auto.conditionEvals >= evalsBefore + 1, 'blocked natural run still reaches rule evaluation')
        assert(auto.resolveCalls === resolveBefore, 'consumed once-slot blocks resolution for a later natural run on the same day')
        assert(auto.device.received.length === receivedBefore, 'no second device command without force')
        restore()
    }

    {
        // A forced run bypasses the consumed-slot check and acts again -- leaving the
        // existing marker untouched (it neither requires nor rewrites it).
        const key = [...redisMock.onceStore.keys()][0]
        const before = JSON.stringify(redisMock.onceStore.get(key))
        const receivedBefore = auto.device.received.length
        const restore = stubDate(12, 0)
        await auto.execute({ trigger: 'manual', force: true })
        assert(auto.device.received.length === receivedBefore + 1, 'forced run acts despite the already-consumed once-slot')
        assert(redisMock.onceStore.size === 1 && JSON.stringify(redisMock.onceStore.get(key)) === before, 'marker left exactly as-is by the forced run (not refreshed or duplicated)')
        restore()
    }

    // -- S5: human-interaction cooldowns are NOT bypassed by force --------------------

    console.log('\n\u2500\u2500 Human-interaction cooldown (kept under force) \u2500\u2500\n')

    {
        redisMock.onceStore.clear()   // isolate the cooldown guard from the once-marker
        redisMock.cooldownRemainingMs = 60_000   // someone touched this device a minute ago
        const receivedBefore = auto.device.received.length

        const restore = stubDate(12, 0)
        await auto.execute({ trigger: 'manual' })
        assert(auto.device.received.length === receivedBefore, 'baseline: natural run defers to recent human interaction')

        await auto.execute({ trigger: 'manual', force: true })
        assert(auto.device.received.length === receivedBefore, 'force still respects an active human-interaction cooldown')
        restore()

        redisMock.cooldownRemainingMs = null
    }

    // -- S6: positive control ---------------------------------------------------------

    console.log('\n\u2500\u2500 Positive control \u2500\u2500\n')

    {
        redisMock.onceStore.clear()
        const receivedBefore = auto.device.received.length
        const restore = stubDate(12, 0)
        await auto.execute({ trigger: 'manual' })
        assert(auto.device.received.length === receivedBefore + 1, 'with all guards clear, a plain natural run dispatches end-to-end')
        restore()
    }
} finally {
    restoreCacheService()
    fs.rmSync(tmpDir, { recursive: true, force: true })
}

// -- Summary ------------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)