/**
 * Device Window -- Window 2.
 * Displays device information and system stats in a structured table format.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceContainer from '../../device/container/deviceContainer.js'
import EventBus from '../../service/eventBus.js'
import { measureColumns, renderRow } from '../../lib/terminal.js'
import { interpolateTokens } from '../../lib/string.js'
import temporal from '../../lib/date.js'
import solar from '../../lib/sun.js'
import AnsiColors from '../../enum/ansiColors.js'
import BaseWindow from './baseWindow.js'

//  Section column layouts.
//  Widths are NOT fixed: measureColumns() sizes every column to the longest
//  text it actually holds (header label included), and renderRow() wraps each
//  cell in one leading and one trailing space. Columns shared by more than one
//  section (name, batt) are sized across all of them, so the sections of the
//  window line up against each other instead of drifting.
//
//  Batt belongs to the battery-powered sections only. Mechanisms sit on mains
//  power and report no battery at all, so their table has no Batt column --
//  a permanently empty column would only steal width from the rest of the row.

const NAME_COL = { key: 'name', header: 'Name', align: 'left' }
const BATT_COL = { key: 'batt', header: 'Batt', align: 'right' }

const SENSOR_COLUMNS = [
    NAME_COL,
    { key: 'temp', header: 'Temp', align: 'right' },
    { key: 'humid', header: 'Humid', align: 'right' },
    { key: 'press', header: 'Press', align: 'right' },
    { key: 'light', header: 'Light', align: 'right' },
    BATT_COL,
]

const MECHANISM_COLUMNS = [
    NAME_COL,
    { key: 'state', header: 'State', align: 'right' },
    { key: 'origin', header: 'Origin', align: 'right' },
]

const REMOTE_COLUMNS = [
    NAME_COL,
    { key: 'action', header: 'Action', align: 'right' },
    BATT_COL,
]

const UNCLASSIFIED_COLUMNS = [
    NAME_COL,
    { key: 'lastseen', header: 'Last seen', align: 'right' },
    BATT_COL,
]

//  DeviceWindow.

/** Device status table displayed in the terminal UI. */
class DeviceWindow extends BaseWindow {

    #refreshInterval
    /** Per-device zigbee:<name> listeners -- rebuilt wholesale on devices:ready. */
    #unsubscribes = []
    /** Lifetime 'devices:ready' listener; kept separate so resubscription never drops it. */
    #unsubscribeReady = null
    /** Lines from the last painted frame; used to skip redraws when content is unchanged. */
    #lastRenderedLines = null
    #channelShortcut

    //  -- Initialization ---------------------------------------------------

    /** Create a new DeviceWindow instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     * @param {number} channelShortcut - Numeric shortcut from channel config */
    constructor(term, layout, channelShortcut = 2) {
        super('Devices', term, layout, channelShortcut)
        this.#channelShortcut = channelShortcut

        //  Listen for 'devices:ready' from DeviceContainer. This fires once.
        this.#unsubscribeReady = EventBus.subscribe('devices:ready', () => this.#resubscribeDevices())
    }

    //  -- Public API -------------------------------------------------------

    /** Show this window, refresh the content immediately, and start periodic updates. */
    show() {
        super.show()
        this.refresh()
        this.#startRefreshTimer()
    }

    /** Hide this window and stop the periodic refresh timer. */
    hide() {
        this.#stopRefreshTimer()
        super.hide()
    }

    /** Destroy this window: stop timers, unsubscribe from events, hide, and clear. */
    destroy() {
        this.#stopRefreshTimer()
        this.#unsubscribes.forEach(unsub => unsub())
        this.#unsubscribes = []
        if (this.#unsubscribeReady) {
            this.#unsubscribeReady()
            this.#unsubscribeReady = null
        }
        this.hide()
    }

    //  -- Callbacks --------------------------------------------------------

