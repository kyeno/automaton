/** Red Alert lifecycle with local, isolated lighting and sound fixtures.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
'use strict'

import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mock } from 'node:test'

import ScenarioCommand from '../src/commands/scenarioCommand.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import { lightWriteGuard } from '../src/scenario/lightOwnership.js'
import { SRedAlertScenario } from '../src/scenario/redAlertScenario.js'
import SequenceBase from '../src/sequence/base/sequenceBase.js'
import LoggerService from '../src/service/loggerService.js'

for (const method of ['info', 'warn', 'error']) mock.method(Object.getPrototypeOf(LoggerService), method, () => {})

const ALARM = 'alarm.mp3'
const CLIP = 'red-alert.pl_PL.wifi-router-offline.wav'
const RECOVERY_CLIP = 'red-alert.pl_PL.wifi-router-online.wav'

/** Wait for a fixture event without relying on an exact timer schedule. */
async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await delay(5)
    assert.ok(predicate(), 'expected fixture event')
}

/** Construct a real sequence with a fake device and local media player. */
async function fixture({ clip = true, recoveryClip = true, blockRecovery = false, failAlarm = false, blockBlackout = false, initialDelay = '2ms' } = {}) {
    const events = []
    const checks = []
    const guards = []
    let finishBlackout
    const blackout = new Promise(resolve => { finishBlackout = resolve })
    const light = {
        getName: () => 'Test Dimmer',
        receiveCommand: (payload, source, options) => {
            const guard = lightWriteGuard('Test Dimmer', options.lightLease)
            assert.ok(guard())
            assert.equal(source, 'automation')
            assert.equal(options.bypassNoOpSuppression, true)
            guards.push(guard)
            events.push(typeof payload === 'string' ? payload : payload.state)
            if (blockBlackout && options.lightLease && payload === 'OFF') return blackout
        }
    }
    const find = mock.method(Object.getPrototypeOf(DeviceContainer), 'findByName', () => light)
    const sequence = new SequenceBase('Hazard Lights', {
        on: [{ device: 'Test Dimmer', payload: { state: 'LOW' } }],
        off: [{ device: 'Test Dimmer', payload: { state: 'HIGH' } }],
        loop: { enabled: true, cycle: 'continuous', off_delay: '10s', on_delay: '10s' }
    })
    try { await sequence.init() } finally { find.mock.restore() }

    const scenario = new SRedAlertScenario({
        config: () => ({ enabled: true, light_sequence: 'hazard_lights', restore_automation: 'Ambient',
            audio: { alarm_file: ALARM, warning_initial_delay: initialDelay, warning_repeat_delay: '20s' } }),
        locale: () => 'pl_PL',
        device: () => light,
        sequence: () => sequence,
        connected: () => true,
        hasAutomation: () => true,
        restore: name => { events.push(`restore:${name}`); return true },
        hasSound: file => { checks.push(file); return file === ALARM || (clip && file === CLIP) || (recoveryClip && file === RECOVERY_CLIP) },
        playSound: async (file, { signal }) => {
            events.push(file)
            if (failAlarm && file === ALARM) throw new Error('Fake alarm failed')
            if (file === CLIP) return
            if (file === RECOVERY_CLIP) {
                if (blockRecovery) {
                    try { await delay(30_000, undefined, { signal }) } finally { events.push('recovery exited') }
                }
                return
            }
            try { await delay(30_000, undefined, { signal }) } finally { events.push('alarm exited') }
        },
        delay: (ms, value, options) => { events.push(ms); return delay(ms, value, options) }
    })
    return { scenario, sequence, events, checks, guards, finishBlackout }
}

