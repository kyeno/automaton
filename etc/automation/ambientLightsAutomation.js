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

    async init() {
        await super.init()
    }

    /**
     * Resolve command using first matching rule's per-target action field,
     * falling back to the rule's flat `action` when no target-specific
     * command exists. Maps ON/OFF actions to state payloads for mechanisms.
     * 
     * @param {DeviceBase} device - Target device
     * @param {string} targetId - Identifier of the target (from config.targets[].id)
     * @param {{}[]} matchingRules - Rules whose conditions matched
     * @returns {{payload: object}|null} Object with payload, or null if no command found
     */
    resolveCommand(device, targetId, matchingRules) {
        // Prefer a per-target command from the first matching rule that defines one
        let command = null
        for (const rule of matchingRules) {
            const cmd = rule.targets?.[targetId]
            if (cmd !== undefined) {
                command = cmd
                break
            }
        }

        // Fall back to a flat "action" field shared by all listed devices
        if (command === null || command === undefined) {
            for (const rule of matchingRules) {
                if (rule.action !== undefined) {
                    command = rule.action
                    break
                }
            }
        }

        if (command === null || command === undefined) return null

        const payload = String(command).toUpperCase() === 'OFF' ? { state: 'OFF' } : { state: 'ON' }
        return { payload }
    }
}