    /** Gathers current system state and pushes it to the window buffer. */
    refresh() {
        //  Bridge/coordinator entry is excluded at the source (DeviceContainer).
        const allDevices = DeviceContainer.getAll({ includeBridge: false })

        const sensors = []
        const mechanisms = []
        const remotes = []
        const unclassified = []

        for (const [name, device] of Object.entries(allDevices)) {
            const prefix = device.getLogPrefix?.() || 'Device'

            if (prefix === 'Sensor') {
                sensors.push({ name, device })
            } else if (prefix === 'Remote') {
                remotes.push({ name, device })
            } else if (device.shouldTrackOrigin?.() === true) {
                //  Actuators only -- Mechanism and its multi-channel subclasses.
                mechanisms.push({ name, device })
            } else {
                //  No type mapping resolved, so this is a DummyDevice. Listing it under
                //  Mechanisms would claim it answers power commands, which is exactly the
                //  friendly-name-drift trap: a renamed soil probe used to land here.
                unclassified.push({ name, device })
            }
        }

        //  Sort each group alphabetically by name.
        sensors.sort((a, b) => a.name.localeCompare(b.name))
        mechanisms.sort((a, b) => a.name.localeCompare(b.name))
        remotes.sort((a, b) => a.name.localeCompare(b.name))
        unclassified.sort((a, b) => a.name.localeCompare(b.name))

        //  Build every section's cell model first: the column widths have to be
        //  measured across the whole frame, so a column shared by two sections
        //  (name, batt) comes out the same width in both of them.
        const sections = []
        if (sensors.length > 0) sections.push(this.#buildSensors(sensors))
        if (mechanisms.length > 0) sections.push(this.#buildMechanisms(mechanisms))
        if (remotes.length > 0) sections.push(this.#buildRemotes(remotes))
        if (unclassified.length > 0) sections.push(this.#buildUnclassified(unclassified))

        const widths = measureColumns(sections)

        const lines = []

        //  -- Date / solar header -------------------------------------------
        this.#renderHeader(lines)

        //  -- Device sections (sensors, mechanisms, remotes, unclassified) ----
        sections.forEach((section, index) => {
            if (index > 0) {
                lines.push('')
            }
            this.#renderSection(section, widths, lines)
        })

        //  -- Summary footer --------------------------------------------
        const totalDevices = sensors.length + mechanisms.length + remotes.length + unclassified.length
        lines.push('')
        lines.push(
            AnsiColors.dim + 'Devices: ' + totalDevices +
            ' | Sensors: ' + sensors.length +
            ' | Mechanisms: ' + mechanisms.length +
            ' | Remotes: ' + remotes.length +
            (unclassified.length > 0 ? ' | Unclassified: ' + unclassified.length : '') +
            AnsiColors.reset
        )

        //  Skip the redraw when nothing changed since the previous frame.
        if (this.#sameLines(this.#lastRenderedLines, lines)) {
            return
        }
        this.#lastRenderedLines = lines

        //  Clear buffer and push all current lines for a fresh dashboard view.
        //  Preformatted: the table's cell padding is significant whitespace, and the
        //  plain print() path word-wraps and collapses it back into glued columns.
        this.clear()
        this.printPreformatted(lines.join('\n'))
    }

    /** Compare two rendered line arrays element-wise for strict equality.
     * @param {string[]|null} previous - Lines from the last painted frame
     * @param {string[]} next - Newly built lines
     * @returns {boolean} true when both frames are identical
     * @private */
    #sameLines(previous, next) {
        if (!previous || previous.length !== next.length) return false
        for (let i = 0; i < next.length; i++) {
            if (previous[i] !== next[i]) return false
        }
        return true
    }

    //  -- Section builders -----------------------------------------------------

    /** Paint one section: its title, a header row, its data rows and any trailing
     *  summary lines. Header and data rows go through the very same renderer, so a
     *  header label always sits in the exact cell boundaries of its column.
     * @private
     * @param {Object} section - Section model produced by a #build* builder
     * @param {Record<string, number>} widths - Column widths measured over the whole frame
     * @param {Array<string>} lines - Row buffer that receives the rendered section */
    #renderSection(section, widths, lines) {
        const alignOf = {}
        for (const column of section.columns) {
            alignOf[column.key] = column.align
        }

        lines.push(section.title)
        lines.push(renderRow(
            section.columns.map((column) => ({
                key: column.key,
                text: column.header,
                color: AnsiColors.dim,
                align: column.align,
            })),
            widths
        ))

        for (const row of section.rows) {
            lines.push(renderRow(row.map((cell) => ({ ...cell, align: alignOf[cell.key] })), widths))
        }

        for (const extra of section.trailing) {
            lines.push(extra)
        }
    }

    /** Build the Sensors section model.
     * @private
     * @param {Array<Object>} sensors - Sensor device instances collected by the caller
     * @returns {Object} Section model: title, columns, rows, trailing lines */
    #buildSensors(sensors) {
        const rows = []

        for (const { name, device } of sensors) {
            const stateLast = device.getStateLast?.() || {}
            const temperature = stateLast.temperature ?? null
            const humidity = stateLast.humidity ?? stateLast.soil_moisture ?? null
            const pressure = stateLast.pressure ?? null
            const illuminance = stateLast.illuminance ?? null
            const battery = stateLast.battery ?? null

            rows.push([
                { key: 'name', text: name, color: AnsiColors.bold },
                { key: 'temp', text: temperature != null ? Number(temperature).toFixed(1) + '*C' : '' },
                { key: 'humid', text: humidity != null ? String(humidity) + '%' : '' },
                { key: 'press', text: pressure != null ? Math.round(pressure) + 'hPa' : '' },
                { key: 'light', text: illuminance != null ? Math.round(illuminance) + 'lx' : '' },
                {
                    key: 'batt',
                    text: battery != null ? String(battery) + '%' : '',
                    color: battery != null ? this.#getBatteryColor(battery) : '',
                },
            ])
        }

        return {
            title: AnsiColors.bold + AnsiColors.cyan +
                '-- Sensors (' + sensors.length + ') --' + AnsiColors.reset,
            columns: SENSOR_COLUMNS,
            rows,
            trailing: [],
        }
    }

    /** Build the Mechanisms section model.
     * @private
     * @param {Array<Object>} mechanisms - Mechanism device instances collected by the caller
     * @returns {Object} Section model: title, columns, rows, trailing lines */
    #buildMechanisms(mechanisms) {
        let totalOn = 0, totalOff = 0, totalUnknown = 0
        const rows = []

        for (const { name, device } of mechanisms) {
            const stateLast = device.getStateLast?.() || {}
            const origin = device.getStateOrigin?.() || 'unknown'

            const rawState = stateLast.state || stateLast.power_on_state || ''
            const position = stateLast.position ?? null

            let status
            const channels = device.getChannels?.()
            if (Array.isArray(channels) && channels.length > 0) {
                //  Multi-channel device: render per-channel state with positional.
                const parts = []
                let anyOn = false
                let anyOff = false
                for (const ch of channels) {
                    const st = stateLast[`state_${ch}`]
                    if (st === undefined) continue
                    const up = String(st).toUpperCase()
                    let part = up
                    const br = stateLast[`brightness_${ch}`]
                    if (Number.isFinite(Number(br)) && Number(br) > 0) {
                        part += ` ${Math.round((Number(br) / 254) * 100)}%`
                    }
                    parts.push(part)
                    if (up === 'ON') anyOn = true
                    else if (up === 'OFF') anyOff = true
                }
                if (parts.length > 0) {
                    status = parts.join(' / ')
                    if (anyOn) totalOn++
                    else if (anyOff) totalOff++
                    else totalUnknown++
                } else {
                    status = '-'
                    totalUnknown++
                }
            } else if (position !== null) {
                status = Math.round(position) + '%'
            } else if (rawState) {
                status = String(rawState).toUpperCase()
                if (status === 'ON') totalOn++
                else totalOff++
            } else {
                status = '-'
                totalUnknown++
            }

            rows.push([
                { key: 'name', text: name, color: AnsiColors.bold },
                { key: 'state', text: status, color: AnsiColors.cyan },
                { key: 'origin', text: origin, color: this.#getOriginColor(origin) },
            ])
        }

        return {
            title: AnsiColors.bold + AnsiColors.cyan +
                '-- Mechanisms (' + mechanisms.length + ') --' + AnsiColors.reset,
            columns: MECHANISM_COLUMNS,
            rows,
            //  Mechanisms summary.
            trailing: [
                AnsiColors.dim + '  ON: ' + totalOn + ' | OFF: ' + totalOff + ' | Unknown: ' + totalUnknown + AnsiColors.reset,
            ],
        }
    }

    /** Build the Remotes section model.
     * @private
     * @param {Array<Object>} remotes - Remote device instances collected by the caller
     * @returns {Object} Section model: title, columns, rows, trailing lines */
    #buildRemotes(remotes) {
        const rows = []

        for (const { name, device } of remotes) {
            const stateLast = device.getStateLast?.() || {}
            const action = stateLast.action ?? null
            const battery = stateLast.battery ?? null

            rows.push([
                { key: 'name', text: name, color: AnsiColors.bold },
                { key: 'action', text: action != null ? String(action) : '', color: AnsiColors.grey },
                {
                    key: 'batt',
                    text: battery != null ? String(battery) + '%' : '',
                    color: battery != null ? this.#getBatteryColor(battery) : '',
                },
            ])
        }

        return {
            title: AnsiColors.bold + AnsiColors.cyan +
                '-- Remotes (' + remotes.length + ') --' + AnsiColors.reset,
            columns: REMOTE_COLUMNS,
            rows,
            trailing: [],
        }
    }

