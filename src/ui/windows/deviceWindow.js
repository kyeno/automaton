/**
 * Device Window -- Window 2.
 *
 * Displays device information and system stats in a structured table format.
 * Extends BaseWindow for consistent buffering and rendering.
 *
 * Dependencies: receives `term` and `layout` via constructor.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceContainer from '../../device/container/deviceContainer.js'
import EventBus from '../../service/eventBus.js'
import { padVisible, colCell } from '../../lib/terminal.js'
import AnsiColors from '../../enum/ansiColors.js'
import BaseWindow from './baseWindow.js'

// ---------------------------------------------------------------------------
// Column widths (fixed-width alignment, no tabs)
// ---------------------------------------------------------------------------

const NAME_W = 35
const STATE_W = 8
const ORIGIN_W = 11
const BATT_W = 5
const TEMP_W = 7
const HUMID_W = 6
const PRESS_W = 8
const LIGHT_W = 7
const ACTION_W = 10

// ---------------------------------------------------------------------------
// DeviceWindow
// ---------------------------------------------------------------------------

/**
 * Device status table displayed in the terminal UI.
 * Renders a fixed-width table showing device name, state, origin, battery,
 * temperature, humidity, pressure, illuminance, and last action for all
 * registered devices. Refreshes reactively via EventBus subscriptions.
 */
class DeviceWindow extends BaseWindow {

    #refreshInterval
    #unsubscribes = []
    #channelShortcut

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new DeviceWindow instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     * @param {number} channelShortcut - Numeric shortcut from channel config
     */
    constructor(term, layout, channelShortcut = 2) {
        super('Devices', term, layout, channelShortcut)
        this.#channelShortcut = channelShortcut

        // Listen for 'devices:ready' from DeviceContainer. This fires once after
        // initial device discovery completes, and again when a device is dynamically
        // added. DeviceWindow reacts by subscribing to all known zigbee:<device> channels.
        // Unsub stored so destroy() releases it like every other subscription.
        this.#unsubscribes.push(EventBus.subscribe('devices:ready', () => this.#resubscribeDevices()))
    }

    // -- Public API -------------------------------------------------------

    /**
     * Show this window, refresh the content immediately, and start periodic updates.
     */
    show() {
        super.show()
        this.refresh()
        this.#startRefreshTimer()
    }

    /**
     * Hide this window and stop the periodic refresh timer.
     */
    hide() {
        this.#stopRefreshTimer()
        super.hide()
    }

    /**
     * Destroy this window: stop timers, unsubscribe from events, hide, and clear.
     */
    destroy() {
        this.#stopRefreshTimer()
        this.#unsubscribes.forEach(unsub => unsub())
        this.#unsubscribes = []
        this.hide()
    }

    // -- Callbacks --------------------------------------------------------

    /**
     * Gathers current system state and pushes it to the window buffer.
     * Devices are grouped by type: Sensors -> Mechanisms -> Remotes.
     */
    refresh() {
        // Bridge/coordinator entry is excluded at the source (DeviceContainer).
        const allDevices = DeviceContainer.getAll({ includeBridge: false })

        const sensors = []
        const mechanisms = []
        const remotes = []

        for (const [name, device] of Object.entries(allDevices)) {
            const prefix = device.getLogPrefix?.() || 'Device'

            if (prefix === 'Sensor') {
                sensors.push({ name, device })
            } else if (prefix === 'Remote') {
                remotes.push({ name, device })
            } else {
                // Mechanism (or fallback)
                mechanisms.push({ name, device })
            }
        }

        // Sort each group alphabetically by name
        sensors.sort((a, b) => a.name.localeCompare(b.name))
        mechanisms.sort((a, b) => a.name.localeCompare(b.name))
        remotes.sort((a, b) => a.name.localeCompare(b.name))

        const lines = []

        // -- Sensors section -------------------------------------------
        if (sensors.length > 0) {
            this.#renderSensors(sensors, lines)
        }

        // -- Mechanisms section ----------------------------------------
        if (mechanisms.length > 0) {
            lines.push('')
            this.#renderMechanisms(mechanisms, lines)
        }

        // -- Remotes section -------------------------------------------
        if (remotes.length > 0) {
            lines.push('')
            this.#renderRemotes(remotes, lines)
        }

        // -- Summary footer --------------------------------------------
        const totalDevices = sensors.length + mechanisms.length + remotes.length
        lines.push('')
        lines.push(
            AnsiColors.dim + 'Devices: ' + totalDevices +
            ' | Sensors: ' + sensors.length +
            ' | Mechanisms: ' + mechanisms.length +
            ' | Remotes: ' + remotes.length +
            AnsiColors.reset
        )

        // Clear buffer and push all current lines for a fresh dashboard view
        this.clear()
        lines.forEach(line => this.print(line))
    }

