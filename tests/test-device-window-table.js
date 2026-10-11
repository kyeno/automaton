/**
 * Device window table layout tests.
 *
 * The devices window lays its sections out as a table whose columns are sized to
 * the content they hold, with exactly one leading and one trailing space in every
 * cell. Pinned here:
 *   - every column is as wide as its longest cell, header label included, so a
 *     header can no longer overflow its column ('Last seen') and a long value can
 *     no longer overflow its own column ('brightness_up');
 *   - the Name column is shared by all four sections and Batt by the three
 *     battery-reporting ones, each measured once over the whole frame, so the
 *     sections line up against each other; mechanisms are mains-powered and have
 *     no Batt column at all;
 *   - names are never truncated, and an empty cell renders as full-width blanks so
 *     a sparse row keeps the same grid as a full one;
 *   - header and data rows of a section are exactly the same length, and every cell
 *     boundary is a pair of spaces -- no two columns can be glued together.
 *
 * Driven through the recording virtual-terminal grid harness used by
 * test-device-window-header.js and test-device-window-sensor-columns.js. Devices are
 * stubbed on DeviceContainer's prototype, so no MQTT broker, Redis or real devices
 * are required. The expected widths are computed here, independently of the window.
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
import temporal from '../src/lib/date.js'

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
        const str = String(text)
        let i = 0
        while (i < str.length) {
            //  ANSI escape sequences are invisible: they must not consume a cell,
            //  otherwise the grid stops being a faithful model of the screen.
            if (str[i] === '\x1b' && str[i + 1] === '[') {
                let j = i + 2
                while (j < str.length && str[j] !== 'm') j++
                i = j + 1
                continue
            }
            if (cy >= 1 && cy <= height && cx >= 1 && cx <= width) {
                grid[cy - 1][cx - 1] = str[i]
            }
            cx++
            i++
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

//  -- Stubbed fleet ------------------------------------------------------------

/** Build a minimal device stand-in exposing only the surface the window reads.
 * @param {Object} opts - Device shape
 * @returns {Object} Device stand-in */
function fakeDevice({ prefix, state = {}, origin = 'unknown', lastSeen = null, channels = null, trackOrigin = true }) {
    return {
        getLogPrefix: () => prefix,
        getStateLast: () => state,
        getStateOrigin: () => origin,
        getStateLastAt: () => lastSeen,
        shouldTrackOrigin: () => trackOrigin,
        getChannels: () => channels,
    }
}

const LAST_SEEN = '2026-10-11T10:15:00.000Z'

const fleet = {
    sensors: [
        { name: 'Kye No Bath Sensor', device: fakeDevice({ prefix: 'Sensor', state: { temperature: 22.1, humidity: 52, battery: 90 } }) },
        { name: 'Kye No Kitchen', device: fakeDevice({ prefix: 'Sensor', state: { temperature: 21.4, humidity: 44, pressure: 1009, illuminance: 23, battery: 53 } }) },
        { name: 'Stue Sensor', device: fakeDevice({ prefix: 'Sensor', state: { temperature: 21.3, humidity: 44, pressure: 1009, illuminance: 22, battery: 100 } }) },
        { name: 'Kye No Flower', device: fakeDevice({ prefix: 'Sensor', state: { soil_moisture: 44, battery: 79 } }) },
        { name: 'Stue Flower', device: fakeDevice({ prefix: 'Sensor', state: { soil_moisture: 34, battery: 81 } }) },
    ],
    mechanisms: [
        { name: 'Kye No Main Lamp Strip 6', device: fakeDevice({ prefix: 'Mechanism', state: { state: 'ON' }, origin: 'automation' }) },
        { name: 'Stue Reading Lamp', device: fakeDevice({ prefix: 'Mechanism', state: { state: 'ON' }, origin: 'human' }) },
        { name: 'Kye No Floor Lamp', device: fakeDevice({ prefix: 'Mechanism', state: { state: 'OFF' }, origin: 'automation' }) },
        {
            name: 'Kitchen Dual Switch',
            device: fakeDevice({
                prefix: 'DualSwitch',
                state: { state_left: 'ON', brightness_left: 153, state_right: 'OFF' },
                origin: 'automation',
                channels: ['left', 'right'],
            }),
        },
    ],
    remotes: [
        { name: 'Kye No Remote', device: fakeDevice({ prefix: 'Remote', state: { action: 'brightness_up', battery: 100 } }) },
        { name: 'Stue Remote', device: fakeDevice({ prefix: 'Remote', state: { action: 'toggle', battery: 100 } }) },
    ],
    unclassified: [
        { name: 'Renamed Soil Probe', device: fakeDevice({ prefix: 'Device', state: { soil_moisture: 33, battery: 70 }, lastSeen: LAST_SEEN, trackOrigin: false }) },
    ],
}

