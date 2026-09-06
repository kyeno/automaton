/**
 * Home Theater Automation -- shared base class.
 *
 * Video-player-driven dark mode for a room: while the player answers HTTP
 * (any state -- playing, paused or stopped) the room's rollers are closed;
 * when the player is gone (machine off or player closed) they are handed back
 * to their default automation via invoke_automation; while a video is actively
 * playing interfering lights are switched off (dark mode); on pause/stop/gone
 * light restore is delegated to the ambient-lights owner.
 *
 * This class holds the shared semantics of that pattern and is deliberately
 * NOT instantiated directly by the container: it requires an explicit identity
 * ({name, configPath}) so each deployment gets one instance per room (e.g.,
 * homeOfficeVideoAutomation.js / bedroomVideoAutomation.js). Keeping the file
 * name free of "Automation" also keeps the container's discovery filter from
 * picking it up as a standalone automation.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import RuleBasedAutomationBase from '../../src/automation/base/ruleBasedAutomationBase.js'

export default class HomeTheaterAutomation extends RuleBasedAutomationBase {
    /**
     * Identity-bound constructor -- this base is not concrete on its own.
     *
     * Per-room subclasses pass their fixed identity; constructing without both
     * values fails fast with a descriptive error instead of registering a
     * phantom automation.
     *
     * @param {{name?: string, configPath?: string}} [options] - Identity binding for this instance
     * @throws {Error} When called without an explicit name and config path
     */
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

    /**
     * Resolve a command for a target device from the matching rules.
     *
     * Delegates to the shared first-rule-wins resolver in the rule-based base:
     * the first matching rule that defines a command for the target wins, with
     * ON/OFF mapped to `{state}`, OPEN/CLOSE to bare state strings, and numeric
     * values to `{position}` payloads.
     *
     * @param {DeviceBase} device - Target device
     * @param {string} targetId - Rule-target key for the device -- its friendly name trimmed, whitespace collapsed to underscores (see toTargetKey in lib/string.js)
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @returns {{payload: object|string}|null} Object with payload, or null if no command found
     */
    resolveCommand(device, targetId, matchingRules) {
        return this.simpleResolveCommand(device, targetId, matchingRules)
    }
}