    /** Build the Unclassified section model -- devices the container resolved to DummyDevice
     *  because no type mapping matched their friendly name. They are listed here, never
     *  as mechanisms: a dummy answers power commands by faking a state change, so a
     *  mechanism row for a soil probe is a lie about the hardware.
     * @private
     * @param {Array<Object>} unclassified - Device instances without a resolved type
     * @returns {Object} Section model: title, columns, rows, trailing lines */
    #buildUnclassified(unclassified) {
        const rows = []

        for (const { name, device } of unclassified) {
            const stateLast = device.getStateLast?.() || {}
            const battery = stateLast.battery ?? null
            const seenAt = device.getStateLastAt?.() ?? null

            let seenText = '-'
            if (seenAt) {
                const when = seenAt instanceof Date ? seenAt : new Date(seenAt)
                if (!Number.isNaN(when.getTime())) seenText = temporal.formatClockTime(when)
            }

            rows.push([
                { key: 'name', text: name, color: AnsiColors.bold },
                { key: 'lastseen', text: seenText, color: AnsiColors.grey },
                {
                    key: 'batt',
                    text: battery != null ? String(battery) + '%' : '',
                    color: battery != null ? this.#getBatteryColor(battery) : '',
                },
            ])
        }

        return {
            title: AnsiColors.bold + AnsiColors.yellow +
                '-- Unclassified (' + unclassified.length + ') --' + AnsiColors.reset,
            columns: UNCLASSIFIED_COLUMNS,
            rows,
            trailing: [
                AnsiColors.dim + '  No type mapping -- check these names against etc/device/zigbee.yaml' + AnsiColors.reset,
            ],
        }
    }

    //  -- Private Helpers --------------------------------------------------

    /** Render the header line: the localized current date plus today's sunrise/sunset.
     * @param {string[]} lines - Buffer to append the header lines to
     * @private */
    #renderHeader(lines) {
        const now = new Date()
        const bundle = temporal.loadDateBundle() ?? {}
        const template = (typeof bundle.date_sentence === 'string' && bundle.date_sentence.trim() !== '')
            ? bundle.date_sentence
            : '{% day_name %}, {% day %} {% month_name %} {% year %}'
        const dateText = interpolateTokens(template, temporal.getDateParts(now))

        const { sunrise, sunset } = solar.getSunriseSunset(now)
        const clock = (moment) => (moment instanceof Date ? temporal.formatClockTime(moment) : '--:--')

        lines.push(
            AnsiColors.dim + dateText +
            ' | Sunrise: ' + clock(sunrise) +
            ' | Sunset: ' + clock(sunset) +
            AnsiColors.reset
        )
        lines.push('')
    }

    /** Return an ANSI color code based on the command origin.
     * @param {string} origin - One of 'human', 'automation', or fallback
     * @returns {string} ANSI SGR color code
     * @private */
    #getOriginColor(origin) {
        if (origin === 'human') return AnsiColors.green
        if (origin === 'automation') return AnsiColors.magenta
        return AnsiColors.grey
    }

    /** Return a warning color for low battery levels.
     * @param {number} battery - Battery percentage (0-100)
     * @returns {string} ANSI SGR color code (red <=15%, yellow <=30%, empty otherwise)
     * @private */
    #getBatteryColor(battery) {
        if (battery != null && battery <= 15) return AnsiColors.red
        if (battery != null && battery <= 30) return AnsiColors.yellow
        return ''
    }

    /** Clean up existing subscriptions and subscribe to zigbee:<deviceName> channels
     * @private */
    #resubscribeDevices() {
        //  Clean up any previous subscriptions so we don't stack them.
        this.#unsubscribes.forEach(unsub => unsub())
        this.#unsubscribes = []

        const allDevices = DeviceContainer.getAll({ includeBridge: false })

        for (const [name] of Object.entries(allDevices)) {
            const unsub = EventBus.subscribe(`zigbee:${name}`, () => {
                if (this.isVisible) {
                    this.render()
                }
                EventBus.emit('window:activity', this.#channelShortcut)
            })

            if (unsub) {
                this.#unsubscribes.push(unsub)
            }
        }
    }

    /** Start the periodic refresh timer (every 5 seconds).
     * @private */
    #startRefreshTimer() {
        this.#stopRefreshTimer()
        this.#refreshInterval = setInterval(() => this.refresh(), 5000)
    }

    /** Stop the periodic refresh timer.
     * @private */
    #stopRefreshTimer() {
        if (this.#refreshInterval) {
            clearInterval(this.#refreshInterval)
            this.#refreshInterval = null
        }
    }
}

export default DeviceWindow