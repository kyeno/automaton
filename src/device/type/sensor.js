/**
 * Sensor device type.
 *  Base sensor implementation extending DeviceBase.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceBase from '../base/deviceBase.js'
import LoggerService from '../../service/loggerService.js'

/**
 * Sensor class.
 *  Extends DeviceBase for sensor-type devices.
 *  All sensor messages are logged at info level.
 */
export default class Sensor extends DeviceBase {

    /**
     * Create Sensor object.
     *
     * @constructor
     * @param {string} name Device name
     * @param {string} id Device ID
     * @param {Object} data Device data
     */
    constructor(name, id, data) {
        super(name, id, data)
    }

    /**
     * Return the log prefix label for sensors.
     * @returns {string}
     */
    getLogPrefix() {
        return 'Sensor'
    }

    /**
     * Override logging to use info level for all sensor messages.
     *
     * @param {string} message - Message to log
     */
    log(message) {
        LoggerService.info(message, `${this.getLogPrefix()}:${this.getName()}`)
    }
}
