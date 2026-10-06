/**
 * Mechanism device type.
 *  Base class for actuators: lights, relays, roller shutters, etc.
 * Extends DeviceBase which provides Origin-based state tracking.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceBase from '../base/deviceBase.js'

/** Mechanism class that extends DeviceBase. */
export default class Mechanism extends DeviceBase {
    /** Thin identity constructor -- mechanisms layer origin classification on top.
     * @param {string} name - Display name used in log context
     * @param {string} id - Zigbee2MQTT friendly-name or device ID
     * @param {Record<string, unknown>} [data] - Raw device configuration object */
    constructor(name, id, data) {
        super(name, id, data)
    }

    /** Override: mechanisms are actuators whose state can be driven by both
     * @returns {boolean} true */
    shouldTrackOrigin() {
        return true
    }

    /** Return the log prefix label for mechanisms.
     * @returns {string} */
    getLogPrefix() {
        return 'Mechanism'
    }

    /** Get the current cached state of this mechanism.
     * @returns {string|null} Current state or null if unknown */
    async getCurrentState() {
        const cached = await this.getCachedState()
        return cached?.stateLast?.state || null
    }
}
