/**
 * Ambient Lights Automation.
 * Turns off leftover lights during morning hours once natural light becomes
 * sufficient, and turns on ambient lamps (socket-powered) once dusk settles.
 * Each rule acts at most once per day ("once: true"), after which humans have
 * full control until the next window opens.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import RuleBasedAutomationBase from '../../src/automation/base/ruleBasedAutomationBase.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ambient-lights.yaml')

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export default class AmbientLightsAutomation extends RuleBasedAutomationBase {
    /**
     * @param {string} [configPath] - Override for the YAML config path (used by tests)
     */
    constructor(configPath = CONFIG_PATH) {
        super({ name: 'AmbientLightsAutomation', configPath })
    }

    /**
     * Lifecycle hook -- ambient lights need nothing beyond the rule-based base class;
     * kept explicit so future per-automation initialization has an obvious home.
     */
    async init() {
        await super.init()
    }

    /**
     * Resolve command using first matching rule's per-target action field -- delegates to the
     * base-class simpleResolveCommand() so scalar actions map to state/position payloads while
     * structured object commands (e.g. `{state: 'ON', brightness: {l1, l2}}`) pass through
     * verbatim to dimmer devices instead of being collapsed to a bare `{state}` payload.
     * 
     * @param {DeviceBase} device - Target device
     * @param {string} targetId - Rule-target key for the device -- its friendly name trimmed, whitespace collapsed to underscores (see toTargetKey in lib/string.js)
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @returns {{payload: object}|null} Object with payload, or null if no command found
     */
    resolveCommand(device, targetId, matchingRules) {
        return this.simpleResolveCommand(device, targetId, matchingRules)
    }
}