    // -- Section renderers --------------------------------------------------

    /**
     * Render the Sensors section.
     * Columns: Name  Temp  Humid  Light  Batt
     * @private
     */
    #renderSensors(sensors, lines) {
        const header = AnsiColors.bold + AnsiColors.cyan +
            '-- Sensors (' + sensors.length + ') --' + AnsiColors.reset
        lines.push(header)

        // Header row (spaces between columns for readability)
        let hdr = ''
        hdr += 'Name'.padEnd(NAME_W)
        hdr += ' Temp'.padEnd(TEMP_W + 1)
        hdr += ' Humid'.padEnd(HUMID_W + 1)
        hdr += ' Press'.padStart(PRESS_W)
        hdr += ' Light'.padStart(LIGHT_W)
        hdr += ' Batt'.padStart(BATT_W)
        lines.push(AnsiColors.dim + hdr + AnsiColors.reset)

        for (const { name, device } of sensors) {
            const stateLast = device.getStateLast?.() || {}
            const temperature = stateLast.temperature ?? null
            const humidity = stateLast.humidity ?? null
            const pressure = stateLast.pressure ?? null
            const illuminance = stateLast.illuminance ?? null
            const battery = stateLast.battery ?? null

            let line = ''

            // Name column (bold name, padded to NAME_W visible width)
            line += padVisible(AnsiColors.bold + name + AnsiColors.reset, NAME_W, 'left')

            // Temperature column (right-aligned, formatted as "24.2*C")
            if (temperature != null) {
                const tempStr = Number(temperature).toFixed(1) + '*C'
                line += ' ' + tempStr.padStart(TEMP_W)
            } else {
                line += ' '.repeat(TEMP_W + 1)
            }

            // Humidity column (spaced from temp with a separator space)
            if (humidity != null) {
                const humStr = String(humidity) + '% '
                line += ' ' + humStr.padStart(HUMID_W + 1)
            } else {
                line += ' '.repeat(HUMID_W + 2)
            }

            // Pressure column
            if (pressure != null) {
                const pressStr = `${Math.round(pressure)}hPa`
                line += pressStr.padStart(PRESS_W)
            } else {
                line += ' '.repeat(PRESS_W)
            }

            // Illuminance column
            if (illuminance != null) {
                const lxStr = Math.round(illuminance) + 'lx'
                line += lxStr.padStart(LIGHT_W)
            } else {
                line += '-'.padStart(LIGHT_W)
            }

            // Battery column (color-coded warning)
            if (battery != null) {
                const battColor = this.#getBatteryColor(battery)
                line += colCell(String(battery) + '%', battColor, BATT_W, 'right')
            } else {
                line += ' '.repeat(BATT_W)
            }

            lines.push(line)
        }
    }

    /**
     * Render the Mechanisms section.
     * Columns: Name  State  Origin  Batt
     * @private
     */
    #renderMechanisms(mechanisms, lines) {
        let totalOn = 0, totalOff = 0, totalUnknown = 0

        const header = AnsiColors.bold + AnsiColors.cyan +
            '-- Mechanisms (' + mechanisms.length + ') --' + AnsiColors.reset
        lines.push(header)

        // Header row
        let hdr = ''
        hdr += 'Name'.padEnd(NAME_W)
        hdr += 'State'.padStart(STATE_W)
        hdr += 'Origin'.padStart(ORIGIN_W)
        hdr += 'Batt'.padStart(BATT_W)
        lines.push(AnsiColors.dim + hdr + AnsiColors.reset)

        for (const { name, device } of mechanisms) {
            const stateLast = device.getStateLast?.() || {}
            const origin = device.getStateOrigin?.() || 'unknown'

            const rawState = stateLast.state || stateLast.power_on_state || ''
            const position = stateLast.position ?? null
            const battery = stateLast.battery ?? null

            let status
            if (position !== null) {
                status = Math.round(position) + '%'
            } else if (rawState) {
                status = String(rawState).toUpperCase()
                if (status === 'ON') totalOn++
                else totalOff++
            } else {
                status = '-'
                totalUnknown++
            }

            let line = ''

            // Name column
            line += padVisible(AnsiColors.bold + name + AnsiColors.reset, NAME_W, 'left')

            // State column (cyan, right-aligned)
            line += colCell(status, AnsiColors.cyan, STATE_W, 'right')

            // Origin column (color-coded, right-aligned)
            const oColor = this.#getOriginColor(origin)
            line += colCell(origin, oColor, ORIGIN_W, 'right')

            // Battery column
            if (battery != null) {
                const battColor = this.#getBatteryColor(battery)
                line += colCell(String(battery) + '%', battColor, BATT_W, 'right')
            } else {
                line += ' '.repeat(BATT_W)
            }

            lines.push(line)
        }

        // Mechanisms summary
        lines.push(
            AnsiColors.dim + '  ON: ' + totalOn + ' | OFF: ' + totalOff + ' | Unknown: ' + totalUnknown + AnsiColors.reset
        )
    }

    /**
     * Render the Remotes section.
     * Columns: Name  Last Action  Batt
     * @private
     */
    #renderRemotes(remotes, lines) {
        const header = AnsiColors.bold + AnsiColors.cyan +
            '-- Remotes (' + remotes.length + ') --' + AnsiColors.reset
        lines.push(header)

        // Header row
        let hdr = ''
        hdr += 'Name'.padEnd(NAME_W)
        hdr += 'Action'.padStart(ACTION_W)
        hdr += 'Batt'.padStart(BATT_W)
        lines.push(AnsiColors.dim + hdr + AnsiColors.reset)

        for (const { name, device } of remotes) {
            const stateLast = device.getStateLast?.() || {}
            const action = stateLast.action ?? null
            const battery = stateLast.battery ?? null

            let line = ''

            // Name column
            line += padVisible(AnsiColors.bold + name + AnsiColors.reset, NAME_W, 'left')

            // Action column (grey, right-aligned)
            if (action != null && action !== '') {
                line += colCell(String(action), AnsiColors.grey, ACTION_W, 'right')
            } else {
                line += ' '.repeat(ACTION_W)
            }

            // Battery column
            if (battery != null) {
                const battColor = this.#getBatteryColor(battery)
                line += colCell(String(battery) + '%', battColor, BATT_W, 'right')
            } else {
                line += ' '.repeat(BATT_W)
            }

            lines.push(line)
        }
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Return an ANSI color code based on the command origin.
     *
     * @param {string} origin - One of 'human', 'automation', or fallback
     * @returns {string} ANSI SGR color code
     * @private
     */
    #getOriginColor(origin) {
        if (origin === 'human') return AnsiColors.green
        if (origin === 'automation') return AnsiColors.magenta
        return AnsiColors.grey
    }

    /**
     * Return a warning color for low battery levels.
     *
     * @param {number} battery - Battery percentage (0-100)
     * @returns {string} ANSI SGR color code (red <=15%, yellow <=30%, empty otherwise)
     * @private
     */
    #getBatteryColor(battery) {
        if (battery != null && battery <= 15) return AnsiColors.red
        if (battery != null && battery <= 30) return AnsiColors.yellow
        return ''
    }

    /**
     * Clean up existing subscriptions and subscribe to zigbee:<deviceName> channels
     * for every known device. Called when 'devices:ready' is emitted by DeviceContainer
     * -- both after initial load and on dynamic device addition.
     * @private
     */
    #resubscribeDevices() {
        // Clean up any previous subscriptions so we don't stack them
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

    /**
     * Start the periodic refresh timer (every 5 seconds).
     * @private
     */
    #startRefreshTimer() {
        this.#stopRefreshTimer()
        this.#refreshInterval = setInterval(() => this.refresh(), 5000)
    }

    /**
     * Stop the periodic refresh timer.
     * @private
     */
    #stopRefreshTimer() {
        if (this.#refreshInterval) {
            clearInterval(this.#refreshInterval)
            this.#refreshInterval = null
        }
    }
}

export default DeviceWindow