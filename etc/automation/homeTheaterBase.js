/**
 * Home Theater Automation -- shared base class.
 * Video-player-driven dark mode for a room: while the player answers HTTP.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import RuleBasedAutomationBase from '../../src/automation/base/ruleBasedAutomationBase.js'

export default class HomeTheaterAutomation extends RuleBasedAutomationBase {
    /** Identity-bound constructor -- this base is not concrete on its own.
     * @param {{name?: string, configPath?: string}} [options] - Identity binding for this instance
     * @throws {Error} When called without an explicit name and config path */
    constructor(options = {}) {
        const { name, configPath } = options ?? {}
        if (!name || !configPath) {
            throw new Error(
                'HomeTheaterAutomation must be instantiated per room via a subclass that fixes its ' +
                'identity (e.g., HomeOfficeVideoAutomation / BedroomVideoAutomation)'
            )
        }
        super({ name, configPath })
    }

    /** Resolve a command for a target device from the matching rules.
     * @param {DeviceBase} device - Target device
     * @param {string} targetId - Rule-target key for the device -- its friendly name trimmed, whitespace collapsed to underscores (see toTargetKey in lib/string.js)
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @returns {{payload: object|string}|null} Object with payload, or null if no command found */
    resolveCommand(device, targetId, matchingRules) {
        return this.simpleResolveCommand(device, targetId, matchingRules)
    }
}
