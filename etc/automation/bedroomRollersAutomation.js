/**
 * Bedroom Rollers Automation.
 * Rule-based blind controller for bedroom blinds.
 * Evaluates sensor readings against configured rules, then dispatches
 * commands to targets using "most-closed-wins" merge logic inherited
 * from the rule-based pattern.
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

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bedroom-rollers.yaml')

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export default class BedroomRollersAutomation extends RuleBasedAutomationBase {
    /**
     * Fixed identity constructor -- name and config path are constants of this automation.
     */
    constructor() {
        super({ name: 'BedroomRollersAutomation', configPath: CONFIG_PATH })
    }

    /**
     * Lifecycle hook -- blind rules need nothing beyond the rule-based base class.
     */
    async init() {
        await super.init()
    }

    /**
     * Delegate to the blinds-specific resolver in the base class ("most-closed-wins" merge).
     * @param {DeviceBase} device - Target device
     * @param {string} targetId - Identifier of the target (from config.targets[].id)
     * @param {{}[]} matchingRules - Rules whose conditions matched
     */
    resolveCommand(device, targetId, matchingRules) {
        return this.blindsResolveCommand(device, targetId, matchingRules)
    }
}