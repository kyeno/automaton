/**
 * Roller Shutters Interaction Base (abstract).
 * Shared travel logic for remote-controlled roller shutter groups: a single.
 * button press runs the group fully open or fully closed, while a double.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceContainer from '../../device/container/deviceContainer.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'
import InteractionBase from './interactionBase.js'
import sound from '../../lib/sound.js'


/** Fully closed position reported by roller shutters.
 * @type {number} */
const POSITION_MIN = 0

/** Fully open position reported by roller shutters.
 * @type {number} */
const POSITION_MAX = 100

/** Distance in percent a double press moves each shutter.
 * @type {number} */
const STEP_PERCENT = 20

/** Tolerance in percent around each end stop that still counts as "at the
 * @type {number} */
const END_STOP_TOLERANCE = 2

/** Duration of each beep in the end-stop acknowledgement, in milliseconds.
 * @type {number} */
const AT_LIMIT_BEEP_DURATION_MS = 150


//  RollerShuttersBase (abstract)

/** Abstract base class for remote-controlled roller shutter groups. */
export default class RollerShuttersBase extends InteractionBase {

    //  -- Private state ----------------------------------------------------

    /** Friendly names of the shutters this group drives.
     * @type {ReadonlyArray<string>} */
    #shutters = []

    //  -- Constructor ------------------------------------------------------

    /** Construct a roller shutter group interaction.
     * @param {object} options - Constructor options
     * @param {string} options.name - Display name used in log context
     * @param {string[]} options.shutters - Friendly names of the shutters in the group
     * @throws {Error} When no shutter list is supplied */
    constructor({ name, shutters }) {
        super({ name })

        if (!Array.isArray(shutters) || shutters.length === 0) {
            throw new Error(
                `${name ?? 'RollerShuttersBase'} must be constructed with a non-empty "shutters" list`
            )
        }

        this.#shutters = Object.freeze([...shutters])
    }

    //  -- Accessors --------------------------------------------------------

    /** The shutter friendly names this group drives.
     * @returns {ReadonlyArray<string>} Frozen copy of the configured shutter list */
    getShutters() {
        return this.#shutters
    }

    //  -- Public API -------------------------------------------------------

    /** Main execution logic -- maps a remote button action onto a travel command.
     * @param {{action?: string}|null} [triggerData] - Data from the event trigger */
    execute(triggerData = null) {
        const action = triggerData?.action || null

        switch (action) {
            case '1_single': this.#travel('up', 0); break
            case '3_single': this.#travel('down', 0); break
            case '1_double': this.#travel('up', STEP_PERCENT); break
            case '3_double': this.#travel('down', STEP_PERCENT); break
            default:
                this.log(`Unknown action: ${action}`, 'warn')
        }
    }

    /** Audible acknowledgement that a command was dropped because the group. */
    notifyAtLimit() {
        sound.doubleBeep({ duration: AT_LIMIT_BEEP_DURATION_MS })
    }

    //  -- Extension points -------------------------------------------------

    /** Called after an OPEN travel was actually dispatched to the group. */
    onOpened() {}

    /** Called after a CLOSE travel was actually dispatched to the group. */
    onClosed() {}

    //  -- Private helpers --------------------------------------------------

    /** Run the group open/closed, or step it when `stepPercent` is non-zero.
     * @param {'up'|'down'} direction - Travel direction; "up" opens, "down" closes
     * @param {number} stepPercent - Percent to move by, or 0 for a full travel
     * @private */
    #travel(direction, stepPercent) {
        const label = stepPercent > 0
            ? `double ${direction} (+/-${stepPercent}%)`
            : `single ${direction}`
        const positions = this.#readPositions()
        const readout = positions.map(p => `${p.name}=${p.position ?? 'unknown'}`).join(', ')

        this.log(`${label} -- positions: ${readout}`)

        //  Gate: only a group that is provably parked at the end stop is refused.
        if (this.#isAllAtEndStop(positions, direction)) {
            this.log(`${label} ignored: every shutter is already at the ${direction} end stop -- beeping`)
            this.notifyAtLimit()
            return
        }

        const dispatched = stepPercent > 0
            ? this.#step(positions, direction === 'up' ? stepPercent : -stepPercent)
            : this.#sendToAll(positions, direction === 'up' ? 'OPEN' : 'CLOSE')

        if (dispatched === 0) {
            this.log(`${label} produced no command (no shutter could be resolved)`, 'warn')
            return
        }

        //  Side effects belong to a full travel only. A double press is a 20%
        if (stepPercent > 0) return

        if (direction === 'up') {
            this.onOpened()
        } else {
            this.onClosed()
        }
    }

    /** Read the cached position of every shutter in the group.
     * @returns {Array<{name: string, device: Object|null, position: (number|null)}>} One entry per configured shutter
     * @private */
    #readPositions() {
        return this.#shutters.map((name) => {
            const device = DeviceContainer.findByName(name)
            if (!device) {
                this.log(`Device "${name}" not found`, 'warn')
                return { name, device: null, position: null }
            }

            const state = device.getStateLast()
            const position = Number.isFinite(state?.position) ? state.position : null

            return { name, device, position }
        })
    }

    /** Whether every shutter in the group sits at the requested end stop.
     * @param {Array<{position: (number|null)}>} positions - Entries from #readPositions
     * @param {'up'|'down'} direction - Requested travel direction
     * @returns {boolean} true when all shutters are at that end stop
     * @private */
    #isAllAtEndStop(positions, direction) {
        return positions.every(({ position }) => {
            if (position === null) return false
            return direction === 'up'
                ? position >= POSITION_MAX - END_STOP_TOLERANCE
                : position <= POSITION_MIN + END_STOP_TOLERANCE
        })
    }

    /** Send a full-travel command to every shutter in the group.
     * @param {Array<{name: string, device: Object|null}>} positions - Entries from #readPositions
     * @param {string} command - Travel command (OPEN | CLOSE)
     * @returns {number} Number of shutters the command was handed to
     * @private */
    #sendToAll(positions, command) {
        let sent = 0

        for (const { name, device } of positions) {
            if (this.#sendTo(device, name, command)) sent++
        }

        return sent
    }

    /** Step every shutter by `delta` percent from its cached position, clamped.
     * @param {Array<{name: string, device: Object|null, position: (number|null)}>} positions - Entries from #readPositions
     * @param {number} delta - Signed percent to move by (positive opens, negative closes)
     * @returns {number} Number of shutters the command was handed to
     * @private */
    #step(positions, delta) {
        let sent = 0

        for (const { name, device, position } of positions) {
            if (position === null) {
                this.log(`Cannot step "${name}": no cached position -- skipped`, 'warn')
                continue
            }

            const target = Math.max(POSITION_MIN, Math.min(POSITION_MAX, Math.round(position + delta)))
            this.log(`Stepping "${name}": ${position} -> ${target}`)

            if (this.#sendTo(device, name, { position: target })) sent++
        }

        return sent
    }

    /** Hand a command to one shutter, tagging it as human-driven.
     * @param {Object|null} device - Resolved device, or null when it could not be found
     * @param {string} name - Shutter friendly name (for logging)
     * @param {string|Object} command - Travel command or `{position}` payload
     * @returns {boolean} true when the command was dispatched
     * @private */
    #sendTo(device, name, command) {
        if (!device) return false

        device.receiveCommand(command, DeviceCommandSource.HUMAN)
        return true
    }
}
