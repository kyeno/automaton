/**
 * Automation Command -- lists, inspects, and manually triggers loaded automations.
 *
 * Subcommands:
 *   /automation               Show GNU-style usage help with available subcommands
 *   /automation list         List all loaded automations in a tree-like format
 *                             (name, status, type, timer interval, triggers, rules)
 *   /automation debug <n>    Render one automation like list, plus silence window,
 *                             per-rule condition summaries, or config keys
 *   /automation run <n>      Call that automation's execute() now; the log shows
 *                             "Triggered by: manual" under its Auto:<name> context
 *   /automation force <n>    Same as run but bypasses the silent period and any
 *                             already-consumed once-per-day rule markers without consuming or
 *                             refreshing them; human-interaction cooldowns still apply so a
 *                             manual poke never fights a device someone just touched
 *   /automation force <n> first
 *                             As force, but also forces the first-of-day day-position
 *                             so the dated opening time line renders (debug poke)
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

class AutomationCmd extends CommandBase {
    static name = 'automation'
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
            case 'force':
                await this.#handleForce(container, rest)
                break
            default:
                this.ctx.print(`Unknown subcommand "${sub}"`)
                this.#printUsage(container)
        }
    }

    // -- Subcommands ----------------------------------------------------------

    /**
     * Print GNU-style usage help with all subcommands and the registered automations.
     * @private
     * @param {Object} container - AutomationContainer instance
     */
    #printUsage(container) {
        const lines = [
            'Usage: /automation <subcommand> [args]',
            '',
            '  list             List all loaded automations',
            '  debug <name>     Show detailed info for one automation',
            '  run <name>       Manually trigger an automation now',
            '  force <name>     Trigger now even during its silent period or after a',
            '                   once/day marker fired (human-interaction cooldowns kept)',
            '  force <name> first',
            '                   As force, but also force the first-of-day day-position so',
            '                   the dated opening time line renders (debug poke)',
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
     * @private
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
        this.printTree(entries)
    }

    /**
     * Render one automation like the list view but with extra detail: silence
     * window when configured, per-rule condition summaries, or top-level config
     * keys for automations that carry no rules at all.
     * @private
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
            const summary = AutomationCmd.formatConditionSummary(rule.conditions)
            if (summary !== '') detail += ` -- ${summary}`
            if (rule.once) detail += ' [once/day]'
            if (rule.forced_only === true) detail += ' [invoke-only]'
            props.push([`rule ${i + 1}`, detail])
        }

        // Non-rule-based automations: surface top-level config keys instead of rules
        const hasConfigKeys = automation.config && typeof automation.config === 'object'
            && Object.keys(automation.config).length > 0
        if (rules.length === 0 && hasConfigKeys) {
            props.push(['config keys', Object.keys(automation.config).join(', ')])
        }

        this.printTree([{ name: automation.name ?? rawName, props }])
    }

    /**
     * Manually trigger an automation's execute() method. The run still goes through
     * the normal guards (silent period, once-per-day markers, human-interaction
     * cooldowns); execution details are logged under the Auto:<name> context.
     * @private
     * @param {Object} container - AutomationContainer instance
     * @param {string} rawName - Name argument after "run" or "force" (may be empty)
     * @param {boolean} [force=false] - When true, dispatch carries force:true so automations
     *   bypass their silent-period and once-per-day guards; human-interaction cooldowns apply either way
     * @param {boolean} [forceFirst=false] - When true, dispatch carries forceFirst:true so
     *   automations force the first-of-day day-position (dated opening time line)
     */
    async #handleRun(container, rawName, force = false, forceFirst = false) {
        const automation = this.#findAutomation(container, rawName)
        if (!automation) {
            this.ctx.print(rawName ? `Unknown automation "${rawName}"` : 'Missing automation name')
            this.#printAvailableNames(container)
            return
        }

        const name = automation.name ?? rawName
        const suffix = force ? ', forced' : ''
        this.ctx.print(`Running "${name}" (trigger: ${MANUAL_TRIGGER_REASON}${suffix})...`)
        try {
            const data = { trigger: MANUAL_TRIGGER_REASON }
            if (force) data.force = true
            if (forceFirst) data.forceFirst = true
            await container.callAutomation(name, data)
        } catch (error) {
            this.ctx.print(`Execution failed: ${error.message}`)
            return
        }
        this.ctx.print(`Done -- see log window for "Auto:${name}" details.`)
    }

    /**
     * Force-run an automation: identical to run except the dispatch carries force:true,
     * which lets automations skip both checking and writing of their silent-period suppression
     * and per-rule once-per-day markers (a forced/delegated run consumes no daily budget).
     * Human-interaction cooldowns are intentionally NOT bypassed so a manual poke never
     * fights a device someone just physically touched. An optional trailing "first"
     * token (e.g. "force <name> first") additionally carries forceFirst:true so the
     * automation forces its first-of-day day-position -- a debug poke for the dated
     * opening time line.
     * @private
     * @param {Object} container - AutomationContainer instance
     * @param {string} rawName - Name argument after "force" (may be empty; a trailing
     *   "first" token is parsed as the forceFirst modifier, not part of the name)
     */
    async #handleForce(container, rawName) {
        const { name, forceFirst } = this.#parseForceArgs(rawName)
        await this.#handleRun(container, name, true, forceFirst)
    }

    /**
     * Split a force subcommand payload into the automation name and the optional
     * trailing "first" modifier. The name may be multi-word; only a final token that
     * is exactly "first" (case-insensitive) is treated as the modifier, so names that
     * merely contain the word elsewhere are preserved intact.
     * @private
     * @param {string} rawName - Raw payload after "force" (may be empty)
     * @returns {{name: string, forceFirst: boolean}}
     */
    #parseForceArgs(rawName) {
        const tokens = rawName.trim().split(/\s+/).filter(Boolean)
        if (tokens.length > 0 && tokens[tokens.length - 1].toLowerCase() === 'first') {
            return { name: tokens.slice(0, -1).join(' '), forceFirst: true }
        }
        return { name: rawName.trim(), forceFirst: false }
    }

    // -- Tab completion -----------------------------------------------------

    /**
     * Tab-completion candidates for /automation arguments. The first token offers the known
     * subcommands; once "run", "debug" or "force" has been typed, registered automation names are offered
     * so "/automation run TtsWea<Tab>" completes without consulting the list view first. For
     * "force", once a name token is present the next token offers the optional "first" modifier.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null when none apply
     */
    completeNextToken(typedTokens) {
        if (!typedTokens || typedTokens.length === 0) return ['list', 'debug', 'run', 'force']
        const sub = String(typedTokens[0]).toLowerCase()
        if (sub !== 'run' && sub !== 'debug' && sub !== 'force') return null
        // "force <name> <Tab>" -> the name is already typed, so offer the optional "first" modifier.
        if (sub === 'force' && typedTokens.length >= 2) return ['first']
        const container = this.ctx.automationContainer
        if (container && typeof container.getNames === 'function') return container.getNames()
        return null
    }

    // -- Shared helpers -------------------------------------------------------

    /**
     * Build the standard property rows shown for every automation in list and debug views.
     * @private
     * @param {Object} instance - Automation instance
     * @returns {Array<[string, string]>} Rows of [label, value] pairs
     */
    #baseProps(instance) {
        const triggers = instance.getTriggerTopics?.() ?? []
        const rulesCount = Array.isArray(instance.config?.rules) ? instance.config.rules.length : 0
        return [
            ['status', instance._initialized ? '[OK]' : '[FAIL]'],
            ['type', AutomationCmd.getType(instance)],
            ['timer', temporal.msToHuman(instance.getTimerIntervalMs?.() ?? 0)],
            ['triggers', triggers.length > 0 ? triggers.join(', ') : '--'],
            ['rules', String(rulesCount)],
        ]
    }

    /**
     * Resolve an automation instance from a user-supplied name. Tries exact match first,
     * then falls back to case-insensitive comparison so mistyped casing still works.
     * @private
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
     * @private
     * @param {Object} container - AutomationContainer instance
     * @returns {string[]} Sorted list of automation names
     */
    #availableNames(container) {
        return [...container.getAll().keys()].sort()
    }

    /**
     * Print a one-line listing of all registered automation names (or a note when none).
     * @private
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

export default AutomationCmd