/**
 * Automations Command -- lists, inspects, and manually triggers loaded automations.
 *
 * Subcommands:
 *   /automations              Show GNU-style usage help with available subcommands
 *   /automations list         List all loaded automations in a tree-like format
 *                             (name, status, type, timer interval, triggers, rules)
 *   /automations debug <n>    Render one automation like list, plus silence window,
 *                             per-rule condition summaries, or config keys
 *   /automations run <n>      Call that automation's execute() now; the log shows
 *                             "Triggered by: manual" under its Auto:<name> context
 *
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
// Constants
// ---------------------------------------------------------------------------

/** Trigger reason passed to execute() for manual runs -- shown as "Triggered by: manual". */
const MANUAL_TRIGGER_REASON = 'manual'

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

class AutomationsCmd extends CommandBase {
    static name = 'automations'
    static description = 'Manage automations: list, inspect, manually trigger'
    static takesArgs = true

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

    /**
     * Format a rule's conditions object into a compact human-readable summary.
     * Numeric range objects become operator expressions (gte -> >=), arrays are
     * joined with "|", and anything else falls back to JSON. Returns an empty
     * string when there are no conditions at all.
     *
     * @param {Object|null|undefined} conditions - Conditions object from a YAML rule
     * @returns {string} Compact summary, e.g. "time-of-day=morning | illuminance>=400"
     */
    static formatConditionSummary(conditions) {
        if (!conditions || typeof conditions !== 'object') return ''

        const parts = []
        for (const [key, value] of Object.entries(conditions)) {
            if (value === null || value === undefined) continue

            if (Array.isArray(value)) {
                parts.push(`${key}=[${value.join('|')}]`)
            } else if (typeof value === 'object') {
                // Numeric-range constraint: lt/lte/gt/gte bounds on the sensor reading
                const ops = { lt: '<', lte: '<=', gt: '>', gte: '>=' }
                const boundParts = []
                let allBounds = true
                for (const [op, num] of Object.entries(value)) {
                    if (!(op in ops) || typeof num !== 'number') {
                        allBounds = false
                        break
                    }
                    boundParts.push(`${key}${ops[op]}${num}`)
                }
                if (allBounds && boundParts.length > 0) {
                    parts.push(...boundParts)
                } else {
                    parts.push(`${key}=${JSON.stringify(value)}`)
                }
            } else {
                parts.push(`${key}=${String(value)}`)
            }
        }
        return parts.join(' | ')
    }

    /**
     * Dispatch to a subcommand based on the raw argument string. Bare invocation
     * renders GNU-style usage help; "list" keeps the original tree listing so the
     * previous behaviour is preserved one word deeper.
     *
     * @param {string} args - Raw argument string after the command verb
     */
    async execute(args) {
        const container = this.ctx.automationContainer
        if (!container || typeof container.getAll !== 'function') {
            this.ctx.print('(AutomationContainer not available)')
            return
        }

        const trimmed = args.trim()
        if (trimmed === '') {
            this.#printUsage(container)
            return
        }

        // First token is the subcommand, everything after it is kept intact as the
        // payload so multi-word automation names keep working.
        const spaceIdx = trimmed.indexOf(' ')
        const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
        const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

        switch (sub) {
            case 'list':
                this.#renderList(container)
                break
            case 'debug':
                this.#handleDebug(container, rest)
                break
            case 'run':
                await this.#handleRun(container, rest)
                break
            default:
                this.ctx.print(`Unknown subcommand "${sub}"`)
                this.#printUsage(container)
        }
    }

    // -- Subcommands ----------------------------------------------------------

