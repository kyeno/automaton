/**
 * Interactions Command -- lists all loaded interactions in a tree-like format.
 *
 * Shows name, type (custom/yaml), and action count per interaction.
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

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

class InteractionsCmd extends CommandBase {
    static name = 'interactions'
    static description = 'List all loaded interactions in a tree'
    static takesArgs = false

    /**
     * Determine interaction type by walking the prototype chain.
     * Checks whether the instance is backed by a JS class extending InteractionBase
     * or was created inline as a YAML-defined object.
     *
     * @param {Object} instance - Interaction instance
     * @returns {string} Type label like "custom" or "yaml"
     */
    static getType(instance) {
        let proto = Object.getPrototypeOf(instance)
        while (proto && proto !== Object.prototype) {
            const ctorName = proto.constructor?.name ?? ''
            if (/interaction/i.test(ctorName)) return 'custom'
            proto = Object.getPrototypeOf(proto)
        }
        // Inline objects from #createYamlInteraction have no named constructor in chain
        return 'yaml'
    }

    async execute(args) {
        const container = this.ctx.interactionContainer
        if (!container || typeof container.getAll !== 'function') {
            this.ctx.print('(InteractionContainer not available)')
            return
        }

        const map = container.getAll()
        if (map.size === 0) {
            this.ctx.print('(no interactions loaded)')
            return
        }

        // Collect interaction info into an array so we know which is last
        const entries = []
        for (const [key, entry] of map.entries()) {
            // Container stores { instance, config? } or the instance directly
            const instance = entry.instance ?? entry
            const actionsCount = Array.isArray(instance.config?.actions)
                ? instance.config.actions.length
                : 0

            entries.push({
                name: key,
                type: InteractionsCmd.getType(instance),
                actionsCount,
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

            // Interaction name header
            lines.push(`${branchPrefix}${entry.name}`)

            // Properties -- each uses ├─ or └─ depending on whether it's the last property
            const props = [
                [`type`, entry.type],
                [`actions`, String(entry.actionsCount)],
            ]

            for (let j = 0; j < props.length; j++) {
                const [label, value] = props[j]
                const propIsLast = j === props.length - 1
                const propBranch = propIsLast ? '\u2514\u2500' : '\u251c\u2500'
                lines.push(`${contCol}${propBranch} ${label}: ${value}`)
            }

            // Blank separator between interactions (not after the last one)
            if (!isLast) lines.push('')
        }

        this.ctx.print(lines.join('\n'))
    }
}

export default InteractionsCmd