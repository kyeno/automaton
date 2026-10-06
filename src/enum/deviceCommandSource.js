/**
 * DeviceCommandSource -- explicit provenance enum for commands dispatched.
 * {@link ../device/base/deviceBase.js#DeviceBase.receiveCommand}.
 * @module enum/deviceCommandSource
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

/** Command provenance constants indicating who is behind an outgoing command.
 * @readonly
 * @enum {string} */
const DeviceCommandSource = Object.freeze({
    AUTOMATION: 'automation',
    HUMAN: 'human'
})

export default DeviceCommandSource