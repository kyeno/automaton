/**
 * Device window header tests.
 *
 * The devices window opens with a header line carrying the localized current date and
 * today's sunrise/sunset. Coverage:
 *   - the date sentence comes from the locale date bundle with every {% %} token
 *     resolved (no token left on screen),
 *   - sunrise and sunset render as HH:MM from solar.getSunriseSunset() -- the raw
 *     geometric events, not the civil-twilight instants used for daylight gating,
 *   - a location without usable coordinates degrades to '--:--' instead of throwing
 *     or printing an invalid time,
 *   - the header is part of the refreshed frame, so it is redrawn as a single line
 *     above the device table on every refresh.
 * The window is driven through the recording virtual-terminal grid harness used by
 * test-window-preformatted.js. No MQTT broker, Redis or devices required.
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
import temporal from '../src/lib/date.js'
import solar from '../src/lib/sun.js'
import { interpolateTokens } from '../src/lib/string.js'
import DeviceWindow from '../src/ui/windows/deviceWindow.js'

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
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

/** Wait past BaseWindow's 30 ms render throttle so scheduled passes fire. */
const tick = () => new Promise(resolve => setTimeout(resolve, 80))

// -- Mock harness (same virtual-grid pattern as test-window-preformatted.js) ------

/**
 * Build a DeviceWindow wired to a virtual terminal grid modelling the main slot.
 * @param {{width: number, height: number}} size - Simulated main slot geometry
 * @returns {{win: DeviceWindow, screenText: function(): string}}
 */
function createHarness(size) {
    const width = size.width
    const height = size.height
    const grid = Array.from({ length: height }, () => new Array(width).fill(' '))
    let cx = 1
    let cy = 1

    const term = function (text) {
        for (const ch of String(text)) {
            if (cy >= 1 && cy <= height && cx >= 1 && cx <= width) {
                grid[cy - 1][cx - 1] = ch
            }
            cx++
        }
    }
    term.moveTo = (x, y) => { cx = x; cy = y }
    term.hideCursor = () => {}

    const blankRows = (y0, count) => {
        for (let r = y0; r < Math.min(y0 + count, height); r++) {
            grid[r].fill(' ')
        }
    }

    const layout = {
        getSlot: (name) => name === 'main' ? { x: 0, y: 0, width, height } : null,
        isTooNarrow: () => false,
        clearSlot: (name) => {
            const slot = layout.getSlot(name)
            if (slot) blankRows(slot.y, slot.height)
        },
        moveToSlot: () => {},
    }

    const win = new DeviceWindow(term, layout, 2)
    return {
        win,
        screenText() {
            return grid.map(row => row.join('')).join('\n')
        },
    }
}

/**
 * The date sentence the header is expected to show for the current instant.
 * @returns {string} Interpolated date sentence
 */
function expectedDateText() {
    const bundle = temporal.loadDateBundle() ?? {}
    const template = (typeof bundle.date_sentence === 'string' && bundle.date_sentence.trim() !== '')
        ? bundle.date_sentence
        : '{% day_name %}, {% day %} {% month_name %} {% year %}'
    return interpolateTokens(template, temporal.getDateParts(new Date()))
}

// -- Header carries the localized date and the solar times -------------------------

console.log('\n\u2500\u2500 Header content \u2500\u2500\n')

{
    const h = createHarness({ width: 110, height: 30 })
    h.win.show()
    h.win.refresh()
    await tick()

    const screen = h.screenText()
    const headerLine = screen.split('\n').find((line) => line.includes('Sunrise:')) ?? ''

    assert(screen.includes('Sunrise:'), 'header shows sunrise')
    assert(screen.includes('Sunset:'), 'header shows sunset')
    assert(/Sunrise: \d{2}:\d{2}/.test(headerLine), 'sunrise rendered as HH:MM')
    assert(/Sunset: \d{2}:\d{2}/.test(headerLine), 'sunset rendered as HH:MM')
    assert(!headerLine.includes('{%'), 'no unresolved token on the header line')

    const expected = expectedDateText()
    assert(headerLine.includes(expected), `header carries the localized date sentence (${expected})`)

    const { sunrise, sunset } = solar.getSunriseSunset(new Date())
    assert(headerLine.includes(temporal.formatClockTime(sunrise)),
        'printed sunrise matches solar.getSunriseSunset()')
    assert(headerLine.includes(temporal.formatClockTime(sunset)),
        'printed sunset matches solar.getSunriseSunset()')

    const gate = solar.getSunTimes(new Date())
    assert(!headerLine.includes(temporal.formatClockTime(gate.sundawn)),
        'header shows geometric sunrise, not the civil dawn used for gating')

    h.win.destroy()
}

// -- Missing coordinates degrade to '--:--' ---------------------------------------

console.log('\n\u2500\u2500 Missing location \u2500\u2500\n')

{
    const proto = Object.getPrototypeOf(ConfigService)
    const originalGet = proto.get
    proto.get = function (key, ...rest) {
        if (key === 'locale.geo_latitude' || key === 'locale.geo_longitude') return undefined
        return originalGet.call(this, key, ...rest)
    }
    try {
        const h = createHarness({ width: 110, height: 30 })
        h.win.show()
        h.win.refresh()
        await tick()

        const screen = h.screenText()
        const headerLine = screen.split('\n').find((line) => line.includes('Sunrise:')) ?? ''
        assert(/Sunrise: --:--/.test(headerLine), 'no coordinates: sunrise shown as --:--')
        assert(/Sunset: --:--/.test(headerLine), 'no coordinates: sunset shown as --:--')
        assert(!headerLine.includes('NaN'), 'no NaN leaks into the header')
        h.win.destroy()
    } finally {
        proto.get = originalGet
    }
}

// -- Header is redrawn as one line per refresh -------------------------------------

console.log('\n\u2500\u2500 Refresh behaviour \u2500\u2500\n')

{
    const h = createHarness({ width: 110, height: 30 })
    h.win.show()
    h.win.refresh()
    await tick()
    h.win.refresh()
    await tick()

    const headerLines = h.screenText().split('\n').filter((line) => line.includes('Sunrise:'))
    assert(headerLines.length === 1, `one header line after repeated refreshes (${headerLines.length})`)
    h.win.destroy()
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\nResults: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}\n`)

process.exit(failed > 0 ? 1 : 0)

