/**
 * YAML ownership gates and single-event split-rule regression tests.
 * @license AGPL-3.0-only
 */
'use strict'

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parse, stringify } from 'yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import EventBus from '../src/service/eventBus.js'
import AutomationContainer from '../src/automation/container/automationContainer.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import networkPresence from '../src/monitor/networkPresence.js'
import videoPlayerMonitor from '../src/monitor/videoPlayerMonitor.js'
import AmbientLightsAutomation from '../etc/automation/ambientLightsAutomation.js'
import HomeTheaterAutomation from '../etc/automation/homeTheaterBase.js'
import KitchenCountertopLEDAutomation from '../etc/automation/kitchenCountertopLEDAutomation.js'
import { evaluateRule } from '../src/lib/ruleCoverage.js'

await ConfigService.init()
LoggerService.init()

const dir = mkdtempSync(join(tmpdir(), 'automaton-ownership-'))
const restores = []
const automations = []
function patch(instance, key, replacement) {
    const proto = Object.getPrototypeOf(instance)
    const original = proto[key]
    proto[key] = replacement
    restores.push(() => { proto[key] = original })
}

let occupied = false
const outlet = {
    state: 'OFF', calls: [],
    getName() { return 'Kitchen LED Outlet' },
    getStateLast() { return { state: this.state } },
    receiveCommand(payload) {
        this.calls.push(payload)
        this.state = typeof payload === 'string' ? payload : payload.state
        return true
    },
}
const sensor = { getStateLast: () => ({ occupancy: occupied }) }
let owner
let registeredOwner
const markers = new Map()
patch(DeviceContainer, 'findByName', name => ({ 'Kitchen Motion Sensor': sensor, 'Kitchen LED Outlet': outlet })[name])
patch(AutomationContainer, 'getAutomation', name => name === 'KitchenCountertopLEDAutomation' ? registeredOwner : null)
patch(networkPresence, 'isOnline', async () => true)
patch(videoPlayerMonitor, 'getStatus', async () => 'playing')
patch(CacheService, 'get', async key => markers.get(key))
patch(CacheService, 'set', async (key, value) => { markers.set(key, value); return true })

