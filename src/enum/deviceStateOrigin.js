/**
 * DeviceStateOrigin -- explicit state provenance enum for device state tracking.
 *
 * Determines the source of truth for who caused the current device state:
 *
 *   'unknown'      -- initial state, or after restart (conservative: don't block)
 *   'automation'   -- the current state was set by an autonomous rule-engine action
 *   'human'        -- the current state was set by any human-directed actor: physical
 *                     remote, wall switch, YAML interaction, Home Assistant / z2m UI,
 *                     OR an AI chat command (a person gave the AI the order)
 *
 * Transitions:
 *   unknown    -- rule-engine command     --> automation (token registered at publish time)
 *   unknown    -- human-directed command  --> human (immediately; cooldown starts)
 *   unknown    -- unmatched MQTT change   --> human (cooldown starts)
 *   automation -- echo/continuation match --> automation (confirmed own motion)
 *   automation -- conflicting/stalled motion --> human (external override detected)
 *   automation -- unmatched MQTT change   --> human (no live token explains it)
 *   human      -- rule-engine command     --> automation
 *   human      -- any other input         --> human (no change)
 *
 * @module enum/deviceStateOrigin
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

/**
 * State provenance constants indicating the origin of device state changes.
 *
 * @readonly
 * @enum {string}
 */
const DeviceStateOrigin = Object.freeze({
    UNKNOWN: 'unknown',
    AUTOMATION: 'automation',
    HUMAN: 'human'
})

export default DeviceStateOrigin