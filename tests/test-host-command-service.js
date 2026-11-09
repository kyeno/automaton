/**
 * Signed host commands: canonical wire format, ACK correlation, replay/timeout behaviour and
 * the typed host_command sequence step -- all against a fake MQTT client.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock } from 'node:test'

import HostCommandService from '../src/host/hostCommandService.js'
import { canonicalAck, canonicalCommand, signCanonical, verifySignature } from '../src/host/hostProtocol.js'
import MqttService from '../src/service/mqttService.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import SequenceBase from '../src/sequence/base/sequenceBase.js'

const SECRET = 'htpc-v1-test-secret-0123456789abcdef'
const CMD_TOPIC = 'automaton/host/htpc/command'
const ACK_TOPIC = 'automaton/host/htpc/ack'

/** Build a signed ACK payload for one published command.
 * @param {Object} command - Command payload as published
 * @param {string} status - accepted | failed | rejected
 * @returns {Object} ACK payload */
const ackFor = (command, status = 'accepted') => {
    const tsMs = Date.now()
    return {
        v: 1,
        id: command.id,
        target: command.target,
        status,
        ts_ms: tsMs,
        sig: signCanonical(SECRET, canonicalAck({ id: command.id, target: command.target, status, tsMs }))
    }
}

//  1) Wire vector -- the byte-for-byte contract shared with the Dart implementation.

const VECTOR_ID = '7b3b9845-bb6c-4717-a72b-b0ab991be180'
const vectorCommand = canonicalCommand({ id: VECTOR_ID, target: 'htpc', action: 'shutdown', iatMs: 1793059500000, expMs: 1793059515000 })
assert.equal(vectorCommand, 'v1\n7b3b9845-bb6c-4717-a72b-b0ab991be180\nhtpc\nshutdown\n1793059500000\n1793059515000')
assert.equal(
    signCanonical(SECRET, vectorCommand),
    '13f4a562f7244d8a3928775595061324e2c4806631b6cdd1b146416f5c3ca057'
)
const vectorAck = canonicalAck({ id: VECTOR_ID, target: 'htpc', status: 'accepted', tsMs: 1793059500250 })
assert.equal(vectorAck, 'v1\nack\n7b3b9845-bb6c-4717-a72b-b0ab991be180\nhtpc\naccepted\n1793059500250')
assert.equal(
    signCanonical(SECRET, vectorAck),
    'd3a444c0b3a4c7097362a2c472f143cd97fc841994c16b03fa6b88bfe62d9d98'
)
assert.equal(verifySignature(SECRET, vectorAck, signCanonical(SECRET, vectorAck)), true)
assert.equal(verifySignature(SECRET, vectorAck, 'a'.repeat(64)), false, 'wrong signature must not verify')
assert.equal(verifySignature(SECRET, vectorAck, 'deadbeef'), false, 'malformed signature must not verify')
console.log('Host protocol wire vector verified')


//  2) Service behaviour against a fake MQTT client (mock timers).

for (const level of ['info', 'warn', 'error', 'debug']) mock.method(Object.getPrototypeOf(LoggerService), level, () => {})

const client = new EventEmitter()
client.connected = false
/** @type {Array<{topic: string, payload: Object, options: Object}>} */
const published = []
/** @type {string[]} */
const subscribed = []
client.publish = (topic, payload, options, callback) => {
    published.push({ topic, payload: JSON.parse(String(payload)), options })
    callback?.()
}
client.subscribe = (topic, callback) => { subscribed.push(topic); callback?.() }
client.unsubscribe = (_topic, callback) => callback?.()
client.end = (_force, callback) => { client.connected = false; callback?.() }

/** Let queued microtasks (publish drain, ACK dispatch) run.
 * @returns {Promise<void>} */
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

/** Deliver one ACK to the subscription.
 * @param {Object|string} payload - ACK payload
 * @param {string} [topic] - Topic to deliver on (defaults to the htpc ACK topic) */
const deliver = (payload, topic = ACK_TOPIC) => client.emit('message', topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)))

process.env.HTPC_TEST_SECRET = SECRET
/** @type {Object} */
let hostSection = {
    enabled: true,
    topic_base: 'automaton/host',
    targets: { htpc: { secret_env: 'HTPC_TEST_SECRET', ack_timeout: '2s' } }
}
mock.method(Object.getPrototypeOf(ConfigService), 'getSection', (key) => (key === 'host_commands' ? hostSection : undefined))

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })

