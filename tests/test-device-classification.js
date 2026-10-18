/**
 * Device classification tests -- config mapping first, bridge definition as the safety net.
 *
 * Background: a device with no entry in etc/device/zigbee.yaml became a DummyDevice, which
 * answers power commands by faking a state change and was listed in the UI under Mechanisms.
 * Renaming a flower probe in zigbee2mqtt (friendly_name drift) therefore turned a soil sensor
 * into a fake switch. The container now judges unmapped devices by the definition the bridge
 * reports: measurement-only devices become sensors, anything that actuates keeps the
 * DummyDevice fallback, and the UI shows the leftovers as Unclassified instead of Mechanisms.
 *
 * Covers: definition parsing across the shapes zigbee2mqtt reports (definition.options,
 * definition.features, nested composite exposes, bare string lists), the actuator veto, the
 * minimum-feature floor, category availability, and the container end-to-end with MQTT/Redis/
 * bridge stubbed -- a config-mapped probe stays a Sensor, an unmapped probe instantiates as a
 * Sensor, an unmapped switch stays a DummyDevice, and a late-announced probe is classified from
 * the bridge's cached list.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { config } from 'dotenv'
config()

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import MqttService from '../src/service/mqttService.js'
import DeviceBase from '../src/device/base/deviceBase.js'
import Bridge from '../src/device/type/bridge.js'
import Sensor from '../src/device/type/sensor.js'
import DummyDevice from '../src/device/type/dummy.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import { exposedProperties, categoryFromDefinition } from '../src/lib/deviceClassification.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 FAIL: ${label}`)
        failed++
    }
}

//  -- Synthetic bridge definitions (the shapes zigbee2mqtt reports across versions) --

/** Current shape: features live in definition.options. */
const soilProbe = {
    friendly_name: 'Sypialnia Kwiatek Nowy',
    ieee_address: '0x0001',
    type: 'EndDevice',
    supported: true,
    definition: {
        model: 'SP-120',
        options: [
            { name: 'soil_moisture', property: 'soil_moisture', access: 1, type: 'numeric' },
            { name: 'temperature', property: 'temperature', access: 1, type: 'numeric' },
            { name: 'battery', property: 'battery', access: 1, type: 'numeric' },
        ],
    },
}

/** Older shape: features live in definition.features. */
const soilProbeLegacy = {
    friendly_name: 'Sypialnia Kwiatek Legacy',
    ieee_address: '0x0002',
    type: 'EndDevice',
    supported: true,
    definition: {
        features: [
            { name: 'soil_moisture', property: 'soil_moisture' },
            { name: 'battery', property: 'battery' },
        ],
    },
}

/** Composite exposes nest their feature list one level deeper. */
const soilProbeNested = {
    friendly_name: 'Sypialnia Kwiatek Nested',
    ieee_address: '0x0003',
    type: 'EndDevice',
    supported: true,
    definition: {
        exposes: [
            { name: 'soil_moisture', property: 'soil_moisture' },
            { features: [{ property: 'temperature' }] },
        ],
    },
}

/** Bare string list (top level, no definition wrapper). */
const soilProbeBareStrings = { features: ['soil_moisture', 'battery'] }

/** A switch: reports battery AND actuates, so the definition must not call it a sensor. */
const unmappedSwitch = {
    friendly_name: 'Test Unmapped Switch',
    ieee_address: '0x0010',
    type: 'EndDevice',
    supported: true,
    definition: {
        options: [
            { name: 'state', property: 'state', access: 7 },
            { name: 'battery', property: 'battery', access: 1 },
        ],
    },
}

/** A cover: two measurement properties are not enough to outvote the actuator property. */
const unmappedCover = {
    friendly_name: 'Test Unmapped Cover',
    ieee_address: '0x0011',
    type: 'EndDevice',
    supported: true,
    definition: {
        options: [
            { name: 'position', property: 'position', access: 7 },
            { name: 'battery', property: 'battery', access: 1 },
            { name: 'temperature', property: 'temperature', access: 1 },
        ],
    },
}

/** Battery only -- a power source is not a sensor. */
const batteryOnly = {
    friendly_name: 'Test Battery Only',
    ieee_address: '0x0012',
    type: 'EndDevice',
    supported: true,
    definition: { options: [{ name: 'battery', property: 'battery' }] },
}

/** A single measurement property stays below the auto-classification floor. */
const singleMeasurement = {
    friendly_name: 'Test Single Measurement',
    ieee_address: '0x0013',
    type: 'EndDevice',
    supported: true,
    definition: { options: [{ name: 'illuminance', property: 'illuminance' }] },
}

//  -- Pure definition classification --------------------------------------------------

console.log('\n\u2500\u2500 Pure definition classification \u2500\u2500\n')