//  -- Expected geometry, computed here independently of the window --------------

/** Column layout of each section, mirroring the window's documented headers.
 *  Batt belongs to the battery-powered sections only: mechanisms are mains-powered
 *  and report no battery, so their table carries no Batt column at all. */
const SECTION_COLUMNS = {
    sensors: [{ key: 'name', header: 'Name' }, { key: 'temp', header: 'Temp' }, { key: 'humid', header: 'Humid' },
        { key: 'press', header: 'Press' }, { key: 'light', header: 'Light' }, { key: 'batt', header: 'Batt' }],
    mechanisms: [{ key: 'name', header: 'Name' }, { key: 'state', header: 'State' },
        { key: 'origin', header: 'Origin' }],
    remotes: [{ key: 'name', header: 'Name' }, { key: 'action', header: 'Action' }, { key: 'batt', header: 'Batt' }],
    unclassified: [{ key: 'name', header: 'Name' }, { key: 'lastseen', header: 'Last seen' }, { key: 'batt', header: 'Batt' }],
}

/** Sections that report a battery, and therefore carry the shared Batt column. */
const BATTERY_SECTIONS = Object.keys(SECTION_COLUMNS)
    .filter((section) => SECTION_COLUMNS[section].some((column) => column.key === 'batt'))

/** Cell text for one device row, mirroring the documented column formats.
 * @param {Object} entry - Fleet entry (name + stub device)
 * @param {string} section - Section the entry is rendered under
 * @returns {Array<Object>} Row cells in display order */
function expectedRow(entry, section) {
    const state = entry.device.getStateLast()
    const cell = (key, text, align) => ({ key, text, align })
    const row = [cell('name', entry.name, 'left')]

    if (section === 'sensors') {
        const humidity = state.humidity ?? state.soil_moisture ?? null
        row.push(cell('temp', state.temperature != null ? Number(state.temperature).toFixed(1) + '*C' : '', 'right'))
        row.push(cell('humid', humidity != null ? String(humidity) + '%' : '', 'right'))
        row.push(cell('press', state.pressure != null ? Math.round(state.pressure) + 'hPa' : '', 'right'))
        row.push(cell('light', state.illuminance != null ? Math.round(state.illuminance) + 'lx' : '', 'right'))
    } else if (section === 'mechanisms') {
        const channels = entry.device.getChannels()
        let status = state.state ? String(state.state).toUpperCase() : '-'
        if (Array.isArray(channels) && channels.length > 0) {
            const parts = channels.map((ch) => {
                const st = state[`state_${ch}`]
                if (st === undefined) return null
                let part = String(st).toUpperCase()
                const br = state[`brightness_${ch}`]
                if (Number.isFinite(Number(br)) && Number(br) > 0) {
                    part += ` ${Math.round((Number(br) / 254) * 100)}%`
                }
                return part
            }).filter(Boolean)
            if (parts.length > 0) status = parts.join(' / ')
        }
        row.push(cell('state', status, 'right'))
        row.push(cell('origin', entry.device.getStateOrigin(), 'right'))
    } else if (section === 'remotes') {
        row.push(cell('action', state.action != null ? String(state.action) : '', 'right'))
    } else {
        row.push(cell('lastseen', temporal.formatClockTime(new Date(entry.device.getStateLastAt())), 'right'))
    }

    if (BATTERY_SECTIONS.includes(section)) {
        row.push(cell('batt', state.battery != null ? String(state.battery) + '%' : '', 'right'))
    }
    return row
}


const allRows = Object.entries(fleet).flatMap(([section, entries]) =>
    entries.map((entry) => ({ section, cells: expectedRow(entry, section) })))

/** Column width = longest text in that column across every section, header included. */
const widths = {}
for (const { cells } of allRows) {
    for (const cell of cells) {
        widths[cell.key] = Math.max(widths[cell.key] ?? 0, cell.text.length)
    }
}
for (const columns of Object.values(SECTION_COLUMNS)) {
    for (const column of columns) {
        widths[column.key] = Math.max(widths[column.key] ?? 0, column.header.length)
    }
}