try {
    const ready = MqttService.init({ connectFn: () => client })
    client.connected = true
    client.emit('connect')
    await ready

    await HostCommandService.init()
    assert.equal(HostCommandService.isInitialized(), true)
    assert.equal(HostCommandService.isEnabled(), true)
    assert.ok(subscribed.includes(ACK_TOPIC), 'ACK topic subscribed at init')
    assert.equal(subscribed.includes(CMD_TOPIC), false, 'command topic is published to, never subscribed')
    assert.deepEqual(HostCommandService.listTargets().map(t => t.target), ['htpc'], 'allowlisted targets exposed')
    assert.equal(HostCommandService.listTargets()[0].ready, true)
    assert.equal(JSON.stringify(HostCommandService.listTargets()).includes(SECRET), false, 'secret never leaves listTargets')

    //  Accepted: signed request out, matching signed ACK back, exactly one resolution.
    const acceptedRun = HostCommandService.requestShutdown('htpc')
    await settle()
    const command = published.at(-1)
    assert.equal(command.topic, CMD_TOPIC)
    assert.equal(command.options.qos, 1, 'commands are published at QoS 1')
    assert.equal(command.options.retain, false, 'commands are never retained')
    assert.equal('meta' in command.options, false, 'service metadata never reaches mqtt.js')
    const cmd = command.payload
    assert.equal(cmd.v, 1)
    assert.equal(cmd.target, 'htpc')
    assert.equal(cmd.action, 'shutdown')
    assert.equal(cmd.exp_ms - cmd.iat_ms, 15_000, 'commands expire after the validity window')
    assert.match(cmd.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(Object.keys(cmd).sort().join(','), 'action,exp_ms,iat_ms,id,sig,target,v', 'command carries only protocol fields')
    assert.equal(
        verifySignature(SECRET, canonicalCommand({ id: cmd.id, target: cmd.target, action: cmd.action, iatMs: cmd.iat_ms, expMs: cmd.exp_ms }), cmd.sig),
        true,
        'published command carries a valid signature'
    )

    const acceptedAck = ackFor(cmd)
    deliver(acceptedAck)
    await settle()
    const accepted = await acceptedRun
    assert.equal(accepted.status, 'accepted')
    assert.equal(accepted.target, 'htpc')
    assert.equal(accepted.id, cmd.id)

    //  Replay: the same ACK redelivered must resolve nothing new.
    deliver(acceptedAck)
    const secondRun = HostCommandService.requestShutdown('htpc')
    await settle()
    const cmd2 = published.at(-1).payload
    assert.notEqual(cmd2.id, cmd.id, 'every request gets a fresh id')
    let settled = false
    secondRun.then(() => { settled = true })
    mock.timers.tick(1_000)
    await settle()
    assert.equal(settled, false, 'a replayed ACK must not resolve a newer request')
    deliver(ackFor(cmd2))
    await settle()
    assert.equal((await secondRun).status, 'accepted')

    //  Rejected by the host: the status is reported, never retried.
    const rejectedRun = HostCommandService.requestShutdown('htpc')
    await settle()
    deliver(ackFor(published.at(-1).payload, 'rejected'))
    await settle()
    assert.equal((await rejectedRun).status, 'rejected')

    //  Forged ACK: a bad signature never resolves the request -- the caller times out.
    const forgedRun = HostCommandService.requestShutdown('htpc')
    await settle()
    const forgedId = published.at(-1).payload.id
    deliver({ v: 1, id: forgedId, target: 'htpc', status: 'accepted', ts_ms: Date.now(), sig: 'f'.repeat(64) })
    deliver({ v: 1, id: forgedId, target: 'htpc', status: 'accepted', ts_ms: Date.now() })
    deliver('not json at all')
    await settle()
    mock.timers.tick(2_000)
    await settle()
    assert.equal((await forgedRun).status, 'timeout', 'unverifiable ACK is ignored and the request times out')

    //  Implausible timestamp: valid signature, absurd ts_ms -- ignored.
    const skewRun = HostCommandService.requestShutdown('htpc')
    await settle()
    const skewCmd = published.at(-1).payload
    const pastTs = skewCmd.iat_ms - 60_000
    deliver({
        v: 1,
        id: skewCmd.id,
        target: 'htpc',
        status: 'accepted',
        ts_ms: pastTs,
        sig: signCanonical(SECRET, canonicalAck({ id: skewCmd.id, target: 'htpc', status: 'accepted', tsMs: pastTs }))
    })
    await settle()
    mock.timers.tick(2_000)
    await settle()
    assert.equal((await skewRun).status, 'timeout', 'ACK outside the clock-skew window is ignored')

    //  Topic binding: an ACK naming this request on a foreign topic is ignored.
    const crossRun = HostCommandService.requestShutdown('htpc')
    await settle()
    deliver(ackFor(published.at(-1).payload), 'automaton/host/other/ack')
    await settle()
    mock.timers.tick(2_000)
    await settle()
    assert.equal((await crossRun).status, 'timeout', 'ACK on a foreign topic is ignored')

    //  Unknown target: fails closed without touching the broker.
    const publishedBefore = published.length
    const unknown = await HostCommandService.requestShutdown('attacker_pc')
    assert.equal(unknown.status, 'failed')
    assert.match(unknown.reason, /not allowlisted/)
    assert.equal(published.length, publishedBefore, 'unknown target publishes nothing')

    //  Unsupported action.
    const reboot = await HostCommandService.requestShutdown('htpc', { action: 'reboot' })
    assert.equal(reboot.status, 'failed')
    assert.match(reboot.reason, /unsupported action/)

    //  Missing secret: the target is known, the environment variable is not.
    hostSection = { enabled: true, topic_base: 'automaton/host', targets: { htpc: { secret_env: 'HTPC_TEST_SECRET_UNSET' } } }
    await HostCommandService.reload()
    const noSecret = await HostCommandService.requestShutdown('htpc')
    assert.equal(noSecret.status, 'failed')
    assert.match(noSecret.reason, /HTPC_TEST_SECRET_UNSET/)

    //  Disabled master switch.
    hostSection = { enabled: false, topic_base: 'automaton/host', targets: { htpc: { secret_env: 'HTPC_TEST_SECRET' } } }
    await HostCommandService.reload()
    assert.equal(HostCommandService.isEnabled(), false)
    const disabled = await HostCommandService.requestShutdown('htpc')
    assert.equal(disabled.status, 'failed')
    assert.match(disabled.reason, /disabled/)

    //  Local dispatch failure surfaces as failed, never as a thrown error.
    hostSection = { enabled: true, topic_base: 'automaton/host', targets: { htpc: { secret_env: 'HTPC_TEST_SECRET', ack_timeout: '2s' } } }
    await HostCommandService.reload()
    const publishImpl = client.publish
    client.publish = () => { throw new Error('local publish failure') }
    const dispatchFailed = await HostCommandService.requestShutdown('htpc')
    assert.equal(dispatchFailed.status, 'failed')
    assert.match(dispatchFailed.reason, /local publish failure/)
    client.publish = publishImpl

    //  Reload releases in-flight requests instead of leaving them waiting.
    const inflight = HostCommandService.requestShutdown('htpc')
    await settle()
    const reloaded = await HostCommandService.reload()
    assert.equal(reloaded.ok, true)
    const released = await inflight
    assert.equal(released.status, 'failed')
    assert.match(released.reason, /reload/)

    await HostCommandService.cleanup()
    assert.equal(HostCommandService.isInitialized(), false)
    console.log('Host command service signed-request and ACK tests passed')
} finally {
    await MqttService.disconnect()
    mock.timers.reset()
}

//  3) Sequence integration (real timers): typed host steps run alongside device steps.

const dcProto = Object.getPrototypeOf(DeviceContainer)
/** @type {Array<{name: string, payload: string}>} */
const deviceCommands = []
mock.method(dcProto, 'findByName', (name) => (name === 'Test Lamp' ? {
    receiveCommand: async (payload) => { deviceCommands.push({ name, payload }) }
} : null))

hostSection = {
    enabled: true,
    topic_base: 'automaton/host',
    targets: { htpc: { secret_env: 'HTPC_TEST_SECRET', ack_timeout: '40ms' } }
}

const reconnect = MqttService.init({ connectFn: () => client })
client.connected = true
client.emit('connect')
await reconnect
await HostCommandService.init()

/** Run a phase, answering every command the broker receives.
 * @param {SequenceBase} sequence - Sequence to run
 * @param {'ON'|'OFF'} phase - Phase to run
 * @param {string} status - Status to answer with
 * @returns {Promise<{ok: boolean, result: Object}>} Run outcome and result */
async function runWithAck(sequence, phase, status = 'accepted') {
    const acked = new Set()
    const running = sequence.run(phase)
    for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 2))
        const last = published.at(-1)
        if (last?.topic === CMD_TOPIC && !acked.has(last.payload.id)) {
            acked.add(last.payload.id)
            deliver(ackFor(last.payload, status))
        }
    }
    return { ok: await running, result: sequence.getLastRunResult() }
}

