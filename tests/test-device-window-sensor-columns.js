/**
 * Device window sensor-column and classification tests.
 *
 * Two behaviours of the devices window are pinned here:
 *   - the Humid column falls back to soil_moisture, because capacitive flower probes report
 *     soil_moisture only and used to render as a blank row; air humidity always wins when a
 *     device reports both, so a plain hygrothermometer is unaffected;
 *   - devices the container resolved to DummyDevice are listed in their own Unclassified
 *     section instead of being swept into Mechanisms. A dummy answers power commands by
 *     faking a state change, so a mechanism row for a soil probe is a lie about the hardware;
 *     the section is the visible tripwire for a friendly-name rename.
 *
 * Driven through the recording virtual-terminal grid harness used by test-window-preformatted.js
 * and test-device-window-header.js. Devices are stubbed on DeviceContainer's prototype, so no
 * MQTT broker, Redis or real devices are required.
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
import DeviceContainer from '../src/device/container/deviceContainer.js'
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
        console.error(`  \u2717 FAIL: ${label}`)
        failed++
    }
}

/** Wait past BaseWindow's render throttle so scheduled passes fire. */
const tick = () => new Promise(resolve => setTimeout(resolve, 80))

//  -- Mock harness (same virtual-grid pattern as test-device-window-header.js) ------

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

//  -- Stubbed device set -------------------------------------------------------------

/** Build a minimal device stand-in exposing only the surface the window reads.
 * @param {Object} opts - Device shape
 * @returns {Object} Device stand-in */
function fakeDevice({ prefix, state = {}, origin = 'unknown', trackOrigin = false, lastSeen = null, channels = null }) {
    return {
        getLogPrefix: () => prefix,
        getStateLast: () => state,
        getStateOrigin: () => origin,
        getStateLastAt: () => lastSeen,
        shouldTrackOrigin: () => trackOrigin,
        getChannels: () => channels,
    }
}

const deviceSet = {
    'Probe Soil Only': fakeDevice({ prefix: 'Sensor', state: { soil_moisture: 42, battery: 88 } }),
    'Probe Air Only': fakeDevice({ prefix: 'Sensor', state: { humidity: 55 } }),
    'Probe Both': fakeDevice({ prefix: 'Sensor', state: { humidity: 61, soil_moisture: 12 } }),
    'Salon Lampa': fakeDevice({ prefix: 'Mechanism', state: { state: 'ON' }, origin: 'human', trackOrigin: true }),
    'Kitchen Sink Light': fakeDevice({
        prefix: 'DualSwitch',
        state: { state_left: 'ON', state_right: 'OFF' },
        origin: 'automation',
        trackOrigin: true,
        channels: ['left', 'right'],
    }),
    'Remote Hall': fakeDevice({ prefix: 'Remote', state: { action: 'toggle', battery: 40 } }),
    'Renamed Probe': fakeDevice({
        prefix: 'Device',
        state: { soil_moisture: 33, battery: 70 },
        lastSeen: '2026-10-11T10:15:00.000Z',
    }),
}

const dcProto = Object.getPrototypeOf(DeviceContainer)
const origGetAll = dcProto.getAll

/** Section header detector. */
const SECTION_RE = /-- (Sensors|Mechanisms|Remotes|Unclassified) \(\d+\) --/

/** Section rows between a section header and the next one.
 * @param {string[]} rows - Screen rows
 * @param {string} title - Section title
 * @returns {string[]} Rows belonging to that section */
function sectionLines(rows, title) {
    const start = rows.findIndex(l => l.includes(`-- ${title} (`))
    if (start < 0) return []
    const out = []
    for (let i = start + 1; i < rows.length; i++) {
        if (SECTION_RE.test(rows[i])) break
        out.push(rows[i])
    }
    return out
}

try {
    dcProto.getAll = () => ({ ...deviceSet })

    // ------------------------------------------------------------------
    console.log('\n\u2500\u2500 Humid column falls back to soil_moisture \u2500\u2500\n')

    const h = createHarness({ width: 110, height: 40 })
    h.win.show()
    h.win.refresh()
    await tick()

    const rows = h.screenText().split('\n')
    const rowFor = (name) => rows.find(l => l.includes(name)) ?? ''

    assert(rows.some(l => l.includes('-- Sensors (3) --')), 'three sensors listed')
    assert(rowFor('Probe Soil Only').includes('42%'),
        'soil-only probe shows its soil_moisture in the Humid column')
    assert(rowFor('Probe Air Only').includes('55%'), 'air humidity still rendered as before')
    assert(rowFor('Probe Both').includes('61%') && !rowFor('Probe Both').includes('12%'),
        'air humidity wins when a device reports both properties')

    // ------------------------------------------------------------------
    console.log('\n\u2500\u2500 Unmapped devices are Unclassified, never Mechanisms \u2500\u2500\n')

    const mechanisms = sectionLines(rows, 'Mechanisms')
    const unclassified = sectionLines(rows, 'Unclassified')

    assert(rows.some(l => l.includes('-- Mechanisms (2) --')), 'the dummy is not counted as a mechanism')
    assert(mechanisms.some(l => l.includes('Salon Lampa')) &&
        mechanisms.some(l => l.includes('Kitchen Sink Light')),
        'Mechanism and DualSwitch stay under Mechanisms')
    assert(!mechanisms.some(l => l.includes('Renamed Probe')),
        'the unmapped probe is not listed under Mechanisms')
    assert(rows.some(l => l.includes('-- Unclassified (1) --')), 'unclassified section is rendered')
    assert(unclassified.some(l => l.includes('Renamed Probe')), 'unmapped probe is listed under Unclassified')
    assert(unclassified.some(l => /\d{2}:\d{2}/.test(l)), 'unclassified row carries a last-seen clock time')
    assert(unclassified.some(l => l.includes('70%')), 'unclassified row keeps the battery column')

    // ------------------------------------------------------------------
    console.log('\n\u2500\u2500 Footer counts every bucket \u2500\u2500\n')

    const footer = rows.filter(l => l.includes('Devices:')).pop() ?? ''
    assert(footer.includes('Devices: 7'), `total counts the unclassified bucket (${footer})`)
    assert(footer.includes('Sensors: 3') && footer.includes('Mechanisms: 2') && footer.includes('Remotes: 1'),
        'per-bucket counts are exact')
    assert(footer.includes('Unclassified: 1'), 'footer names the unclassified count')

    // ------------------------------------------------------------------
    console.log('\n\u2500\u2500 A fully mapped fleet renders exactly as before \u2500\u2500\n')

    dcProto.getAll = () => ({
        'Probe Soil Only': deviceSet['Probe Soil Only'],
        'Salon Lampa': deviceSet['Salon Lampa'],
    })
    const h2 = createHarness({ width: 110, height: 40 })
    h2.win.show()
    h2.win.refresh()
    await tick()

    const rows2 = h2.screenText().split('\n')
    const footer2 = rows2.filter(l => l.includes('Devices:')).pop() ?? ''
    assert(!rows2.some(l => l.includes('Unclassified')), 'no unclassified section when nothing is unmapped')
    assert(footer2.includes('Devices: 2 | Sensors: 1 | Mechanisms: 1 | Remotes: 0'),
        `footer unchanged for a clean fleet (${footer2})`)
} finally {
    dcProto.getAll = origGetAll
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
