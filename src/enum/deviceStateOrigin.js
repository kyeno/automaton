/**
 * DeviceStateOrigin -- explicit state provenance enum for device state tracking.
 * Determines the source of truth for who caused the current device state:
 * @module enum/deviceStateOrigin
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

/** State provenance constants indicating the origin of device state changes.
 * @readonly
 * @enum {string} */
const DeviceStateOrigin = Object.freeze({
    UNKNOWN: 'unknown',
    AUTOMATION: 'automation',
    HUMAN: 'human'
})

export default DeviceStateOrigin