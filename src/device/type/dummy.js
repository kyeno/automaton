/**
 * Dummy device type.
 *  Concrete device that provides no special behavior beyond DeviceBase.
 *  Used as the fallback for devices without a custom type.
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
 * DummyDevice class.
 *  Extends DeviceBase with no additional behavior.
 *  All devices use this type unless a custom type is assigned.
 */
export default class DummyDevice extends DeviceBase {

    /**
     * Create DummyDevice object.
     *
     * @constructor
     * @param {string} name Device name
     * @param {string} id Device ID
     * @param {Object} data Device data
     */
    constructor(name, id, data) {
        super(name, id, data)
    }
}