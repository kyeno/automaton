/** Redis outage coverage: readiness, offline races, real command deadlines, shutdown. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { mock } from 'node:test'
import { createClient } from 'redis'
import CacheService from '../src/service/cacheService.js'
import LoggerService from '../src/service/loggerService.js'
import StateService from '../src/service/stateService.js'

for (const level of ['info', 'warn', 'error', 'debug']) mock.method(Object.getPrototypeOf(LoggerService), level, () => {})
let options
const fake = new EventEmitter()
fake.isOpen = true
fake.isReady = false
fake.connect = async () => { fake.emit('connect') }
fake.withAbortSignal = () => fake
fake.destroy = () => { fake.isOpen = false; fake.emit('end') }
fake.quit = async () => { throw new Error('quit must not run while reconnecting') }
let commands = 0
fake.get = fake.set = fake.del = async () => { commands++; throw new Error('offline race') }
try {
    await CacheService.init({ createClientFn: (config) => { options = config; return fake } })
    assert.equal(options.disableOfflineQueue, true, 'commands cannot survive an outage as queued writes')
    assert.ok(options.commandOptions.timeout > 0, 'all commands have a deadline')
    assert.equal(StateService.get('redis.connected'), false, 'TCP connect is not Redis readiness')
    assert.equal(CacheService.isConnected(), false)
    const operations = () => Promise.all([
        CacheService.get('test'), CacheService.set('test', {}), CacheService.delete('test'),
        CacheService.setHumanCooldown('test', 60), CacheService.getHumanCooldownRemaining('test'),
    ])
    assert.deepEqual(await operations(), [undefined, false, false, false, null])
    assert.equal(commands, 0, 'unready clients are never called')
    fake.isReady = true
    fake.emit('ready')
    assert.equal(StateService.get('redis.connected'), true)
    assert.deepEqual(await operations(), [undefined, false, false, false, null], 'race-time rejections preserve fail-open API')
    assert.equal(commands, 5)
    fake.isReady = false
    fake.emit('reconnecting')
    assert.equal(StateService.get('redis.connected'), false)
    await CacheService.disconnect()
    assert.equal(fake.isOpen, false, 'shutdown destroys a reconnecting client without waiting for quit')

    // Exercise the installed Redis client's actual command queue against a local RESP server.
    const sockets = new Set()
    let stall = false
    const server = net.createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        let buffer = ''
        socket.on('data', (chunk) => {
            buffer += chunk.toString()
            while (buffer) {
                const header = /^\*(\d+)\r\n/.exec(buffer)
                if (!header) return
                let cursor = header[0].length
                const args = []
                for (let i = 0; i < Number(header[1]); i++) {
                    const length = /^\$(\d+)\r\n/.exec(buffer.slice(cursor))
                    if (!length) return
                    cursor += length[0].length
                    const size = Number(length[1])
                    if (buffer.length < cursor + size + 2) return
                    args.push(buffer.slice(cursor, cursor + size))
                    cursor += size + 2
                }
                buffer = buffer.slice(cursor)
                if (stall && args[0].toUpperCase() !== 'CLIENT') continue
                const command = args[0].toUpperCase()
                socket.write(command === 'GET' ? '$-1\r\n' : command === 'DEL' ? ':1\r\n' : '+OK\r\n')
            }
        })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
        await CacheService.init({ createClientFn: (config) => createClient({
            ...config, url: `redis://127.0.0.1:${server.address().port}`,
            socket: { reconnectStrategy: false },
        }) })
        assert.equal(CacheService.isConnected(), true)
        assert.equal(await CacheService.set('healthy', { ok: true }), true)
        assert.equal(await CacheService.delete('healthy'), true)
        stall = true
        const start = Date.now()
        assert.deepEqual(await operations(), [undefined, false, false, false, null])
        assert.ok(Date.now() - start < options.commandOptions.timeout + 1500, 'unresponsive server cannot block cache callers indefinitely')
        stall = false
        const recoveryStarted = Date.now()
        while (!CacheService.isConnected() && Date.now() - recoveryStarted < 4000) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.equal(CacheService.isConnected(), true, 'stalled connection automatically recovers')
        assert.equal(await CacheService.set('recovered', { ok: true }), true)
        stall = true
        const shutdownStarted = Date.now()
        await CacheService.disconnect()
        assert.ok(Date.now() - shutdownStarted < options.commandOptions.timeout + 1500, 'unresponsive quit is bounded')
        assert.equal(CacheService.isConnected(), false)
    } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => server.close(resolve))
    }
    console.log('Redis outage and command deadline regressions passed')
} finally {
    await CacheService.disconnect()
    mock.restoreAll()
}
