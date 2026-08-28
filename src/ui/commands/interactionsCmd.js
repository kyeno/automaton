/**
 * Interactions Command -- lists, inspects, and manually triggers loaded interactions.
 *
 * Subcommands:
 *   /interactions             Show GNU-style usage help with available subcommands
 *   /interactions list        List all loaded interactions in a tree-like format
 *                             (name, type yaml/custom, action count)
 *   /interactions debug <n>   Render one interaction like list, plus per-action detail
 *                             (action type, device targets, chained calls) or config keys
 *   /interactions run <n> [actionType]
 *                             Call that interaction's execute() now; when two or more words
 *                             are given and only the leading part is a registered name, the
 *                             trailing word selects which YAML-defined action fires
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

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

class InteractionsCmd extends CommandBase {
    static name = 'interactions'
    static description = 'Manage interactions: list, inspect, manually trigger'
    static takesArgs = true

    /**
     * Determine interaction kind by walking the prototype chain.
     * Checks whether the instance is backed by a JS class extending InteractionBase
     * or was created inline as a YAML-defined object. Used for the "list" view and as
     * a fallback when the container does not expose getSourceInfo().
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

    /**
     * Normalize raw "actions" entries into stable descriptors for rendering. Tolerates
     * missing fields and non-object entries without throwing so odd YAML shapes never
     * break the debug view.
     * @param {Array|undefined|null} raw - Raw action array from an interaction config
     * @returns {Array<{type: string, targets: Array<{device: string, command: string}>, calls: string|null}>} Descriptors
     */
    static normalizeActions(raw) {
        const out = []
        if (!Array.isArray(raw)) return out
        for (const a of raw) {
            if (!a || typeof a !== 'object') continue
            out.push({
                type: a.type != null ? String(a.type) : '(untyped)',
                targets: Array.isArray(a.targets)
                    ? a.targets.filter((t) => t && typeof t === 'object').map((t) => ({
                        device: String(t.device ?? '?'),
                        command: t.command != null ? String(t.command).toUpperCase() : '',
                    }))
                    : [],
                calls: a.calls != null ? String(a.calls) : null,
            })
        }
        return out
    }

    /**
     * Dispatch to a subcommand based on the raw argument string. Bare invocation
     * renders GNU-style usage help; "list" keeps the original tree listing one word
     * deeper so previous behaviour is preserved.
     *
     * @param {string} args - Raw argument string after the command verb
     */
    async execute(args) {
        const container = this.ctx.interactionContainer
        if (!container || typeof container.getAll !== 'function') {
            this.ctx.print('(InteractionContainer not available)')
            return
        }

        const trimmed = String(args ?? '').trim()
        if (trimmed === '') {
            this.#printUsage(container)
            return
        }

        // First token is the subcommand; everything after it stays intact as the payload
        // so multi-word interaction names keep working (same convention as /automations).
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

    /**
     * Tab-completion candidates for /interactions arguments. The first token offers the known
     * subcommands; once "run" or "debug" has been typed, registered interaction names are offered
     * so "/interactions run bedroom<Tab>" completes without consulting the list view first.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null when none apply
     */
    completeNextToken(typedTokens) {
        if (!typedTokens || typedTokens.length === 0) return ['list', 'debug', 'run']
        const sub = String(typedTokens[0]).toLowerCase()
        if (sub !== 'run' && sub !== 'debug') return null
        const container = this.ctx.interactionContainer
        if (container && typeof container.getNames === 'function') return container.getNames()
        return null
    }

    // -- Subcommands ----------------------------------------------------------

    /**
     * Print GNU-style usage help with all subcommands and the registered interactions.
     * @param {Object} container - InteractionContainer instance
     */
    #printUsage(container) {
        const lines = [
            'Usage: /interactions <subcommand> [args]',
            '',
            '  list                    List all loaded interactions',
            '  debug <name>            Show detailed info for one interaction',
            '  run <name> [actionType] Manually trigger an interaction now; optional trailing word selects a YAML action type',
            '',
        ]
        const names = this.#availableNames(container)
        if (names.length > 0) {
            lines.push(`Available: ${names.join(', ')}`)
        } else {
            lines.push('(no interactions loaded)')
        }
        this.ctx.print(lines.join('\n'))
    }

    /**
     * Render all loaded interactions in a tree-like format (the "list" view).
     * Shows name, kind (yaml/custom), and action count per interaction.
     * @param {Object} container - InteractionContainer instance
     */
    #renderList(container) {
        const map = container.getAll()
        if (map.size === 0) {
            this.ctx.print('(no interactions loaded)')
            return
        }

        // Collect interaction info into entries so the shared tree renderer can draw it
        const entries = []
        for (const [key, value] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const instance = value?.instance ?? value
            const config = instance?.config ?? null
            const actionsCount = Array.isArray(config?.actions) ? config.actions.length : 0
            entries.push({
                name: key,
                props: [
                    ['type', InteractionsCmd.getType(instance)],
                    ['actions', String(actionsCount)],
                ],
            })
        }
        this.printTree(entries)
    }

    /**
     * Render one interaction like the list view but with extra detail: every configured
     * action as its own row (action type, device targets, chained calls), or top-level
     * config keys when the interaction carries no actions at all.
     * @param {Object} container - InteractionContainer instance
     * @param {string} rawName - Name argument after "debug" (may be empty)
     */
    #handleDebug(container, rawName) {
        const found = this.#findInstance(container, String(rawName ?? '').trim())
        if (!found) {
            this.ctx.print(rawName ? `Unknown interaction "${rawName}"` : 'Missing interaction name')
            this.#printAvailableNames(container)
            return
        }

        // Container-provided metadata is authoritative for kind/config; fall back to the
        // instance itself so minimal containers (and tests) still render fully.
        let kind = InteractionsCmd.getType(found.instance)
        let config = found.instance?.config ?? null
        if (typeof container.getSourceInfo === 'function') {
            const info = container.getSourceInfo(found.key)
            if (info) {
                kind = info.kind || kind
                config = info.config ?? config
            }
        }
        const cfg = (config && typeof config === 'object') ? config : null
        const actions = InteractionsCmd.normalizeActions(cfg?.actions)

        const props = [
            ['type', kind],
            ['actions', String(actions.length)],
        ]
        for (let i = 0; i < actions.length; i++) {
            const a = actions[i]
            let detail = `type=${a.type}`
            if (a.targets.length > 0) {
                const targetTexts = a.targets.map((t) => (t.command !== '' ? `${t.device}:${t.command}` : t.device))
                detail += ` targets=${targetTexts.join(', ')}`
            }
            if (a.calls !== null) detail += ` calls=${a.calls}`
            props.push([`action ${i + 1}`, detail])
        }

        // No actions: surface top-level config keys instead so the view is never empty
        if (actions.length === 0 && cfg && Object.keys(cfg).length > 0) {
            props.push(['config keys', Object.keys(cfg).join(', ')])
        }

        this.printTree([{ name: found.key, props }])
    }

    /**
     * Manually trigger an interaction's execute(). Name resolution tries the whole
     * argument first (so multi-word names work); only when that misses does it treat
     * the trailing word as the YAML action type to select. Dispatch goes through the
     * container's callInteraction() with the canonical registered key.
     * @param {Object} container - InteractionContainer instance
     * @param {string} rawName - Argument string after "run" (may be empty)
     */
    async #handleRun(container, rawName) {
        const trimmed = String(rawName ?? '').trim()
        if (!trimmed) {
            this.ctx.print('Missing interaction name')
            this.#printAvailableNames(container)
            return
        }

        let resolved = this.#findInstance(container, trimmed)
        let actionType = null
        if (!resolved) {
            // "<name> <actionType>" split -- only meaningful when the leading part resolves
            const spaceIdx = trimmed.lastIndexOf(' ')
            if (spaceIdx > 0) {
                const candidate = trimmed.slice(0, spaceIdx).trim()
                const partial = this.#findInstance(container, candidate)
                if (partial) {
                    resolved = partial
                    actionType = trimmed.slice(spaceIdx + 1).trim() || null
                }
            }
        }

        if (!resolved) {
            this.ctx.print(`Unknown interaction "${trimmed}"`)
            this.#printAvailableNames(container)
            return
        }

        const data = actionType !== null ? { action: actionType } : {}
        this.ctx.print(actionType !== null
            ? `Running "${resolved.key}" (action: ${actionType})...`
            : `Running "${resolved.key}"...`)
        try {
            await container.callInteraction(resolved.key, data)
        } catch (error) {
            this.ctx.print(`Execution failed: ${error.message}`)
            return
        }
        this.ctx.print('Done -- see log window for details.')
    }

    // -- Shared helpers -------------------------------------------------------

    /**
     * Resolve a registered interaction by user-supplied name. Tries exact match first,
     * then falls back to case-insensitive comparison so mistyped casing still works.
     * Returns the canonical registered key plus its instance (container entries may wrap
     * instances as {instance} or hold them directly -- both shapes are unwrapped).
     * @param {Object} container - InteractionContainer instance
     * @param {string} rawName - Name typed by the user (may be empty)
     * @returns {{key: string, instance: Object}|null} Resolved entry or null when not found
     */
    #findInstance(container, rawName) {
        if (!rawName) return null
        const all = container.getAll()
        const direct = all.get(rawName)
        if (direct !== undefined) return { key: rawName, instance: direct?.instance ?? direct }

        const lower = rawName.toLowerCase()
        for (const [key, value] of [...all.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (key.toLowerCase() === lower) return { key, instance: value?.instance ?? value }
        }
        return null
    }

    /**
     * Collect all registered interaction names in sorted order.
     * @param {Object} container - InteractionContainer instance
     * @returns {string[]} Sorted list of interaction names
     */
    #availableNames(container) {
        return [...container.getAll().keys()].sort()
    }

    /**
     * Print a one-line listing of all registered interaction names (or a note when none).
     * @param {Object} container - InteractionContainer instance
     */
    #printAvailableNames(container) {
        const names = this.#availableNames(container)
        if (names.length === 0) {
            this.ctx.print('(no interactions loaded)')
        } else {
            this.ctx.print(`Available: ${names.join(', ')}`)
        }
    }
}

export default InteractionsCmd