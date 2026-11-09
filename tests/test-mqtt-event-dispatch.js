/** Awaitable MQTT events expire without replay and settle on dispatch, failure and shutdown. */
'use strict'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock } from 'node:test'
import MqttService from '../src/service/mqttService.js'
import LoggerService from '../src/service/loggerService.js'

for (const level of ['info', 'warn', 'error', 'debug']) mock.method(Object.getPrototypeOf(LoggerService), level, () => {})
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
const client = new EventEmitter()
client.connected = false
const sent = []
client.publish = (...args) => sent.push(args)
client.subscribe = (_topic, callback) => callback?.()
client.end = (_force, callback) => { client.connected = false; callback?.() }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
try {
    const ready = MqttService.init({ connectFn: () => client })
    client.connected = true
    client.emit('connect')
    await ready
    await MqttService.publishAsync('test/ir', 'first')
    assert.equal(sent.length, 1)
    assert.equal(sent[0][2].retain, false)
    assert.equal('meta' in sent[0][2], false)
    client.connected = false
    const expired = assert.rejects(MqttService.publishAsync('test/ir', 'expired', 25), /timed out/)
    mock.timers.tick(25)
    await expired
    client.connected = true
    mock.timers.tick(2000)
    await settle()
    assert.equal(sent.some(args => args[1] === 'expired'), false, 'expired event never replays after reconnect')
    const publish = client.publish
    client.publish = () => { throw new Error('local publish failure') }
    await assert.rejects(MqttService.publishAsync('test/ir', 'bad'), /local publish failure/)
    client.publish = publish
    client.connected = false
    const shutdown = assert.rejects(MqttService.publishAsync('test/ir', 'pending'), /shut down/)
    await MqttService.disconnect()
    await shutdown
    await assert.rejects(MqttService.publishAsync('test/ir', 'late'), /shutting down/)
    console.log('Awaitable MQTT event dispatch regressions passed')
} finally {
    await MqttService.disconnect()
    mock.timers.reset()
    mock.restoreAll()
}