assert(exposedProperties(soilProbe).includes('soil_moisture'), 'definition.options features are collected')
assert(categoryFromDefinition(soilProbe) === 'sensor', 'soil probe definition -> sensor')
assert(categoryFromDefinition(soilProbeLegacy) === 'sensor', 'definition.features shape -> sensor')
assert(categoryFromDefinition(soilProbeNested) === 'sensor', 'nested composite exposes -> sensor')
assert(categoryFromDefinition(soilProbeBareStrings) === 'sensor', 'bare string feature list -> sensor')
assert(categoryFromDefinition(unmappedSwitch) === null, 'state (an actuator property) vetoes auto-classification')
assert(categoryFromDefinition(unmappedCover) === null, 'position vetoes even with two measurement properties')
assert(categoryFromDefinition(batteryOnly) === null, 'a battery alone is not a sensor')
assert(categoryFromDefinition(singleMeasurement) === null, 'one measurement property is below the auto floor')
assert(categoryFromDefinition(null) === null, 'no definition -> no verdict')
assert(categoryFromDefinition({}) === null, 'empty definition -> no verdict')
assert(categoryFromDefinition(soilProbe, { availableCategories: ['mechanism'] }) === null,
    'categories the caller cannot build are never proposed')
assert(categoryFromDefinition(batteryOnly, { minSensorFeatures: 1 }) === 'sensor',
    'the feature floor is honored as configured')

//  -- Container end-to-end (MQTT, Redis and the bridge conversation stubbed) ---------

/** Device list the stubbed bridge "answers" with. */
const bridgeList = [
    soilProbe,                                   // unmapped probe -> must become a Sensor
    unmappedSwitch,                              // unmapped actuator -> stays a DummyDevice
    {
        friendly_name: 'Outdoor Temperature',
        ieee_address: '0x0020',
        type: 'EndDevice',
        supported: true,
        definition: { options: [{ name: 'soil_moisture', property: 'soil_moisture' }] },
    },                                             // mapped in etc/device/zigbee.yaml
    {
        friendly_name: 'Test Late Probe',
        ieee_address: '0x0021',
        type: 'EndDevice',
        supported: false,                          // skipped at startup, announced later
        definition: soilProbeLegacy.definition,
    },
]

const mqttProto = Object.getPrototypeOf(MqttService)
const mqttStash = {
    init: mqttProto.init,
    onReconnect: mqttProto.onReconnect,
    subscribe: mqttProto.subscribe,
    publish: mqttProto.publish,
}
mqttProto.init = async () => true
mqttProto.onReconnect = () => {}
mqttProto.subscribe = () => () => {}
mqttProto.publish = () => {}

const bridgeProto = Bridge.prototype
const bridgeStash = {
    requestDeviceList: bridgeProto.requestDeviceList,
    waitForDeviceList: bridgeProto.waitForDeviceList,
    getDevices: bridgeProto.getDevices,
}
bridgeProto.requestDeviceList = () => {}
bridgeProto.waitForDeviceList = () => Promise.resolve(bridgeList)
bridgeProto.getDevices = () => bridgeList

const baseProto = DeviceBase.prototype
const baseStashInit = baseProto.init
baseProto.init = async () => {}

try {
    await DeviceContainer.init()

    console.log('\n\u2500\u2500 Container: config wins, definition is the safety net \u2500\u2500\n')

    assert(DeviceContainer.classifyDevice('Outdoor Temperature') === 'sensor',
        'config mapping wins with no definition in hand')
    assert(DeviceContainer.classifyDevice('Outdoor Temperature', unmappedSwitch) === 'sensor',
        'config mapping wins even when the definition would veto it')
    assert(DeviceContainer.classifyDevice('Sypialnia Kwiatek Nowy', soilProbe) === 'sensor',
        'unmapped probe classified from the bridge definition')
    assert(DeviceContainer.classifyDevice('Test Unmapped Switch', unmappedSwitch) === 'dummy',
        'unmapped actuator keeps the DummyDevice fallback')
    assert(DeviceContainer.classifyDevice('Test Nothing At All') === 'dummy',
        'no config entry and no definition -> dummy')

    const all = DeviceContainer.getAll({ includeBridge: false })
    assert(all['Sypialnia Kwiatek Nowy'] instanceof Sensor,
        'unmapped probe is instantiated as a Sensor, not a DummyDevice')
    assert(all['Sypialnia Kwiatek Nowy'].getLogPrefix() === 'Sensor',
        'probe carries the Sensor log prefix, so the UI buckets it under Sensors')
    assert(all['Sypialnia Kwiatek Nowy'].shouldTrackOrigin() === false,
        'probe is not an actuator, so the UI never lists it under Mechanisms')
    assert(all['Test Unmapped Switch'] instanceof DummyDevice,
        'unmapped switch is still a DummyDevice')
    assert(all['Outdoor Temperature'] instanceof Sensor,
        'config-mapped probe is unaffected by the new path')

    const late = DeviceContainer.addDevice('Test Late Probe', '0x0021', {})
    assert(late instanceof Sensor,
        'late-announced probe is classified from the bridge cached device list')
} finally {
    Object.assign(mqttProto, mqttStash)
    Object.assign(bridgeProto, bridgeStash)
    baseProto.init = baseStashInit
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
