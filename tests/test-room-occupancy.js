/**
 * Passive Redis occupancy API, command and playback rule regressions.
 * @license AGPL-3.0-only
 */
'use strict'

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { stringify } from 'yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import RoomOccupancy from '../src/service/roomOccupancy.js'
import OccupancyCmd from '../src/ui/commands/occupancyCmd.js'
import CommandContainer from '../src/ui/commands/container/commandContainer.js'
import EventBus from '../src/service/eventBus.js'
import videoPlayerMonitor from '../src/monitor/videoPlayerMonitor.js'
import HomeTheaterAutomation from '../etc/automation/homeTheaterBase.js'
import { evaluateRule } from '../src/lib/ruleCoverage.js'
import { validateConfig } from '../src/validators/main.js'

await ConfigService.init()
LoggerService.init()
const restores = []
function patch(instance, key, replacement) {
    const proto = Object.getPrototypeOf(instance)
    const original = proto[key]
    proto[key] = replacement
    restores.push(() => { proto[key] = original })
}
const rooms = { 1: { name: 'Example room' }, 40: { name: 'Another room' } }
const originalGet = Object.getPrototypeOf(ConfigService).get
patch(ConfigService, 'get', function(key, fallback) {
    return key === 'occupancy.rooms' ? rooms : originalGet.call(this, key, fallback)
})
const entries = new Map()
const fake = new EventEmitter()
fake.isReady = true
fake.isOpen = true
fake.connect = async () => {}
fake.quit = async () => { fake.isOpen = false }
fake.withAbortSignal = () => fake
let readError = false
let writeError = false
let deleteError = false
fake.get = async key => {
    if (readError) throw new Error('read failed')
    const entry = entries.get(key)
    if (!entry || entry.expiresAt <= Date.now()) return null
    return entry.value
}
fake.set = async (key, value, options) => {
    if (writeError) throw new Error('write failed')
    entries.set(key, { value, ttl: options.EX, expiresAt: Date.now() + options.EX * 1000 })
}
fake.del = async key => {
    if (deleteError) throw new Error('delete failed')
    return entries.delete(key) ? 1 : 0
}
let player = 'playing'
patch(videoPlayerMonitor, 'getStatus', async () => player)
const dir = mkdtempSync(join(tmpdir(), 'automaton-occupancy-'))
let auto
try {
    await CacheService.init({ createClientFn: () => fake })
    assert.equal(await CacheService.getStrict('absent'), undefined)
    assert.equal((await RoomOccupancy.get(1)).occupied, false)
    const tokens = RoomOccupancy.getDurations()
    const seconds = [1800, 2700, 3600, 5400, 7200, 10800]
    for (const [index, token] of tokens.entries()) {
        await RoomOccupancy.set(1, token)
        assert.equal(entries.get('occupancy:room:1').ttl, seconds[index])
        const status = await RoomOccupancy.get('1')
        assert.equal(status.occupied, true)
        assert.equal(status.remainingSeconds, seconds[index])
    }
    await RoomOccupancy.set(1, '30m')
    assert.equal((await RoomOccupancy.get(1)).remainingSeconds, 1800, 'replace, do not extend')
    assert.equal((await RoomOccupancy.get(40)).occupied, false, 'rooms are independent')
    assert.deepEqual((await RoomOccupancy.list()).map(room => room.occupied), [true, false])
    // Reconnecting the application cache does not discard the Redis assertion.
    await CacheService.init({ createClientFn: () => fake })
    assert.equal((await RoomOccupancy.get(1)).occupied, true)
    await RoomOccupancy.clear(1)
    await RoomOccupancy.clear(1) // Clearing absent assertions succeeds.
    for (const id of [0, -1, 2, '01', '1:other']) await assert.rejects(RoomOccupancy.get(id), /Unknown/)
    for (const value of ['forever', '0m', '4h', '__proto__']) await assert.rejects(RoomOccupancy.set(1, value), /Duration/)
    assert.equal(validateConfig({ occupancy: { rooms } }).length, 0)
    for (const occupancy of [null, [], { unknown: true }, { rooms: [] },
        { rooms: { 0: { name: 'Invalid' } } }, { rooms: { 1: { name: '' } } },
        { rooms: { 1: { name: 'Room', typo: true } } }]) {
        assert.ok(validateConfig({ occupancy }).length > 0)
    }

    const output = []
    const command = new OccupancyCmd({ print: text => output.push(text) })
    assert.deepEqual(command.completeNextToken([]), ['list', 'show', 'set', 'clear'])
    assert.deepEqual(command.completeNextToken(['set']), ['1', '40'])
    assert.deepEqual(command.completeNextToken(['set', '1']), tokens)
    await command.execute('set 1 45m')
    await command.execute('show 1')
    assert.match(output.at(-1), /Room 1 \(Example room\): occupied/)
    await command.execute('list')
    assert.match(output.at(-1), /Room 40.*no active/)
    await command.execute('clear 1')
    assert.equal((await RoomOccupancy.get(1)).occupied, false)
    await command.execute('set 1 4h')
    assert.match(output.at(-1), /failed/)
    await command.execute('set 1')
    assert.match(output.at(-1), /Usage/)
    await CommandContainer.init({ print: text => output.push(text) })
    assert.ok(CommandContainer.getCommand('occupancy'), 'command is auto-discovered')

    const configPath = join(dir, 'playback.yaml')
    const inactive = { occupancy: { room: { 1: false } } }
    const active = { occupancy: { room: { 1: true } } }
    writeFileSync(configPath, stringify({
        override_human_interaction: true, trigger_on_change_only: true,
        triggers_video: ['example-player'],
        rules: [
            { name: 'Other lights', conditions: { video_player: { 'example-player': ['playing'] } }, targets: { Other: 'OFF' } },
            { name: 'Protected lights', conditions: { video_player: { 'example-player': ['playing'] }, ...inactive }, targets: { Protected: 'OFF' } },
        ],
    }))
    const makeDevice = name => ({ calls: [], getName: () => name,
        receiveCommand(payload) { this.calls.push(payload) } })
    const other = makeDevice('Other')
    const protectedLight = makeDevice('Protected')
    class Harness extends HomeTheaterAutomation {
        constructor() { super({ name: 'OccupancyPlayback', configPath }) }
        loadDevices() { return new Map([['Other', other], ['Protected', protectedLight]]) }
        async buildContext() { return {} }
    }
    auto = new Harness()
    await auto.init()
    await RoomOccupancy.set(1, '1h')
    assert.equal(auto.getRecentAutomationCalls().length, 0, 'setting occupancy is passive')
    assert.equal(await auto.conditionsMatch(active, {}), true)
    assert.equal(await auto.conditionsMatch(inactive, {}), false)
    assert.match(await auto.explainRuleMiss(inactive, {}), /occupancy/)
    assert.equal(await auto.conditionsMatch({ all_of: [active] }, {}), true)
    assert.equal(await auto.conditionsMatch({ any_of: [inactive, active] }, {}), true)
    assert.equal(await auto.conditionsMatch({ occupancy: { room: { 1: true, 40: false } } }, {}), true)
    assert.equal(await auto.conditionsMatch({ occupancy: { room: { 1: false, 40: false } } }, {}), false)
    assert.equal(evaluateRule(inactive, {}), true, 'static coverage does not simulate manual state')
    EventBus.publish('videoPlayer:example-player')
    await sleep(450)
    assert.deepEqual(other.calls, [{ state: 'OFF' }])
    assert.deepEqual(protectedLight.calls, [])
    assert.equal(auto.getRecentAutomationCalls().length, 1)
    player = 'paused'
    EventBus.publish('videoPlayer:example-player')
    await sleep(450)
    assert.deepEqual(protectedLight.calls, [])
    player = 'playing'
    EventBus.publish('videoPlayer:example-player')
    await sleep(450)
    assert.deepEqual(protectedLight.calls, [], 'pause/play preserves occupied room')
    const runs = auto.getRecentAutomationCalls().length
    await RoomOccupancy.clear(1)
    await sleep(300)
    assert.equal(auto.getRecentAutomationCalls().length, runs, 'clear does not trigger evaluation')
    await RoomOccupancy.set(1, '30m')
    entries.set('occupancy:room:1', { value: JSON.stringify({ expiresAt: Date.now() - 1 }), expiresAt: Infinity })
    assert.equal((await RoomOccupancy.get(1)).occupied, false, 'explicit expiry protects against stale data')
    entries.set('occupancy:room:40', { value: JSON.stringify({ expiresAt: Date.now() + 60000 }), expiresAt: Date.now() - 1 })
    assert.equal((await RoomOccupancy.get(40)).occupied, false, 'expired Redis keys are inactive')
    await sleep(300)
    assert.equal(auto.getRecentAutomationCalls().length, runs, 'expiry does not trigger evaluation')
    EventBus.publish('videoPlayer:example-player')
    await sleep(450)
    assert.deepEqual(protectedLight.calls, [{ state: 'OFF' }], 'next normal event resumes shutdown')
    for (const spec of [null, {}, [], { room: {} }, { room: { 1: 1 } }, { room: { 2: false } }, { room: { 1: false }, typo: true }]) {
        await assert.rejects(auto.conditionsMatch({ occupancy: spec }, {}))
    }
    entries.set('occupancy:room:1', { value: 'bad json', expiresAt: Infinity })
    await assert.rejects(RoomOccupancy.get(1))
    entries.set('occupancy:room:1', { value: JSON.stringify({ expiresAt: 'forever' }), expiresAt: Infinity })
    await assert.rejects(RoomOccupancy.get(1), /Invalid stored/)
    entries.clear()
    readError = true
    await assert.rejects(RoomOccupancy.get(1), /read failed/)
    await assert.rejects(auto.conditionsMatch(inactive, {}), /read failed/)
    protectedLight.calls.length = 0
    await auto.execute({ trigger: 'test' })
    assert.deepEqual(protectedLight.calls, [], 'read failure cannot extinguish protected light')
    await command.execute('show 1')
    assert.match(output.at(-1), /failed/)
    readError = false
    writeError = true
    await command.execute('set 1 30m')
    assert.match(output.at(-1), /failed/)
    writeError = false
    deleteError = true
    await command.execute('clear 1')
    assert.match(output.at(-1), /failed/)
    fake.isReady = false
    await assert.rejects(CacheService.getStrict('absent'), /not connected/)
    assert.equal(await CacheService.get('absent'), undefined, 'legacy fail-open API unchanged')
    console.log('Room occupancy API, command, passive expiry and playback regressions passed')
} catch (error) {
    console.error(error)
    process.exitCode = 1
} finally {
    auto?.cleanup()
    await CacheService.disconnect()
    for (const restore of restores.reverse()) restore()
    rmSync(dir, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)