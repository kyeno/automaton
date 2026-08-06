/**
 * Mechanism device type.
 *  Base class for actuators: lights, relays, roller shutters, etc.
 *  Extends DeviceBase which provides Origin-based state tracking via
 *  CommandCorrelator (causality tokens).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceBase from '../base/deviceBase.js'

/**
 * Mechanism class that extends DeviceBase.
 *  Provides a receiveCommand method so other devices (Remotes) can interact
 *  via DeviceContainer instead of publishing directly to MQTT.
 *
 *  Automation/human distinction is handled by DeviceBase using an explicit Origin
 *  state machine and causality tokens:
 *    - Automation calls receiveCommand('ON', fromAutomation=true) -> origin set to 'automation',
 *      causality token registered with CommandCorrelator at publish time
 *    - MQTT echo matches token -> consumed, origin preserved as 'automation'
 *    - MQTT message does NOT match any token -> origin set to 'human'
 */
export default class Mechanism extends DeviceBase {
    constructor(name, id, data) {
        super(name, id, data)
    }

    /**
     * Return the log prefix label for mechanisms.
     * @returns {string}
     */
    getLogPrefix() {
        return 'Mechanism'
    }

    /**
     * Get the current cached state of this mechanism.
     *
     * @returns {string|null} Current state or null if unknown
     */
    async getCurrentState() {
        const cached = await this.getCachedState()
        return cached?.stateLast?.state || null
    }
}
