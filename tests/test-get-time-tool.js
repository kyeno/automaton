import { config } from 'dotenv'
config()

'use strict'

/**
 * Focused tests for the get_time tool (ToolBuilder).
 *
 * Pins down:
 *   A) build() exposes exactly 3 tools including get_time with empty parameters schema
 *   B) execute({ function: { name:'get_time', arguments:'{}' } }) returns valid JSON with
 *      time_of_day, day, clock, hour, minute fields of correct types
 *   C) time_of_day is one of the known lib/date periods
 *   D) hour/minute are integers within valid ranges
 *
 * No network, MQTT, or LLM required.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import ToolBuilder from '../src/ai/toolBuilder.js'

await ConfigService.init()
LoggerService.init()

let passed = 0
let failed = 0
function assert(condition, label) {
    if (condition) { console.log(`  PASS ${label}`); passed++ }
    else { console.error(`  FAIL ${label}`); failed++ }
}

async function main() {
    console.log('=== get_time tool Tests ===\n')

    try {
        // A) schema ---------------------------------------------------------------------
        console.log('-- A) build() exposes get_time with empty parameters --')
        const tools = ToolBuilder.build(true)
        assert(tools.length === 3, `three tools registered (got ${tools.length})`)
        const getTimeTool = tools.find((t) => t.function?.name === 'get_time')
        assert(!!getTimeTool, 'get_time tool exists in the schema list')
        assert(getTimeTool.type === 'function', 'type is "function"')
        assert(typeof getTimeTool.function.description === 'string' && getTimeTool.function.description.length > 10,
            'description is a non-trivial string')
        assert(getTimeTool.function.parameters.type === 'object', 'parameters type is object')
        assert(Object.keys(getTimeTool.function.parameters.properties ?? {}).length === 0,
            'no required properties (empty parameter set)')

        // B) execution returns valid JSON ---------------------------------------------------
        console.log('-- B) execute() returns well-formed time payload --')
        const rawResult = await ToolBuilder.execute({ function: { name: 'get_time', arguments: '{}' } })
        const result = JSON.parse(rawResult)
        assert('time_of_day' in result, 'result has time_of_day field')
        assert('day' in result, 'result has day field')
        assert('clock' in result, 'result has clock field')
        assert('hour' in result, 'result has hour field')
        assert('minute' in result, 'result has minute field')
        assert(!('error' in result), 'no error key in successful response')

        // C) time_of_day is a known period ----------------------------------------------------
        console.log('-- C) time_of_day matches lib/date vocabulary --')
        const validPeriods = ['morning', 'noon', 'afternoon', 'evening', 'night']
        assert(validPeriods.includes(result.time_of_day), `time_of_day="${result.time_of_day}" is a known period`)

        // D) numeric ranges ---------------------------------------------------------------------
        console.log('-- D) hour/minute within valid integer ranges --')
        assert(Number.isInteger(result.hour) && result.hour >= 0 && result.hour <= 23,
            `hour=${result.hour} is an integer in [0..23]`)
        assert(Number.isInteger(result.minute) && result.minute >= 0 && result.minute <= 59,
            `minute=${result.minute} is an integer in [0..59]`)
        assert(typeof result.clock === 'string' && /\d{1,2}:\d{2}/.test(result.clock),
            `clock="${result.clock}" looks like HH:MM`)
    } catch (err) {
        console.error(`\nFatal error in test suite: ${err.message}\n${err.stack}`)
        process.exitCode = 1
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
}

main()
