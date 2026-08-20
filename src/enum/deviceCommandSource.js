/**
 * DeviceCommandSource -- explicit provenance enum for commands dispatched via
 * {@link ../device/base/deviceBase.js#DeviceBase.receiveCommand}.
 *
 * Policy: ONLY autonomous rule-engine actions are attributed as "automation".
 * Every other actor is treated as human interaction:
 *
 *   AUTOMATION -- the command was issued by an Automation class acting on its own
 *                 rules/timers, without any direct human involvement right now.
 *   HUMAN      -- the command ultimately traces back to a person: physical remote
 *                 presses, YAML interactions, Home Assistant / zigbee2mqtt UI
 *                 actions routed through us, AND AI chat tool calls (the human
 *                 gave the AI the order).
 *
 * Consequences of the classification:
 *   - AUTOMATION commands register a causality token so their MQTT echoes are
 *     recognized and keep `stateOrigin = 'automation'`.
 *   - HUMAN commands cancel any pending automation expectation, set
 *     `stateOrigin = 'human'` immediately, and start the Redis human-interaction
 *     cooldown that makes automations back off from the device.
 *
 * @module enum/deviceCommandSource
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

/**
 * Command provenance constants indicating who is behind an outgoing command.
 *
 * @readonly
 * @enum {string}
 */
const DeviceCommandSource = Object.freeze({
    AUTOMATION: 'automation',
    HUMAN: 'human'
})

export default DeviceCommandSource