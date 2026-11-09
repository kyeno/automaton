/** Virtual device dispatch through native and recovered Gemma device calls. */
'use strict'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import { stringify } from 'yaml'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import SequenceContainer from '../src/sequence/container/sequenceContainer.js'
import AutomationContainer from '../src/automation/container/automationContainer.js'
import InteractionContainer from '../src/interaction/container/interactionContainer.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import IRCommandService from '../src/ir/irCommandService.js'
import NetworkPresence from '../src/monitor/networkPresence.js'
import VirtualDeviceService from '../src/ai/virtualDeviceService.js'
import ToolBuilder from '../src/ai/toolBuilder.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'

await ConfigService.init()
for (const level of ['info', 'warn', 'error', 'debug', 'trace']) mock.method(Object.getPrototypeOf(LoggerService), level, () => {})
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-virtual-'))
const file = path.join(directory, 'virtual.yaml')
const originalPath = Object.getPrototypeOf(ConfigService).getConfigPath
mock.method(Object.getPrototypeOf(ConfigService), 'getConfigPath', function (name) {
    return name === 'virtual' ? file : originalPath.call(this, name)
})

const entry = {
    name: 'kino domowe',
    description: 'TV, amplituner i HTPC',
    observations: { htpc_presence: { type: 'network_presence', name: 'htpc' } },
    actions: {
        ON: { type: 'sequence', name: 'home_cinema', phase: 'ON' },
        OFF: { type: 'sequence', name: 'home_cinema', phase: 'OFF' }
    }
}
const write = devices => fs.writeFileSync(file, stringify({ devices }))
const calls = []
const routed = []
let htpcPresence = null
mock.method(Object.getPrototypeOf(NetworkPresence), 'getLastLabel', name => {
    assert.equal(name, 'htpc')
    return htpcPresence
})
const sequence = { getStateSummary: () => ({ active: false }), getLastRunResult: () => ({ status: 'completed', steps: 2 }) }
mock.method(Object.getPrototypeOf(SequenceContainer), 'resolveSequence', name => name === 'home_cinema' ? sequence : null)
mock.method(Object.getPrototypeOf(SequenceContainer), 'callCommand', async (name, phase, context) => {
    calls.push({ name, phase, context })
    return true
})
const invoke = async (name, args) => JSON.parse(await ToolBuilder.execute({ function: { name, arguments: JSON.stringify(args) } }))