const active = await fixture()
try {
    const oldWrite = lightWriteGuard('Test Dimmer')
    assert.equal(active.scenario.start({ warning: 'wifi-router-offline', host: 'dns', recovery_warning: 'dns-online' }), true)
    assert.equal(active.scenario.start({ host: 'router', recovery_warning: 'wifi-router-online' }), true)
    await until(() => active.events.includes('LOW') && active.events.includes(20_000))
    assert.equal(active.events.filter(event => event === ALARM).length, 1)
    assert.ok(active.events.indexOf(2) < active.events.indexOf(CLIP))
    assert.ok(active.events.indexOf(CLIP) < active.events.indexOf(20_000))
    assert.equal(lightWriteGuard('Test Dimmer')(), false, 'ordinary command is blocked')
    assert.equal(lightWriteGuard('Other Dimmer')(), true, 'unrelated lights stay available')
    assert.equal(await active.scenario.recover('unrelated'), false)
    assert.equal(await active.scenario.recover('dns'), false, 'router remains down')
    assert.equal(await active.scenario.recover('router'), true)
    assert.equal(await active.scenario.recover('router'), false)
    assert.equal(await active.scenario.stop(), false)
    assert.equal(active.sequence.isLoopActive(), false)
    assert.ok(active.events.indexOf('alarm exited') < active.events.indexOf('restore:Ambient'))
    assert.deepEqual(active.events.slice(-3), ['OFF', 'restore:Ambient', RECOVERY_CLIP])
    assert.equal(active.events.filter(event => event === RECOVERY_CLIP).length, 1)
    assert.ok(!active.checks.includes('red-alert.pl_PL.dns-online.wav'))
    assert.equal(active.events.filter(event => event === 'restore:Ambient').length, 1)
    assert.equal(active.events.includes('HIGH'), false, 'stop cancels the inter-phase timer')
    assert.equal(oldWrite(), false, 'pre-claim queued commands stay invalidated after release')
    assert.equal(active.guards[0](), false, 'stopped scenario writes are invalidated')
    assert.equal(lightWriteGuard('Test Dimmer')(), true)
} finally {
    await active.scenario.stop()
}

const missing = await fixture({ clip: false })
try {
    assert.equal(missing.scenario.start({ warning: 'wifi-router-offline', host: 'router', recovery_warning: 'wifi-router-online' }), true)
    await until(() => missing.events.includes(ALARM))
    assert.deepEqual(missing.checks, [ALARM, CLIP, 'red-alert.pl_PL.infrastructure-offline.wav'])
    assert.equal(missing.events.includes(CLIP), false)
    const ctx = { redAlertScenario: missing.scenario }
    assert.deepEqual((await ScenarioCommand.run('status red_alert', ctx)).lines, ['Red Alert is active'])
    assert.deepEqual((await ScenarioCommand.run('stop red_alert', ctx)).lines, ['Red Alert stopped'])
    assert.equal(await missing.scenario.recover('router'), false)
    assert.ok(!missing.checks.includes(RECOVERY_CLIP), 'manual stop never requests the recovery clip')
} finally {
    await missing.scenario.stop()
}

const stopping = await fixture({ blockBlackout: true })
try {
    assert.equal(stopping.scenario.start(), true)
    await until(() => stopping.events.includes('OFF'))
    const first = stopping.scenario.stop()
    const second = stopping.scenario.stop()
    assert.equal(stopping.scenario.start(), false)
    stopping.finishBlackout()
    assert.deepEqual(await Promise.all([first, second]), [true, true])
    assert.deepEqual(stopping.events, ['OFF', 'OFF', 'restore:Ambient'])
} finally {
    stopping.finishBlackout()
    await stopping.scenario.stop()
}

const failure = await fixture({ failAlarm: true })
try {
    assert.equal(failure.scenario.start(), true)
    await until(() => !failure.scenario.isActive())
    assert.equal(failure.sequence.isLoopActive(), false)
    assert.equal(failure.events.filter(event => event === 'restore:Ambient').length, 1)
} finally {
    await failure.scenario.stop()
}

const delayed = await fixture({ initialDelay: '10s' })
try {
    assert.equal(delayed.scenario.start({ warning: 'wifi-router-offline' }), true)
    await until(() => delayed.events.includes(10_000))
    assert.equal(await delayed.scenario.stop(), true)
    assert.equal(delayed.events.includes(CLIP), false, 'stop aborts the initial warning delay')
} finally {
    await delayed.scenario.stop()
}

const missingRecovery = await fixture({ recoveryClip: false })
try {
    assert.equal(missingRecovery.scenario.start({ host: 'router', recovery_warning: 'wifi-router-online' }), true)
    await until(() => missingRecovery.events.includes(ALARM))
    assert.equal(await missingRecovery.scenario.recover('router'), true)
    assert.ok(missingRecovery.checks.includes(RECOVERY_CLIP))
    assert.ok(!missingRecovery.events.includes(RECOVERY_CLIP), 'missing WAV never starts a player')
} finally {
    await missingRecovery.scenario.stop()
}

const interruptedRecovery = await fixture({ blockRecovery: true })
try {
    assert.equal(interruptedRecovery.scenario.start({ host: 'router', recovery_warning: 'wifi-router-online' }), true)
    await until(() => interruptedRecovery.events.includes(ALARM))
    const recovering = interruptedRecovery.scenario.recover('router')
    await until(() => interruptedRecovery.events.includes(RECOVERY_CLIP))
    assert.equal(interruptedRecovery.scenario.start({ host: 'router' }), true)
    assert.equal(await recovering, true)
    assert.ok(interruptedRecovery.events.includes('recovery exited'))
} finally {
    await interruptedRecovery.scenario.stop()
}