    /**
     * Print GNU-style usage help with all subcommands and the registered automations.
     * @param {Object} container - AutomationContainer instance
     */
    #printUsage(container) {
        const lines = [
            'Usage: /automations <subcommand> [args]',
            '',
            '  list             List all loaded automations',
            '  debug <name>     Show detailed info for one automation',
            '  run <name>       Manually trigger an automation now',
            '',
        ]
        const names = this.#availableNames(container)
        if (names.length > 0) {
            lines.push(`Available: ${names.join(', ')}`)
        } else {
            lines.push('(no automations loaded)')
        }
        this.ctx.print(lines.join('\n'))
    }

    /**
     * Render all loaded automations in a tree-like format (the "list" view).
     * Shows name, status (loaded/not), type (ruleBased etc.), triggers,
     * timer interval for timer-based ones, and rule count per automation.
     * @param {Object} container - AutomationContainer instance
     */
    #renderList(container) {
        const map = container.getAll()
        if (map.size === 0) {
            this.ctx.print('(no automations loaded)')
            return
        }

        // Collect automation info into an array so we know which is last
        const entries = []
        for (const [key, instance] of map.entries()) {
            entries.push({ name: key, props: this.#baseProps(instance) })
        }
        this.#renderTree(entries)
    }

    /**
     * Render one automation like the list view but with extra detail: silence
     * window when configured, per-rule condition summaries, or top-level config
     * keys for automations that carry no rules at all.
     * @param {Object} container - AutomationContainer instance
     * @param {string} rawName - Name argument after "debug" (may be empty)
     */
    #handleDebug(container, rawName) {
        const automation = this.#findAutomation(container, rawName)
        if (!automation) {
            this.ctx.print(rawName ? `Unknown automation "${rawName}"` : 'Missing automation name')
            this.#printAvailableNames(container)
            return
        }

        const props = this.#baseProps(automation)

        // Silence window -- insert before the rule rows when configured
        if (typeof automation.config?.silence_between === 'string') {
            const idx = props.findIndex(([label]) => label === 'rules')
            props.splice(idx, 0, ['silence', automation.config.silence_between])
        }

        // Per-rule breakdown with compact condition summaries
        const rules = Array.isArray(automation.config?.rules) ? automation.config.rules : []
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i] ?? {}
            let detail = `"${String(rule.name ?? '(unnamed)')}"`
            const summary = AutomationsCmd.formatConditionSummary(rule.conditions)
            if (summary !== '') detail += ` -- ${summary}`
            if (rule.once) detail += ' [once/day]'
            props.push([`rule ${i + 1}`, detail])
        }

        // Non-rule-based automations: surface top-level config keys instead of rules
        const hasConfigKeys = automation.config && typeof automation.config === 'object'
            && Object.keys(automation.config).length > 0
        if (rules.length === 0 && hasConfigKeys) {
            props.push(['config keys', Object.keys(automation.config).join(', ')])
        }

        this.#renderTree([{ name: automation.name ?? rawName, props }])
    }

    /**
     * Manually trigger an automation's execute() method. The run still goes through
     * the normal guards (silent period, once-per-day markers, human-interaction
     * cooldowns); execution details are logged under the Auto:<name> context.
     * @param {Object} container - AutomationContainer instance
     * @param {string} rawName - Name argument after "run" (may be empty)
     */
    async #handleRun(container, rawName) {
        const automation = this.#findAutomation(container, rawName)
        if (!automation) {
            this.ctx.print(rawName ? `Unknown automation "${rawName}"` : 'Missing automation name')
            this.#printAvailableNames(container)
            return
        }

        const name = automation.name ?? rawName
        this.ctx.print(`Running "${name}" (trigger: ${MANUAL_TRIGGER_REASON})...`)
        try {
            await container.callAutomation(name, { trigger: MANUAL_TRIGGER_REASON })
        } catch (error) {
            this.ctx.print(`Execution failed: ${error.message}`)
            return
        }
        this.ctx.print(`Done -- see log window for "Auto:${name}" details.`)
    }

    // -- Shared helpers -------------------------------------------------------

    /**
     * Build the standard property rows shown for every automation in list and debug views.
     * @param {Object} instance - Automation instance
     * @returns {Array<[string, string]>} Rows of [label, value] pairs
     */
    #baseProps(instance) {
        const triggers = instance.getTriggerTopics?.() ?? []
        const rulesCount = Array.isArray(instance.config?.rules) ? instance.config.rules.length : 0
        return [
            ['status', instance._initialized ? '[OK]' : '[FAIL]'],
            ['type', AutomationsCmd.getType(instance)],
            ['timer', temporal.msToHuman(instance.getTimerIntervalMs?.() ?? 0)],
            ['triggers', triggers.length > 0 ? triggers.join(', ') : '--'],
            ['rules', String(rulesCount)],
        ]
    }

    /**
     * Draw entries as an aligned tree using box-drawing characters (escaped).
     * Each entry is { name, props: [[label, value], ...] }.
     * @param {Array<{name: string, props: Array<[string, string]>}>} entries - Entries to draw
     */
    #renderTree(entries) {
        // Build the tree output line by line
        const lines = []
        const total = entries.length

        for (let i = 0; i < total; i++) {
            const entry = entries[i]
            const isLast = i === total - 1

            // Branch prefix marks whether this is an intermediate or the last entry
            const branchPrefix = isLast ? '\u2514\u2500 ' : '\u251c\u2500 '
            // Continuation column keeps nested property lines aligned under the branch
            const contCol = '\u2502   '

            // Automation name header
            lines.push(`${branchPrefix}${entry.name}`)

            // Properties -- each gets a branch marker based on its position in the list
            const props = entry.props
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

    /**
     * Resolve an automation instance from a user-supplied name. Tries exact match first,
     * then falls back to case-insensitive comparison so mistyped casing still works.
     * @param {Object} container - AutomationContainer instance
     * @param {string} rawName - Name typed by the user (may be empty)
     * @returns {Object|null} Automation instance or null when not found
     */
    #findAutomation(container, rawName) {
        if (!rawName) return null
        const exact = typeof container.getAutomation === 'function' ? container.getAutomation(rawName) : null
        if (exact) return exact
        const lower = rawName.toLowerCase()
        for (const [key, instance] of container.getAll().entries()) {
            if (key.toLowerCase() === lower) return instance
        }
        return null
    }

    /**
     * Collect all registered automation names in sorted order.
     * @param {Object} container - AutomationContainer instance
     * @returns {string[]} Sorted list of automation names
     */
    #availableNames(container) {
        return [...container.getAll().keys()].sort()
    }

    /**
     * Print a one-line listing of all registered automation names (or a note when none).
     * @param {Object} container - AutomationContainer instance
     */
    #printAvailableNames(container) {
        const names = this.#availableNames(container)
        if (names.length === 0) {
            this.ctx.print('(no automations loaded)')
        } else {
            this.ctx.print(`Available: ${names.join(', ')}`)
        }
    }
}

export default AutomationsCmd