/**
 * Durable human daylight evidence, report freshness and command behavior.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ConfigService from '../src/service/configService.js'
import DatabaseService from '../src/service/databaseService.js'
import SensorHistoryService from '../src/service/sensorHistoryService.js'
import DaylightService from '../src/service/daylightService.js'
import WeatherCmd from '../src/ui/commands/weatherCmd.js'
import EventBus from '../src/service/eventBus.js'
import WeatherMan from '../etc/automation/ttsWeatherManAutomation.js'
import LoggerService from '../src/service/loggerService.js'

await ConfigService.init()
LoggerService.init()
const configProto = Object.getPrototypeOf(ConfigService)
const originalGet = configProto.get
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-daylight-'))
const file = path.join(directory, 'test.db')
const at = Date.now()
const config = { recording_enabled: true, sensors: [{ id: 'east', device: 'Light', property: 'illuminance', installation: 'v1', max_lux: 10000 }] }
const daylightProto = Object.getPrototypeOf(DaylightService)
const originalEstimate = daylightProto.estimate
const wm = new WeatherMan()
configProto.get = function (key, fallback) {
    if (key === 'daylight') return config
    if (key === 'sensor_history') return { enabled: false }
    return originalGet.call(this, key, fallback)
}
try {
    await DatabaseService.init(file)
    await SensorHistoryService.init()
    const report = (timestamp, state) => EventBus.emit('device:stateReported', { device: 'Light', timestamp, state })
    assert.match(DaylightService.observe('sunny', at), /No usable fresh/)
    assert.match(DaylightService.undo(), /Undone/)
    report(at - 60000, { illuminance: 1000 })
    report(at + 60000, { illuminance: 9000 })
    report(at - 30000, { temperature: 15 })
    assert.equal(DatabaseService.daylightSamples(at - 900000, at).length, 1, 'partial and future reports are excluded')
    assert.equal(DaylightService.observe('sunny', at), 'Saved: sunny.')
    assert.match(DaylightService.observe('sunny', at + 1), /Already saved/)
    assert.equal(DaylightService.observe('cloudy', at + 2), 'Saved: cloudy.', 'real weather changes remain separate')
    const labels = DaylightService.observations()
    assert.equal(labels.length, 2)
    assert.equal(labels[0].sensors[0].samples[0].value, 1000)
    assert.equal(labels[0].sensors[0].ageMs, 60000)
    config.sensors.push({ id: 'west', device: 'West Light', property: 'illuminance', installation: 'west-v1' })
    EventBus.emit('device:stateReported', { device: 'West Light', timestamp: at - 1000, state: { illuminance: 2500 } })
    assert.equal(DaylightService.observe('overcast', at + 3), 'Saved: overcast.')
    const combined = DaylightService.observations().at(-1)
    assert.equal(combined.sensors[0].samples[0].value, 1000, 'adding west preserves east installation evidence')
    assert.equal(combined.sensors[1].samples[0].value, 2500, 'each sensor maps its own device/property')
    DaylightService.undo()
    DatabaseService.pruneSensorSamples(1)
    await DatabaseService.close()
    await DatabaseService.init(file)
    assert.equal(DaylightService.observations().length, 2)
    assert.equal(DaylightService.observations()[0].sensors[0].samples[0].value, 1000)
    assert.match(DaylightService.undo(), /cloudy/)
    assert.equal(DaylightService.observations().length, 1)
    assert.match(DaylightService.observe('overcast', at + 900000), /No usable fresh/)
    report(at + 900001, { illuminance: null })
    assert.match(DaylightService.observe('cloudy', at + 900002), /No usable fresh/)
    report(at + 900003, { illuminance: 10000 })
    assert.match(DaylightService.observe('sunny', at + 900004), /No usable fresh/, 'clipping is excluded')
    config.sensors[0].installation = 'v2'
    assert.match(DaylightService.observe('sunny', at + 900005), /No usable fresh/, 'moved sensors cannot reuse or deduplicate previous evidence')
    const count = DatabaseService.daylightEvents().length
    config.recording_enabled = false
    report(at, { illuminance: 500 })
    assert.match(DaylightService.observe('sunny', at), /disabled/)
    assert.equal(DatabaseService.daylightEvents().length, count)
    const printed = []
    const command = new WeatherCmd({ print: text => printed.push(text) })
    await command.execute('status')
    assert.match(printed.at(-1), /model not fitted/)
    assert.ok(command.completeNextToken([]).includes('sunny'))
    await wm.init()
    let calls = 0
    daylightProto.estimate = () => { calls++; return { state: 'sunny', timestamp: at, evidenceAgeMs: 1000, modelVersion: 'test-v1' } }
    assert.equal(wm.buildSkyReading(at), '')
    assert.equal(calls, 0, 'disabled flag avoids inference entirely')
    config.announcements_enabled = true
    assert.ok(wm.buildSkyReading(at).length > 0, 'speech consumption is independent of disabled recording')
    assert.equal(wm.buildSkyReading(at + 300001), '', 'expired estimates are omitted')
    daylightProto.estimate = originalEstimate
    assert.equal(wm.buildSkyReading(at), '', 'unfitted model remains unknown even when enabled')
    await command.execute('export')
    const exportFile = printed.at(-1).split('\n')[0].replace('Exported: ', '')
    const exported = fs.readFileSync(exportFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(exported[0].format, 'automaton-daylight')
    assert.equal(exported.length, count + 1, 'export includes raw evidence and the complete label audit')
    assert.ok(exported.some(e => e.kind === 'undo'))
    fs.unlinkSync(exportFile)
    await DatabaseService.close()
    assert.match(DaylightService.undo(), /unavailable/)
    console.log('Daylight archive, freshness, audit and command tests passed')
} finally {
    wm.cleanup()
    daylightProto.estimate = originalEstimate
    SensorHistoryService.stop()
    await DatabaseService.close()
    configProto.get = originalGet
    fs.rmSync(directory, { recursive: true, force: true })
}
