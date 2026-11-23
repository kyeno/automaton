/** Headless control authentication, duplicate delivery, policy and completion. */
'use strict'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { SControlService } from '../src/control/controlService.js'
import ConfigService from '../src/service/configService.js'
import MqttService from '../src/service/mqttService.js'
import IRCommandService from '../src/ir/irCommandService.js'
import SequenceContainer from '../src/sequence/container/sequenceContainer.js'
import RoomOccupancy from '../src/service/roomOccupancy.js'
import IRCommand from '../src/commands/irCommand.js'
import SequenceCommand from '../src/commands/sequenceCommand.js'
import OccupancyCommand from '../src/commands/occupancyCommand.js'
import { validateConfig } from '../src/validators/main.js'
import { RequestCache } from '../src/control/controlProtocol.js'

process.env.CONTROL_TEST_KEY = 'disposable-key'
let config = { enabled: true, secret_env: 'CONTROL_TEST_KEY', commands: {
    ir: ['list', 'show', 'send'], sequence: ['run'], occupancy: ['set']
} }
let connected = true
let handler
const replies = []
const sent = []
const proto = value => Object.getPrototypeOf(value)
mock.method(proto(ConfigService), 'getSection', () => config)
mock.method(proto(MqttService), 'isConnected', () => connected)
mock.method(proto(MqttService), 'subscribe', (_topic, callback, options) => {
    assert.equal(options.dedupe, false)
    handler = callback
    return () => { handler = null }
})
mock.method(proto(MqttService), 'publishControl', async (topic, frame) => replies.push({ topic, ...frame }))
mock.method(proto(IRCommandService), 'send', async id => { sent.push(id); return { status: 'dispatched' } })
mock.method(proto(IRCommandService), 'list', () => [{ id: 'avr_on', label: 'AVR', transmitter: 'test' }])
mock.method(proto(IRCommandService), 'get', () => null)
mock.method(proto(SequenceContainer), 'getNames', () => ['home_cinema'])
mock.method(proto(SequenceContainer), 'resolveSequence', () => ({ getSlug: () => 'home_cinema', getName: () => 'Cinema', getLastRunResult: () => ({ status: 'completed' }), supportsLoop: () => false }))
mock.method(proto(SequenceContainer), 'callCommand', async (_slug, phase) => { sent.push(phase); return true })
mock.method(proto(RoomOccupancy), 'getRooms', () => [{ id: '1', name: 'Living room' }])
mock.method(proto(RoomOccupancy), 'set', async (room, duration) => sent.push(`${room}:${duration}`))
const service = new SControlService()
await service.init()
assert.equal(typeof handler, 'function')
const frame = overrides => ({ v: 2, id: randomUUID(), key: 'disposable-key', command: 'ir', args: 'send avr_on', ...overrides })
const deliver = (data, packet = {}) => service.handle(JSON.stringify(data), packet)
await service.handle('not json')
await deliver(frame({ key: 'wrong' }))
await deliver(frame({ v: 1 }))
await deliver(frame({}), { retain: true })
assert.equal(sent.length, 0)
const first = frame({})
await Promise.all([deliver(first), deliver(first)])
assert.deepEqual(sent, ['avr_on'])
assert.equal(replies.at(-1).status, 'ok')
assert.equal(JSON.stringify(replies).includes('disposable-key'), false)
await deliver(frame({}))
assert.equal(sent.length, 2, 'two volume-style clicks with distinct IDs both execute')
await deliver(frame({ command: 'device', args: 'shutdown' }))
assert.equal(replies.at(-1).status, 'rejected')
await deliver(frame({ command: 'sequence', args: 'loop start home_cinema' }))
assert.equal(replies.at(-1).status, 'rejected')
await deliver(frame({ command: 'sequence', args: 'run home_cinema off' }))
assert.equal(sent.at(-1), 'OFF')
await deliver(frame({ command: 'occupancy', args: 'set 1 30m' }))
assert.equal(sent.at(-1), '1:30m')
await deliver(frame({ args: 'show missing' }))
assert.equal(replies.at(-1).status, 'failed')
assert.deepEqual(new IRCommand({}).completeNextToken(['send']), ['avr_on'])
assert.deepEqual(new SequenceCommand({ sequenceContainer: SequenceContainer }).completeNextToken(['run']), ['home_cinema'])
assert.deepEqual(new OccupancyCommand({}).completeNextToken(['set']), ['1'])
assert.ok(new OccupancyCommand({}).completeNextToken(['set', '1']).includes('30m'))
connected = false
const count = sent.length
await deliver(frame({}))
assert.equal(sent.length, count)
connected = true
config = { enabled: false }
await service.reload()
await deliver(frame({}))
assert.equal(sent.length, count)
assert.deepEqual(validateConfig({ mqtt_control: { enabled: true, secret_env: 'CONTROL_TEST_KEY', commands: { ir: ['send'] } } }), [])
assert.ok(validateConfig({ mqtt_control: { enabled: true, commands: { system: ['shell'] } } }).length)
assert.ok(validateConfig({ mqtt_control: { topic_base: 'automaton/host' } }).length)
service.cleanup()
const cache = new RequestCache()
const firstId = randomUUID()
assert.equal(cache.claim(firstId), true)
assert.equal(cache.claim(firstId), false)
assert.equal(cache.claim('bad-id'), false)
for (let i = 1; i < 4096; i++) assert.equal(cache.claim(randomUUID()), true)
assert.equal(cache.claim(randomUUID()), false, 'capacity must not evict a live duplicate guard')
console.log('Headless MQTT control passed')