try {
    //  Rich form: host step is kept in ON and dropped from the derived OFF.
    const rich = new SequenceBase('Host Shutdown Rich', {
        on: [{ device: 'Test Lamp', payload: 'ON' }, { kind: 'host_command', target: 'htpc', action: 'shutdown', delay: '10ms' }],
        off: [{ device: 'Test Lamp', payload: 'OFF' }]
    })
    await rich.init()
    assert.equal(rich.supportsPhase('ON'), true)
    assert.equal(rich.supportsPhase('OFF'), true)

    const richOn = await runWithAck(rich, 'ON')
    assert.equal(richOn.ok, true)
    assert.equal(richOn.result.status, 'completed')
    assert.equal(richOn.result.completed, 2)
    assert.deepEqual(richOn.result.failed, [])
    assert.deepEqual(deviceCommands.map(c => c.payload), ['ON'], 'device step ran as before')
    const lastCommand = published.at(-1)
    assert.equal(lastCommand.topic, CMD_TOPIC)
    assert.equal(lastCommand.payload.action, 'shutdown')

    const commandsBeforeOff = published.length
    const richOff = await runWithAck(rich, 'OFF')
    assert.equal(richOff.ok, true)
    assert.equal(richOff.result.completed, 1, 'explicit OFF list runs the device step only')
    assert.equal(published.length, commandsBeforeOff, 'OFF phase publishes no host command')
    assert.deepEqual(deviceCommands.map(c => c.payload), ['ON', 'OFF'], 'device steps ran in both phases')

    //  Host-only ON: nothing to turn off, so OFF is not advertised.
    const hostOnly = new SequenceBase('Host Only', {
        on: [{ kind: 'host_command', target: 'htpc', action: 'shutdown' }]
    })
    await hostOnly.init()
    assert.equal(hostOnly.supportsPhase('ON'), true)
    assert.equal(hostOnly.supportsPhase('OFF'), false, 'a host-only sequence advertises no OFF phase')

    //  Host timeout: the sequence reports partial failure naming host:<target>.
    const timeoutSeq = new SequenceBase('Host Timeout', {
        on: [{ device: 'Test Lamp', payload: 'ON' }, { kind: 'host_command', target: 'htpc', action: 'shutdown' }]
    })
    await timeoutSeq.init()
    const timeoutRun = await timeoutSeq.run('ON')
    const timeoutResult = timeoutSeq.getLastRunResult()
    assert.equal(timeoutRun, true, 'the run executed; the host step is what failed')
    assert.equal(timeoutResult.status, 'partial_failure')
    assert.equal(timeoutResult.failed.length, 1)
    assert.equal(timeoutResult.failed[0].device, 'host:htpc')
    assert.match(timeoutResult.failed[0].error, /timeout/)

    //  Unknown target in a step: that step fails, the device step still runs.
    const rogueSeq = new SequenceBase('Rogue Target', {
        on: [{ device: 'Test Lamp', payload: 'ON' }, { kind: 'host_command', target: 'attacker_pc', action: 'shutdown' }]
    })
    await rogueSeq.init()
    const rogueRun = await rogueSeq.run('ON')
    assert.equal(rogueRun, true, 'the run executed; the rogue host step is what failed')
    assert.equal(rogueSeq.getLastRunResult().failed[0].device, 'host:attacker_pc')

    //  Simple devices: form cannot derive an OFF payload, so host steps are skipped there.
    const simple = new SequenceBase('Simple Form Host', {
        devices: ['Test Lamp', { kind: 'host_command', target: 'htpc', action: 'shutdown' }]
    })
    await simple.init()
    const simpleRun = await runWithAck(simple, 'ON')
    assert.equal(simpleRun.result.completed, 1, 'host step skipped in the simple form')
    assert.equal(simpleRun.result.failed.length, 0)
    assert.equal(simple.supportsPhase('OFF'), true, 'derived OFF keeps the device step')

    //  Unsupported action in a step is skipped at init, never at run time.
    const rebootSeq = new SequenceBase('Reboot Step', {
        on: [{ kind: 'host_command', target: 'htpc', action: 'reboot' }]
    })
    await rebootSeq.init()
    assert.equal(rebootSeq.supportsPhase('ON'), false, 'unsupported host action is dropped')

    //  Host step without a target is dropped too.
    const noTargetSeq = new SequenceBase('No Target Step', {
        on: [{ kind: 'host_command', action: 'shutdown' }]
    })
    await noTargetSeq.init()
    assert.equal(noTargetSeq.supportsPhase('ON'), false, 'host step without a target is dropped')

    console.log('Host command sequence step tests passed')
} finally {
    await HostCommandService.cleanup()
    await MqttService.disconnect()
    mock.restoreAll()
    delete process.env.HTPC_TEST_SECRET
}
