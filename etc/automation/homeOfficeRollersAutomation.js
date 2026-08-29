/**
 * Home Office Rollers Automation.
 * Rule-based blind controller loaded from YAML configuration.
 * Evaluates sensor readings and network presence against configured rules,
 * then merges matching results per target using "most-closed-wins" logic.
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

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'home-office-rollers.yaml')

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export default class HomeOfficeRollersAutomation extends RuleBasedAutomationBase {
    /**
     * Fixed identity constructor -- name and config path are constants of this automation.
     */
    constructor() {
        super({ name: 'HomeOfficeRollersAutomation', configPath: CONFIG_PATH })
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