try {
    write([entry])
    assert.deepEqual(await VirtualDeviceService.init(), { ok: true, loaded: 1, changed: true })
    assert.equal(ToolBuilder.resolveDevice({ device_name: 'kino domowe' })?.isVirtual(), true)
    assert.equal(ToolBuilder.build(true).some(tool => tool.function.name.includes('sequence')), false)

    const pending = invoke('set_device_state', { device_name: 'kino domowe', action: 'ON' })
    const on = await pending
    assert.equal(on.status, 'completed')
    assert.deepEqual(calls[0], { name: 'home_cinema', phase: 'ON', context: { source: DeviceCommandSource.HUMAN, caller: 'virtual' } })
    const state = await invoke('get_device_state', { device_name: 'kino domowe' })
    assert.equal(state.target_state, 'unknown')
    assert.deepEqual(state.observations, { htpc_presence: 'unknown' })
    assert.equal('sequence' in state, false, 'AI state result hides sequence internals')
    htpcPresence = 'online'
    assert.equal((await invoke('get_device_state', { device_name: 'kino domowe' })).observations.htpc_presence, 'online')
    htpcPresence = 'offline'
    assert.equal((await invoke('get_device_state', { device_name: 'kino domowe' })).observations.htpc_presence, 'offline')
    assert.equal((await invoke('set_device_state', { device_name: 'kino domowe', action: 'OPEN' })).status, 'rejected')
    assert.equal((await invoke('set_device_state', { device_name: 'kino domowe', action: 'ON', position: 50 })).status, 'rejected')
    assert.equal(calls.length, 1)

    const malformed = '<|channel>call:set_device_state{device_name:<|"|>kino domowe<|"|>,action:<|"|>OFF<|"|>}<tool_call|>'
    const intents = ToolBuilder.parseJsonIntent(malformed)
    assert.equal(intents?.length, 1)
    assert.equal(JSON.parse(await ToolBuilder.executeIntent(intents[0])).status, 'completed')
    assert.equal(calls[1].phase, 'OFF')

    assert.equal((await VirtualDeviceService.reload()).changed, false)
    write([{ ...entry, actions: { ON: { type: 'sequence', name: 'home_cinema', phase: 'ON' } } }])
    assert.equal((await VirtualDeviceService.reload()).changed, true)
    assert.equal((await invoke('set_device_state', { device_name: 'kino domowe', action: 'OFF' })).status, 'rejected')
    write([{ ...entry, actions: { ON: { type: 'sequence', name: 'home_cinema', phase: 'INVENTED' } } }])
    assert.equal((await VirtualDeviceService.reload()).ok, false)
    assert.equal(VirtualDeviceService.getAll().length, 1, 'invalid reload preserves registry')
    assert.equal((await invoke('set_device_state', { device_name: 'kino domowe', action: 'ON' })).status, 'completed')
    write([entry, { ...entry, name: 'kino-domowe' }])
    assert.equal((await VirtualDeviceService.reload()).ok, false, 'AI-normalized name collision is rejected')
    assert.equal(VirtualDeviceService.getAll().length, 1)
    write([{ ...entry, observations: { htpc_presence: { type: 'device_method', name: 'htpc' } } }])
    assert.equal((await VirtualDeviceService.reload()).ok, false, 'unsupported observation source is rejected')
    assert.equal(VirtualDeviceService.getAll().length, 1)

    const physical = DeviceContainer.getAll()
    physical['Mock Lamp'] = { receiveCommand: async (command, source) => routed.push({ type: 'device', command, source }) }
    mock.method(Object.getPrototypeOf(AutomationContainer), 'getAutomation', name => name === 'Ambient Lights' ? {} : null)
    mock.method(Object.getPrototypeOf(AutomationContainer), 'callAutomation', async (name, data) => { routed.push({ type: 'automation', name, data }); return true })
    mock.method(Object.getPrototypeOf(InteractionContainer), 'getInteraction', name => name === 'Cinema Button' ? {} : null)
    mock.method(Object.getPrototypeOf(InteractionContainer), 'callInteraction', async (name, data) => { routed.push({ type: 'interaction', name, data }); return true })
    mock.method(Object.getPrototypeOf(IRCommandService), 'send', async (command_id, context) => {
        routed.push({ type: 'ir', command_id, context })
        return { status: 'dispatched', command_id, target_state: 'unknown' }
    })
    write([entry, {
        name: 'scene router',
        actions: {
            ON: { type: 'automation', name: 'Ambient Lights' },
            OFF: { type: 'interaction', name: 'Cinema Button', action: 'off' },
            OPEN: { type: 'device', name: 'Mock Lamp', command: 'ON' },
            CLOSE: { type: 'ir', command_id: 'amp_off' }
        }
    }])
    assert.equal((await VirtualDeviceService.reload()).ok, true)
    for (const action of ['ON', 'OFF', 'OPEN', 'CLOSE']) {
        assert.equal((await invoke('set_device_state', { device_name: 'scene router', action })).status, action === 'ON' || action === 'OFF' ? 'invoked' : 'dispatched')
    }
    assert.deepEqual(routed.map(call => call.type), ['automation', 'interaction', 'device', 'ir'])
    assert.equal(routed[2].source, DeviceCommandSource.HUMAN)
    delete physical['Mock Lamp']
    console.log('AI virtual device dispatch, Gemma recovery, and safe reload passed')
} finally {
    mock.restoreAll()
    fs.rmSync(directory, { recursive: true, force: true })
}
