/** Regression coverage for MQTT retries, retired clients, and shutdown races. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock } from 'node:test'
import MqttService from '../src/service/mqttService.js'
import LoggerService from '../src/service/loggerService.js'
import StateService from '../src/service/stateService.js'

for (const level of ['info', 'warn', 'error', 'debug']) mock.method(Object.getPrototypeOf(LoggerService), level, () => {})
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
const clients = []
const factory = () => {
    const client = new EventEmitter()
    client.connected = false
    client.ended = 0
    client.topics = []
    client.published = []
    client.subscribe = (topic, callback) => { client.topics.push(topic); callback?.() }
    client.unsubscribe = () => {}
    client.publish = (...args) => client.published.push(args)
    client.end = (_force, callback) => { client.ended++; client.connected = false; client.emit('close'); callback?.() }
    clients.push(client)
    return client
}
const connect = (client) => { client.connected = true; client.emit('connect') }
const fail = (client) => { client.connected = false; client.emit('error', new Error('connection lost')); client.emit('close'); client.emit('close') }
const settle = async () => { await Promise.resolve(); await Promise.resolve() }

try {
    const initial = MqttService.init({ connectFn: factory })
    connect(clients[0])
    await initial
    let messages = 0
    MqttService.subscribe('test/device', () => messages++)
    let reconnects = 0
    MqttService.onReconnect(() => { reconnects++ })
    MqttService.onReconnect(() => { throw new Error('bad observer') })
    let healthyObserver = 0
    MqttService.onReconnect(() => { healthyObserver++ })

    fail(clients[0])
    assert.equal(StateService.get('mqtt.connected'), false)
    mock.timers.tick(999)
    assert.equal(clients.length, 1)
    mock.timers.tick(1)
    assert.equal(clients.length, 2, 'one failed connection creates exactly one replacement')
    assert.equal(clients[0].ended, 1, 'retired client is forcibly ended')
    connect(clients[1])
    connect(clients[1])
    assert.equal(reconnects, 1, 'observers run once, only after successful connection')
    assert.equal(healthyObserver, 1, 'one failing observer does not stop other observers')
    for (const event of ['connect', 'error', 'close', 'offline', 'message']) {
        assert.equal(clients[1].listenerCount(event), 1, `one ${event} handler per replacement`)
    }
    assert.deepEqual(clients[1].topics, ['test/device'], 'subscriptions restored once')
    clients[1].emit('message', 'test/device', Buffer.from('{"state":"ON"}'))
    clients[0].emit('message', 'test/device', Buffer.from('{"state":"OFF"}'))
    clients[0].emit('offline')
    clients[0].emit('close')
    clients[0].emit('error', new Error('obsolete error'))
    clients[0].emit('connect')
    assert.equal(messages, 1, 'obsolete client messages are ignored')
    assert.equal(StateService.get('mqtt.connected'), true, 'obsolete lifecycle events cannot change status')
    mock.timers.tick(30_000)
    assert.equal(clients.length, 2, 'obsolete events cannot reconnect')
    MqttService.publish('test/output', 'ok')
    assert.equal(clients[1].published.length, 1, 'replacement dispatches outgoing messages')

    fail(clients[1])
    mock.timers.tick(1_000)
    assert.equal(clients.length, 3)
    fail(clients[2])
    await settle()
    mock.timers.tick(1_999)
    assert.equal(clients.length, 3, 'failed handshake uses next backoff once')
    mock.timers.tick(1)
    assert.equal(clients.length, 4)
    connect(clients[3])
    assert.equal(reconnects, 2)

    // Exhaust the retry budget without a single successful handshake.
    fail(clients[3])
    for (let attempt = 1; attempt <= 15; attempt++) {
        const before = clients.length
        mock.timers.tick(Math.min(1000 * 2 ** (attempt - 1), 30_000))
        assert.equal(clients.length, before + 1)
        fail(clients.at(-1))
        await settle()
    }
    const exhausted = clients.length
    mock.timers.tick(300_000)
    assert.equal(clients.length, exhausted, 'circuit breaker stops exhausted retries')
    MqttService.resetCircuit()
    assert.equal(clients.length, exhausted + 1, 'manual reset starts one replacement')
    connect(clients.at(-1))

    // A pending retry and late events must be harmless after shutdown.
    const last = clients.at(-1)
    fail(last)
    await MqttService.disconnect()
    connect(last)
    last.emit('error', new Error('late shutdown error'))
    mock.timers.tick(300_000)
    assert.equal(clients.length, exhausted + 1, 'shutdown cancels pending retries')
    assert.equal(StateService.get('mqtt.connected'), false)
    MqttService.resetCircuit()
    assert.equal(clients.length, exhausted + 1)

    // Initial handshake failures reject promptly and shutdown cancels their retry.
    const startup = MqttService.init({ connectFn: factory })
    const rejected = assert.rejects(startup, /before handshake/)
    clients.at(-1).emit('close')
    await rejected
    await MqttService.disconnect()
    const finalCount = clients.length
    mock.timers.tick(300_000)
    assert.equal(clients.length, finalCount)
    console.log('MQTT reconnect lifecycle regressions passed')
} finally {
    await MqttService.disconnect()
    mock.timers.reset()
    mock.restoreAll()
}
