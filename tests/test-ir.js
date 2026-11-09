/** Behavioral coverage for named IR commands, localized discovery and sequence pacing. */
'use strict'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import { stringify } from 'yaml'
import ConfigService from '../src/service/configService.js'
import ConfigBase from '../src/service/config/configBase.js'
import CacheService from '../src/service/cacheService.js'
import LoggerService from '../src/service/loggerService.js'
import I18nLoader from '../src/service/i18nLoader.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import Mechanism from '../src/device/type/mechanism.js'
import IRTransmitter from '../src/device/type/irtransmitter.js'
import IRCommandService from '../src/ir/irCommandService.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'
import SequenceBase from '../src/sequence/base/sequenceBase.js'
import InteractionContainer from '../src/interaction/container/interactionContainer.js'
import ToolBuilder from '../src/ai/toolBuilder.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import IRCmd from '../src/ui/commands/irCmd.js'
import { installMemoryCache } from './helpers/memory-cache.js'

await ConfigService.init()
for (const level of ['info', 'warn', 'error', 'debug', 'trace']) mock.method(Object.getPrototypeOf(LoggerService), level, () => {})
const restoreCache = installMemoryCache()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-ir-'))
const file = path.join(dir, 'commands.yaml')
const cfgProto = Object.getPrototypeOf(ConfigService)
const originalGet = cfgProto.get
const originalPath = cfgProto.getConfigPath
mock.method(cfgProto, 'getConfigPath', name => name === 'ir' ? file : originalPath.call(ConfigService, name))
let locale = 'en_US'
mock.method(cfgProto, 'get', (key, fallback) => key === 'locale.language' ? locale : originalGet.call(ConfigService, key, fallback))
const commands = {
    amp_on: { transmitter: 'Test IR', code: 'AQIDBA==' },
    amp_vol_up: { transmitter: 'Test IR', code: 'BQYHCA==' }
}
const english = path.resolve('etc/i18n/en_US/ir.yaml')
const polish = path.resolve('etc/i18n/pl_PL/ir.yaml')
const englishBefore = fs.readFileSync(english, 'utf8')
const polishBefore = fs.readFileSync(polish, 'utf8')
const save = value => fs.writeFileSync(file, typeof value === 'string' ? value : stringify({ commands: value }))
const call = async (name, args) => JSON.parse(await ToolBuilder.execute({ function: { name, arguments: JSON.stringify(args) } }))
let receive
const sent = []
let release
let hold = false
const transmitter = new IRTransmitter('Test IR', 'test-ir', { definition: { exposes: [{ property: 'ir_code_to_send' }] } })
const devices = DeviceContainer.getAll()
devices['Test IR'] = transmitter
transmitter.setMqttService({
    isConnected: () => true,
    getPrefix: () => process.env.MQTT_PREFIX,
    subscribe: (_topic, fn) => { receive = fn; return () => {} },
    publishAsync: async (topic, payload) => {
        if (hold) await new Promise(resolve => { release = resolve })
        sent.push({ topic, payload: JSON.parse(payload), at: Date.now() })
    }
})
try {
    fs.writeFileSync(english, stringify({ commands: { amp_on: { label: 'Turn on amplifier', description: 'Turn on the amplifier' } } }))
    fs.writeFileSync(polish, stringify({ commands: { amp_on: { label: 'Włącz wzmacniacz' } } }))
    await I18nLoader.init()
    save(commands)
    await IRCommandService.init()
    assert.equal(transmitter instanceof Mechanism, true)
    assert.equal(IRCommandService.list().length, 2)
    assert.equal(IRCommandService.search('amplifier').results[0].id, 'amp_on')
    assert.equal(JSON.stringify(IRCommandService.list()).includes('AQIDBA'), false, 'metadata never includes codes')
    const schemaBefore = JSON.stringify(ToolBuilder.build(true))
    const promptBefore = AiAssistant.getEffectiveSystemPrompt()
    const found = await call('find_ir_commands', { query: 'turn on amplifier' })
    assert.equal(found.results[0].id, 'amp_on')
    assert.equal((await call('send_ir_command', { command_id: 'amp_on' })).status, 'dispatched')
    await transmitter.receiveCommand({ ir_command: 'amp_on' }, DeviceCommandSource.AUTOMATION)
    assert.equal(sent.length, 2, 'identical IR commands are never suppressed')
    assert.deepEqual(sent[0].payload, { ir_code_to_send: 'AQIDBA==' })
    assert.equal(sent[0].topic, `${process.env.MQTT_PREFIX}/Test IR/set`)
    assert.equal(await CacheService.get(`${transmitter.getCacheKey()}:pending`), null, 'no state confirmation token')
    assert.equal(transmitter.getStateLast().state, undefined, 'no fabricated appliance state')
    receive(`${process.env.MQTT_PREFIX}/Test IR`, JSON.stringify({ battery: 85, learned_ir_code: 'AQIDBA==' }))
    assert.equal(transmitter.getStateLast().battery, 85, 'incoming Zigbee telemetry remains available')
    assert.equal(transmitter.getStateLast().learned_ir_code, 'AQIDBA==')
    await assert.rejects(transmitter.receiveCommand('ON'), /expects/)
    await assert.rejects(IRCommandService.send('amp_on', { transmitter: 'Other IR' }), /belongs/)
    const missingProtocol = new IRTransmitter('Unknown', 'unknown', {})
    await assert.rejects(missingProtocol.transmit('AQIDBA=='), /ir_send_property/)
    const custom = new IRTransmitter('Custom', 'custom', { ir_send_property: 'send_code' })
    assert.equal(custom.getSendProperty(), 'send_code')
    assert.equal((await call('set_device_state', { device_name: 'Test IR', action: 'ON' })).error.includes('send_ir_command'), true)
    const count = sent.length
    assert.equal((await call('unknown_tool', { device_name: 'Test IR', action: 'ON' })).error.includes('Unknown tool'), true)
    assert.equal(sent.length, count)
    assert.equal((await call('send_ir_command', { command_id: 'invented' })).status, 'rejected')
    assert.equal((await call('find_ir_commands', null)).error, 'Arguments must be an object')
    assert.equal(IRCommandService.search('', 1).has_more, true, 'bounded search indicates remaining candidates')
    assert.equal(IRCommandService.search('', 1).results.length, 1)
    delete devices['Test IR']
    await assert.rejects(IRCommandService.send('amp_on'), /unavailable/, 'offline transmitters produce an explicit error')
    devices['Test IR'] = transmitter

    locale = 'pl_PL'
    await I18nLoader.reload()
    assert.equal(IRCommandService.get('amp_on').label, 'Włącz wzmacniacz')
    assert.equal(IRCommandService.get('amp_on').description, 'Turn on the amplifier', 'per-field English fallback')
    assert.equal(IRCommandService.search('wlacz wzmacniacz').results[0].id, 'amp_on', 'diacritic-insensitive discovery')
    assert.equal(IRCommandService.get('amp_vol_up').label, 'amp_vol_up', 'ID fallback')
    locale = 'en_US'
    await I18nLoader.reload()

    save({ ...commands, amp_off: { transmitter: 'Test IR', code: 'CQoLDA==' } })
    assert.equal((await IRCommandService.reload()).loaded, 3)
    assert.equal(JSON.stringify(ToolBuilder.build()), schemaBefore, 'catalog growth does not expand tools')
    assert.equal(AiAssistant.getEffectiveSystemPrompt(), promptBefore, 'catalog growth does not expand system prompt')
    for (const invalid of [
        'commands:\n  same: {}\n  same: {}\n',
        { bad: { transmitter: 'Test IR', code: 'not base64!' } },
        { bad: { code: 'AQIDBA==' } },
        { 'Bad ID': { transmitter: 'Test IR', code: 'AQIDBA==' } }
    ]) {
        save(invalid)
        assert.equal((await IRCommandService.reload()).ok, false)
        assert.equal(IRCommandService.list().length, 3, 'bad reload preserves entire previous catalog')
    }
    fs.writeFileSync(file, 'commands: [')
    assert.equal((await IRCommandService.reload()).ok, false)
    save(commands)
    await IRCommandService.reload()
    assert.equal(IRCommandService.get('amp_off'), null, 'removed IDs disappear on reload')
    save({ bad: { transmitter: 'Test IR', code: '!' } })
    await assert.rejects(new ConfigBase(file, 'ir').ensureValidated(), /Base64/)
    save(commands)

    const printed = []
    const ui = new IRCmd({ print: line => printed.push(line) })
    await ui.execute('show amp_on')
    await ui.execute('send amp_on')
    assert.equal(printed.some(line => line.includes('dispatched')), true)
    assert.equal(printed.join('\n').includes('AQIDBA'), false)
    assert.equal(ui.completeNextToken(['send']).includes('amp_on'), true)
    InteractionContainer.registerInteractionConfig({ name: 'test_ir_button', actions: [
        { type: 'single', targets: [{ device: 'Test IR', command: { ir_command: 'amp_vol_up' } }] }
    ] })
    await InteractionContainer.callInteraction('test_ir_button', { action: 'single' })
    assert.deepEqual(sent.at(-1).payload, { ir_code_to_send: 'BQYHCA==' })

    const sourceCalls = []
    const originalReceive = transmitter.receiveCommand.bind(transmitter)
    mock.method(transmitter, 'receiveCommand', (command, source) => {
        sourceCalls.push(source)
        return originalReceive(command, source)
    })
    const sequence = new SequenceBase('IR Cinema', {
        delay: '20ms',
        on: [
            { device: 'Test IR', payload: { ir_command: 'amp_on' } },
            { device: 'Test IR', payload: { ir_command: 'amp_vol_up' } }
        ],
        off: [{ device: 'Test IR', payload: { ir_command: 'amp_on' } }, { device: 'Test IR', payload: { ir_command: 'amp_vol_up' } }]
    })
    await sequence.init()
    hold = true
    const startCount = sent.length
    const running = sequence.run('ON', { source: DeviceCommandSource.HUMAN })
    await Promise.resolve()
    assert.equal(sent.length, startCount, 'sequence awaits local dispatch')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(sent.length, startCount, 'next step cannot overtake queued IR send')
    hold = false
    release()
    assert.equal(await running, true)
    assert.equal(sent.length, startCount + 2)
    assert.ok(sent.at(-1).at - sent.at(-2).at >= 15, 'delay starts after local dispatch')
    assert.deepEqual(sourceCalls.slice(-2), [DeviceCommandSource.HUMAN, DeviceCommandSource.HUMAN])
    await sequence.run('OFF')
    assert.ok(sent.at(-1).at - sent.at(-2).at >= 15, 'same static delay applies to OFF')
    assert.deepEqual(sourceCalls.slice(-2), [DeviceCommandSource.AUTOMATION, DeviceCommandSource.AUTOMATION])
    assert.equal(sequence.getLastRunResult().status, 'completed')
    const oneWay = new SequenceBase('One Way', { on: [{ device: 'Test IR', payload: { ir_command: 'amp_on' } }] })
    await oneWay.init()
    assert.equal(oneWay.supportsPhase('OFF'), false)
    assert.equal(await oneWay.run('OFF'), false, 'no invented inverse for IR')
    const partial = new SequenceBase('Partial', { on: [{ device: 'Missing' }, { device: 'Test IR', payload: { ir_command: 'invented' } }] })
    await partial.init()
    await partial.run('ON')
    assert.equal(partial.getLastRunResult().status, 'partial_failure')
    assert.equal(partial.getLastRunResult().failed.length, 2)
    assert.equal(ToolBuilder.build(true).some(tool => tool.function.name.includes('sequence')), false)
    console.log('IR catalog, UI, Zigbee telemetry, AI discovery and sequence engine regressions passed')
} finally {
    transmitter.cleanup()
    delete devices['Test IR']
    fs.writeFileSync(english, englishBefore)
    fs.writeFileSync(polish, polishBefore)
    fs.rmSync(dir, { recursive: true, force: true })
    restoreCache()
    mock.restoreAll()
}
