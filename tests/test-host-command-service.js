/** Trusted-LAN v2 shutdown dispatch, ACK correlation and sequence integration. */
'use strict'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock } from 'node:test'
import HostCommandService from '../src/host/hostCommandService.js'
import MqttService from '../src/service/mqttService.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import SequenceBase from '../src/sequence/base/sequenceBase.js'

const SECRET = 'disposable-test-key'
const CMD_TOPIC = 'automaton/host/htpc/command'
const ACK_TOPIC = 'automaton/host/htpc/ack'
const ackFor = (command, status = 'accepted') => ({ v: 2, id: command.id, target: command.target, status })
for (const level of ['info', 'warn', 'error', 'debug']) mock.method(Object.getPrototypeOf(LoggerService), level, () => {})
const client = new EventEmitter()
const published = []
client.connected = false
client.publish = (topic, payload, options, callback) => {
    published.push({ topic, payload: JSON.parse(String(payload)), options })
    callback?.()
}
client.subscribe = (_topic, callback) => callback?.()
client.unsubscribe = (_topic, callback) => callback?.()
client.end = (_force, callback) => { client.connected = false; callback?.() }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const deliver = (frame, topic = ACK_TOPIC, packet = {}) => client.emit('message', topic, Buffer.from(JSON.stringify(frame)), packet)
process.env.HTPC_TEST_SECRET = SECRET
let hostSection = { enabled: true, targets: {
    htpc: { secret_env: 'HTPC_TEST_SECRET', ack_timeout: '100ms' },
    htpc2: { secret_env: 'HTPC_TEST_SECRET', ack_timeout: '100ms' }
} }
mock.method(Object.getPrototypeOf(ConfigService), 'getSection', key => key === 'host_commands' ? hostSection : undefined)
const ready = MqttService.init({ connectFn: () => client })
client.connected = true
client.emit('connect')
await ready
await HostCommandService.init()
try {
    assert.equal(HostCommandService.listTargets().length, 2)
    assert.equal(JSON.stringify(HostCommandService.listTargets()).includes(SECRET), false)
    const running = HostCommandService.requestShutdown('htpc')
    await settle()
    const { payload: command, options } = published.at(-1)
    assert.equal(command.v, 2)
    assert.equal(command.key, SECRET)
    assert.deepEqual(Object.keys(command).sort(), ['action', 'id', 'key', 'target', 'v'])
    assert.deepEqual(options, { qos: 0, retain: false })
    let completed = false
    running.then(() => { completed = true })
    deliver({ ...ackFor(command), v: 1 })
    deliver({ ...ackFor(command), target: 'htpc2' }, 'automaton/host/htpc2/ack')
    deliver(ackFor(command), ACK_TOPIC, { retain: true })
    await settle()
    assert.equal(completed, false)
    deliver(ackFor(command))
    assert.equal((await running).status, 'accepted')
    deliver(ackFor(command))
    const second = HostCommandService.requestShutdown('htpc2')
    const command2 = published.at(-1).payload
    assert.notEqual(command.id, command2.id)
    deliver(ackFor(command2), 'automaton/host/htpc2/ack')
    assert.equal((await second).target, 'htpc2')
    const originalPublish = client.publish
    client.publish = () => { throw new Error('transport internals must not escape') }
    const failure = await HostCommandService.requestShutdown('htpc')
    assert.equal(failure.status, 'failed')
    assert.equal(failure.reason, 'MQTT control publish failed')
    client.publish = originalPublish
    assert.equal((await HostCommandService.requestShutdown('unknown')).status, 'failed')
    assert.equal((await HostCommandService.requestShutdown('htpc', { action: 'shell' })).status, 'failed')
    const timeout = await HostCommandService.requestShutdown('htpc')
    assert.equal(timeout.status, 'timeout')
    const inflight = HostCommandService.requestShutdown('htpc')
    await HostCommandService.reload()
    assert.equal((await inflight).status, 'failed')
    const count = published.length
    client.connected = false
    assert.equal((await HostCommandService.requestShutdown('htpc')).status, 'failed')
    assert.equal(published.length, count)
    client.connected = true
    hostSection.enabled = false
    await HostCommandService.reload()
    assert.equal((await HostCommandService.requestShutdown('htpc')).status, 'failed')
} finally {
    await HostCommandService.cleanup()
    await MqttService.disconnect()
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