try {
    owner = new KitchenCountertopLEDAutomation(10_000)
    automations.push(owner)
    await owner.init()
    registeredOwner = owner

    for (const [filename, Base, topic] of [
        ['ambient-lights.yaml.dist', AmbientLightsAutomation, 'zigbee:Outdoor Luminance'],
        ['home-office-video.yaml.dist', HomeTheaterAutomation, 'videoPlayer:my-pc'],
    ]) {
        const config = parse(readFileSync(join('etc/automation', filename), 'utf8'))
        // Suppression is independent of ownership; let the ambient fixture run in daylight.
        if (Base === AmbientLightsAutomation) delete config.video_player_suppression
        const ledRule = config.rules.find(rule => rule.targets?.Kitchen_LED_Outlet === 'OFF')
        assert.ok(ledRule, `${filename}: shipped kitchen shutdown rule exists`)
        assert.deepEqual(ledRule.conditions.automation_state,
            { KitchenCountertopLEDAutomation: { countdown_active: false } })
        assert.equal(config.rules.filter(rule => rule.targets?.Kitchen_LED_Outlet !== undefined).length, 1)
        // Explicit fixture: retain the two shipped shutdown rules, with a deterministic dawn.
        config.rules = config.rules.filter(rule => rule === ledRule
            || rule.name === 'Bright morning - turn off leftover lights'
            || rule.name === 'Office: playing - dark mode (lights off)')
        for (const rule of config.rules) {
            if (rule.conditions.hour) rule.conditions.hour = { gte: 0 }
        }
        const configPath = join(dir, filename.replace('.dist', ''))
        writeFileSync(configPath, stringify(config))
        const devices = new Map()
        for (const rule of config.rules) {
            for (const key of Object.keys(rule.targets)) {
                devices.set(key, key === 'Kitchen_LED_Outlet' ? outlet : {
                    calls: [], getName: () => key,
                    receiveCommand(payload) { this.calls.push(payload) },
                })
            }
        }
        class Harness extends Base {
            constructor() {
                super(Base === AmbientLightsAutomation ? configPath : { name: 'OwnershipTheater', configPath })
            }
            loadDevices() { return devices }
            async buildContext() { return { timeOfDay: 'morning', illuminance: 50 } }
            async checkAndLogHumanInteraction() { return false }
        }
        const auto = new Harness()
        automations.push(auto)
        await auto.init()
        auto.stopTimer()
        const reset = () => {
            for (const device of devices.values()) device.calls.length = 0
            markers.clear()
        }

        occupied = true
        await owner.execute()
        occupied = false // Grace period remains protected even after occupancy clears.
        const active = { automation_state: { KitchenCountertopLEDAutomation: { countdown_active: true } } }
        const inactive = { automation_state: { KitchenCountertopLEDAutomation: { countdown_active: false } } }
        assert.equal(await auto.conditionsMatch(active, {}), true)
        assert.equal(await auto.conditionsMatch(inactive, {}), false)
        assert.match(await auto.explainRuleMiss(inactive, {}), /automation_state/)
        reset()
        const before = auto.getRecentAutomationCalls().length
        EventBus.publish(topic)
        await sleep(450)
        assert.equal(auto.getRecentAutomationCalls().length, before + 1, 'one event causes one run')
        assert.equal(outlet.calls.length, 0, 'active motion countdown protects LED')
        for (const [key, device] of devices) {
            if (key !== 'Kitchen_LED_Outlet') assert.deepEqual(device.calls, [{ state: 'OFF' }])
        }
        owner.cleanup()
        outlet.state = 'ON' // A manually lit LED without a motion countdown.
        reset()
        EventBus.publish(topic)
        await sleep(450)
        for (const device of devices.values()) assert.deepEqual(device.calls, [{ state: 'OFF' }])
        assert.equal(auto.getRecentAutomationCalls().length, before + 2, 'second event also needs just one run')

        assert.equal(await auto.conditionsMatch(inactive, {}), true)
        assert.equal(await auto.conditionsMatch(active, {}), false)
        assert.equal(await auto.conditionsMatch({ all_of: [inactive] }, {}), true)
        assert.equal(await auto.conditionsMatch({ any_of: [inactive] }, {}), true)
        registeredOwner = null
        assert.equal(await auto.conditionsMatch(inactive, {}), true, 'missing owner is inactive')
        assert.equal(await auto.conditionsMatch(active, {}), false, 'missing owner is not active')
        registeredOwner = {}
        await assert.rejects(auto.conditionsMatch(inactive, {}), /does not expose/)
        registeredOwner = owner
        for (const spec of [null, [], {}, { KitchenCountertopLEDAutomation: {} },
            { KitchenCountertopLEDAutomation: { countdown_active: 'false' } },
            { KitchenCountertopLEDAutomation: { arbitrary_property: false } }]) {
            await assert.rejects(auto.conditionsMatch({ automation_state: spec }, {}), /automation_state/)
        }
        assert.equal(evaluateRule(inactive, {}), true, 'static coverage does not simulate timers')
        auto.cleanup()
    }

    const expiringOwner = new KitchenCountertopLEDAutomation(40)
    automations.push(expiringOwner)
    await expiringOwner.init()
    occupied = true
    await expiringOwner.execute()
    occupied = false
    outlet.calls.length = 0
    assert.equal(expiringOwner.getConditionState('countdown_active'), true)
    await sleep(120)
    assert.equal(expiringOwner.getConditionState('countdown_active'), false)
    assert.deepEqual(outlet.calls, ['OFF'], 'owner alone turns LED off at countdown expiry')
    assert.equal(expiringOwner.getConditionState('unsupported'), undefined)
    console.log('Automation ownership condition and single-event regressions passed')
} catch (error) {
    console.error(error)
    process.exitCode = 1
} finally {
    for (const auto of automations) auto.cleanup()
    for (const restore of restores.reverse()) restore()
    rmSync(dir, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)