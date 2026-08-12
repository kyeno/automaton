/**
 * Automations Command -- lists all loaded automations in a tree-like format.
 *
 * Shows name, status (loaded/not), type (ruleBased etc.), triggers,
 * timer interval for timer-based ones, and rule count per automation.
 * Uses plain text via ctx.print() so it plays nicely with buffer-based UI windows.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'
import temporal from '../../lib/date.js'

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

class AutomationsCmd extends CommandBase {
    static name = 'automations'
    static description = 'List all loaded automations in a tree'
    static takesArgs = false

    /**
     * Determine automation type by walking the prototype chain.
     * Checks each ancestor class name for known base-class patterns.
     *
     * @param {Object} instance - Automation instance
     * @returns {string} Type label like "ruleBased" or "base"
     */
    static getType(instance) {
        let proto = Object.getPrototypeOf(instance)
        while (proto && proto !== Object.prototype) {
            const ctorName = proto.constructor?.name ?? ''
            if (/rulebased/i.test(ctorName)) return 'ruleBased'
            proto = Object.getPrototypeOf(proto)
        }
        return 'base'
    }

    async execute(args) {
        const container = this.ctx.automationContainer
        if (!container || typeof container.getAll !== 'function') {
            this.ctx.print('(AutomationContainer not available)')
            return
        }

        const map = container.getAll()
        if (map.size === 0) {
            this.ctx.print('(no automations loaded)')
            return
        }

        // Collect automation info into an array so we know which is last
        const entries = []
        for (const [key, instance] of map.entries()) {
            entries.push({
                name: key,
                status: instance._initialized ? '[OK]' : '[FAIL]',
                type: AutomationsCmd.getType(instance),
                triggers: instance.getTriggerTopics?.() ?? [],
                timerMs: instance.getTimerIntervalMs?.() ?? 0,
                rulesCount: Array.isArray(instance.config?.rules)
                    ? instance.config.rules.length
                    : 0,
            })
        }

        // Build the tree output line by line
        const lines = []
        const total = entries.length

        for (let i = 0; i < total; i++) {
            const entry = entries[i]
            const isLast = i === total - 1

            // Branch prefix: ├─ for intermediate entries, └─ for the last one
            const branchPrefix = isLast ? '\u2514\u2500 ' : '\u251c\u2500 '
            // Continuation column: always │ for visual consistency
            const contCol = '\u2502   '

            // Automation name header
            lines.push(`${branchPrefix}${entry.name}`)

            // Properties -- each uses ├─ or └─ depending on whether it's the last property
            const props = [
                [`status`, entry.status],
                [`type`, entry.type],
                [`timer`, temporal.msToHuman(entry.timerMs)],
                [`triggers`, entry.triggers.length > 0 ? entry.triggers.join(', ') : '--'],
                [`rules`, String(entry.rulesCount)],
            ]

            for (let j = 0; j < props.length; j++) {
                const [label, value] = props[j]
                const propIsLast = j === props.length - 1
                const propBranch = propIsLast ? '\u2514\u2500' : '\u251c\u2500'
                lines.push(`${contCol}${propBranch} ${label}: ${value}`)
            }

            // Blank separator between automations (not after the last one)
            if (!isLast) lines.push('')
        }

        this.ctx.print(lines.join('\n'))
    }
}

export default AutomationsCmd