/** Build the expected line for a set of cells.
 * @param {Array<Object>} cells - Cells in display order
 * @returns {string} Expected line: one leading and one trailing space per cell */
function expectedLine(cells) {
    return cells.map((cell) => {
        const width = widths[cell.key]
        const body = cell.align === 'right' ? cell.text.padStart(width) : cell.text.padEnd(width)
        return ' ' + body + ' '
    }).join('')
}

/** Expected header cells of a section, aligned like the section's data cells.
 * @param {string} section - Section name
 * @returns {Array<Object>} Header cells */
function headerCells(section) {
    const alignOf = {}
    for (const { section: name, cells } of allRows) {
        if (name !== section) continue
        for (const cell of cells) alignOf[cell.key] = cell.align
    }
    return SECTION_COLUMNS[section].map((column) => ({
        key: column.key,
        text: column.header,
        align: alignOf[column.key] ?? 'left',
    }))
}

/** Strip ANSI colour codes from a screen line, keeping the grid's trailing padding.
 * @param {string} line - Raw screen line
 * @returns {string} Visible text with the grid padding intact */
function visible(line) {
    return line.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Drop trailing blanks from a line (the grid pads every row to the slot width).
 * @param {string} line - Visible line
 * @returns {string} Line without trailing blanks */
function trimmed(line) {
    return line.replace(/\s+$/, '')
}

/** Check that every cell of a line is wrapped in exactly one space on each side.
 * @param {string} line - Visible line, grid padding intact
 * @param {string[]} keys - Column keys in display order
 * @returns {boolean} true when each cell is delimited by single spaces */
function cellsSpaced(line, keys) {
    let pos = 0
    for (const key of keys) {
        if (line[pos] !== ' ') return false
        pos += widths[key] + 1
        if (line[pos] !== ' ') return false
        pos += 1
    }
    return true
}

/** Check that a header label sits inside its own column.
 * @param {string} line - Visible header line
 * @param {string} section - Section name
 * @returns {boolean} true when every label is inside its cell */
function headerInsideColumns(line, section) {
    let pos = 0
    for (const column of SECTION_COLUMNS[section]) {
        const text = line.slice(pos + 1, pos + 1 + widths[column.key])
        if (text.trim() !== column.header) return false
        pos += widths[column.key] + 2
    }
    return true
}

/** Total width a section's table occupies: every cell plus its two spaces.
 * @param {string} section - Section name
 * @returns {number} Columns occupied by the section's grid */
function sectionTableWidth(section) {
    return SECTION_COLUMNS[section].reduce((sum, column) => sum + widths[column.key] + 2, 0)
}

/** Section rows between its header and the next section header or blank separator.
 * @param {string[]} rows - Screen rows
 * @param {string} title - Section title as printed
 * @returns {string[]} Rows of that section, header row first */
function sectionLines(rows, title) {
    const start = rows.findIndex(l => l.includes(`-- ${title} (`))
    if (start < 0) return []
    const out = []
    for (let i = start + 1; i < rows.length; i++) {
        if (rows[i].trim() === '') break
        if (/-- (Sensors|Mechanisms|Remotes|Unclassified) \(\d+\) --/.test(rows[i])) break
        out.push(rows[i])
    }
    return out
}

//  -- Run the window once over the whole fleet ------------------------------------

const SECTIONS = [['sensors', 'Sensors'], ['mechanisms', 'Mechanisms'],
    ['remotes', 'Remotes'], ['unclassified', 'Unclassified']]

const dcProto = Object.getPrototypeOf(DeviceContainer)
const origGetAll = dcProto.getAll

const flatFleet = {}
for (const entries of Object.values(fleet)) {
    for (const entry of entries) flatFleet[entry.name] = entry.device
}

try {
    dcProto.getAll = () => ({ ...flatFleet })

    const harness = createHarness({ width: 110, height: 60 })
    harness.win.show()
    harness.win.refresh()
    await tick()

    const rows = harness.screenText().split('\n').map(visible)

    // ------------------------------------------------------------------
    console.log('\n--- Columns are sized to their content ---\n')

    assert(widths.name === 24, `Name column sized by the longest name (${widths.name})`)
    assert(widths.action === 13, `Action column sized by brightness_up (${widths.action})`)
    assert(widths.lastseen === 9, `Last seen column sized by its header (${widths.lastseen})`)
    assert(widths.state === 12, `State column sized by the multi-channel row (${widths.state})`)
    assert(widths.batt === 4, `Batt column sized by 100% (${widths.batt})`)

    // ------------------------------------------------------------------
    console.log('\n--- Header and data rows share one grid ---\n')

    for (const [section, title] of SECTIONS) {
        const lines = sectionLines(rows, title)
        const header = lines[0] ?? ''
        const data = lines.slice(1).filter(l => !l.startsWith('  '))

        assert(header.startsWith(expectedLine(headerCells(section))),
            `${title} header row is exactly the padded header cells`)
        assert(headerInsideColumns(header, section),
            `${title} header labels sit inside their own columns`)
        assert(data.length === fleet[section].length,
            `${title} has one data row per device (${data.length})`)

        for (const entry of fleet[section]) {
            const cells = expectedRow(entry, section)
            const want = expectedLine(cells)
            const got = data.find(l => l.includes(entry.name)) ?? ''
            assert(got.startsWith(want), `${title}: '${entry.name}' matches the padded grid`)
            assert(cellsSpaced(got, cells.map(c => c.key)),
                `${title}: '${entry.name}' cells carry one space on each side`)
        }

        const tableWidth = sectionTableWidth(section)
        assert(trimmed(header).length === tableWidth - 1,
            `${title} header fills the ${tableWidth}-column grid, last label inside its cell`)
        assert(data.every(l => trimmed(l).length <= tableWidth),
            `${title} no data row spills past its last column`)
        assert(expectedLine(headerCells(section)).length === tableWidth,
            `${title} header row is as wide as its data rows (${tableWidth})`)
    }

    // ------------------------------------------------------------------
    console.log('\n--- Shared columns line up across sections ---\n')

    for (const [section, title] of SECTIONS) {
        const header = sectionLines(rows, title)[0] ?? ''
        assert(header[widths.name + 2] === ' ',
            `${title}: the column after Name starts at the shared Name width (${widths.name})`)
        if (BATTERY_SECTIONS.includes(section)) {
            assert(trimmed(header).slice(-widths.batt) === 'Batt',
                `${title}: the Batt cell is exactly ${widths.batt} columns wide`)
        }
    }

    // ------------------------------------------------------------------
    console.log('\n--- Mains-powered mechanisms report no battery ---\n')

    assert(!SECTION_COLUMNS.mechanisms.some((column) => column.key === 'batt'),
        'Mechanisms has no Batt column')
    assert(widths.batt === 4,
        `Batt is still measured from the battery-reporting sections (${widths.batt})`)

    const mechanismHeader = sectionLines(rows, 'Mechanisms')[0] ?? ''
    const mechanismCells = SECTION_COLUMNS.mechanisms.map((column) => column.header)
    assert(mechanismCells.includes('Origin') && mechanismCells.length === 3,
        `Mechanisms is Name, State, Origin only (${mechanismCells.join(', ')})`)
    assert(trimmed(mechanismHeader).endsWith('Origin'),
        'a Mechanisms row ends at its Origin cell, with no empty Batt column behind it')
    const mechanismLines = sectionLines(rows, 'Mechanisms').slice(1).filter(l => !l.startsWith('  '))
    assert(fleet.mechanisms.every((entry) => {
        const line = mechanismLines.find(l => l.includes(entry.name)) ?? ''
        return trimmed(line).endsWith(entry.device.getStateOrigin())
    }), 'every Mechanisms row ends at its Origin value, with nothing behind it')

    // ------------------------------------------------------------------
    console.log('\n--- Nothing is truncated, nothing is glued ---\n')

    for (const entry of Object.values(fleet).flat()) {
        assert(rows.some(l => l.includes(entry.name)), `'${entry.name}' printed in full`)
    }

    const sparse = rows.find(l => l.includes('Kye No Flower')) ?? ''
    const full = rows.find(l => l.includes('Kye No Kitchen')) ?? ''
    assert(trimmed(sparse).length === trimmed(full).length && sparse.length > 0,
        `a sparse row keeps the grid of a full row (${trimmed(sparse).length} vs ${trimmed(full).length})`)

    const sparseCells = expectedRow(fleet.sensors.find(e => e.name === 'Kye No Flower'), 'sensors')
    assert(sparse.startsWith(expectedLine(sparseCells)),
        'a row ends with exactly the one trailing space of its last cell')

    const widest = Math.max(...rows.filter(l => trimmed(l) !== '').map(l => trimmed(l).length))
    assert(widest <= 74, `widest fleet row fits the 74-column floor (${widest})`)

    harness.win.destroy()
} finally {
    dcProto.getAll = origGetAll
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)

