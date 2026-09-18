/**
 * Automation Command -- lists, inspects, and manually triggers loaded automations.
 *
 * Subcommands:
 *   /automation               Show GNU-style usage help with available subcommands
 *   /automation list         List all loaded automations in a tree-like format
 *                             (name, status, type, timer interval, triggers, rules)
 *   /automation debug <n>    Render one automation like list, plus silence window,
 *                             per-rule condition summaries, or config keys
 *   /automation coverage <n> Static timing-gap analysis: sweeps every hour x sensor/presence
 *                             scenario of that automation's rules and reports which rules can
 *                             fire at each hour, unmatched gap cells, overlaps and winners
 *   /automation coverage <n> legacy
 *                             Also diffs against the pre-c1e8c6f sun-derived day periods so
 *                             you can see how each shifted hour's behavior changed
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
import * as ruleCoverage from '../../lib/ruleCoverage.js'

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
            case 'coverage':
                this.#handleCoverage(container, rest)
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
            '  coverage <name>  Static timing-gap analysis: which rules can fire at each hour,',
            '                   plus unmatched gap cells and overlaps across sensor/presence scenarios',
            '  coverage <name> legacy',
            '                   As coverage, but also diff against the pre-c1e8c6f sun-derived day periods',
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

    /**
     * Parse a coverage payload into { name, legacy } -- a trailing "legacy" token is treated as
     * the diff modifier rather than part of the automation name, mirroring the force/first pattern.
     * @private
     * @param {string} rawName - Raw argument string after the "coverage" verb.
     * @returns {{name: string, legacy: boolean}} Resolved automation name and whether legacy diffing was requested.
     */
    #parseCoverageArgs(rawName) {
        const tokens = rawName.trim().split(/\s+/).filter(Boolean)
        if (tokens.length > 0 && tokens[tokens.length - 1].toLowerCase() === 'legacy') {
            return { name: tokens.slice(0, -1).join(' '), legacy: true }
        }
        return { name: rawName.trim(), legacy: false }
    }

    /**
     * Dispatch the static timing-gap analysis for one automation and print the report through the
     * preformatted path so aligned columns survive terminal wrapping. Purely read-only: no rule is
     * executed and no device state is touched; live-state conditions are noted in the header.
     * @private
     * @param {Object|null} container - AutomationContainer from context (may be null when absent).
     * @param {string} rawName - Raw argument string after the "coverage" verb.
     */
    #handleCoverage(container, rawName) {
        const { name, legacy } = this.#parseCoverageArgs(rawName)
        const automation = this.#findAutomation(container, name)
        if (!automation) {
            this.ctx.print(name ? `Unknown automation "${name}"` : 'Missing automation name')
            this.#printAvailableNames(container)
            return
        }
        const rules = Array.isArray(automation.config?.rules) ? automation.config.rules : []
        if (rules.length === 0) {
            this.ctx.print(`"${automation.name ?? name}" defines no rules to analyze`)
            return
        }

        const built = ruleCoverage.buildScenarios(rules)
        const currentMap = ruleCoverage.currentHourToPeriod()
        const report = ruleCoverage.analyzeRules({ rules, periodMap: currentMap, scenarios: built.scenarios })

        const lines = [...this.#renderCoverageReport(automation, rules, built, report)]
        if (legacy) {
            lines.push('', ...this.#renderLegacyDiff(rules, built, report, currentMap))
        }
        this.printPreformatted(lines.join('\n'))
    }

    // -- Tab completion -----------------------------------------------------

    /**
     * Tab-completion candidates for /automation arguments. The first token offers the known
     * subcommands; once "run", "debug", "coverage" or "force" has been typed, registered automation
     * names are offered so "/automation run TtsWea<Tab>" completes without consulting the list view
     * first. For "force"/"coverage", once a name token is present the next token offers the optional
     * trailing modifier ("first" / "legacy").
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null when none apply
     */
    completeNextToken(typedTokens) {
        if (!typedTokens || typedTokens.length === 0) return ['list', 'debug', 'coverage', 'run', 'force']
        const sub = String(typedTokens[0]).toLowerCase()
        if (sub !== 'run' && sub !== 'debug' && sub !== 'coverage' && sub !== 'force') return null
        // "<verb> <name> <Tab>" -> the name is already typed; only verbs with a trailing modifier offer one.
        if (typedTokens.length >= 2) {
            if (sub === 'force') return ['first']
            if (sub === 'coverage') return ['legacy']
            return null
        }
        const container = this.ctx.automationContainer
        if (container && typeof container.getNames === 'function') return container.getNames()
        return null
    }

    /**
     * Map a rule's display name to its "R#" reference in the printed index list so timeline and
     * diff rows stay compact while remaining unambiguous.
     * @private
     * @param {Array<object>} rules - Rules under analysis (index order).
     * @returns {Map<string, string>} Rule name to R-reference label.
     */
    #ruleRefs(rules) {
        const map = new Map()
        rules.forEach((r, i) => {
            const n = String(r?.name ?? `(unnamed ${i + 1})`)
            if (!map.has(n)) map.set(n, `R${i + 1}`)
        })
        return map
    }

    /**
     * Render flags worth surfacing next to a rule name: once-per-day budget, invoke-only mode, priority.
     * @private
     * @param {object} rule - A single YAML rule object.
     * @returns {string} Space-joined flag labels or empty string when none apply.
     */
    #ruleFlags(rule) {
        const parts = []
        if (rule?.once === true) parts.push('[once/day]')
        if (rule?.forced_only === true) parts.push('[invoke-only]')
        if (typeof rule?.priority === 'number' && rule.priority !== 0) parts.push(`[p=${rule.priority}]`)
        return parts.join(' ')
    }

    /**
     * Build the main coverage report lines: header with sweep dimensions, the R-indexed rule list,
     * an hour timeline grouped by identical match/gap profile, then gap cells and overlap examples.
     * @private
     * @param {Object} automation - Resolved automation instance (for its display name).
     * @param {Array<object>} rules - Rules under analysis.
     * @param {{meta: Object}} built - buildScenarios() result providing grid metadata.
     * @param {Object} report - analyzeRules() result for the current period map.
     * @returns {string[]} Report lines ready to join and print.
     */
    #renderCoverageReport(automation, rules, built, report) {
        const L = []
        const sensorDesc = built.meta.sensorKeys.length > 0
            ? built.meta.sensorKeys.map((k) => `${k}(${built.meta.pointsBySensor[k].length})`).join(', ')
            : 'none'
        const presenceDesc = built.meta.presenceHosts.length > 0 ? ` · presence hosts: ${built.meta.presenceHosts.join(', ')}` : ''
        L.push(`Coverage analysis: ${automation.name ?? '(unnamed)'}`)
        L.push(`${report.meta.ruleCount} rules · sensors: ${sensorDesc}${presenceDesc} · ${report.meta.scenarioCount} scenario(s)/hour${built.meta.truncated ? ' [grid truncated]' : ''}`)
        L.push(report.meta.note)

        // Rule index list with behavioral flags so timeline references stay short but unambiguous.
        const refs = this.#ruleRefs(rules)
        L.push('rules:')
        rules.forEach((r, i) => {
            const n = String(r?.name ?? `(unnamed ${i + 1})`)
            const flags = this.#ruleFlags(r)
            L.push(`  R${i + 1} "${n}"${flags ? ' ' + flags : ''}`)
        })

        // Timeline -- group consecutive hours sharing the same match/gap profile for compactness.
        L.push('timeline (union of rules able to fire at each hour; G k/N = gap in k scenarios):')
        const groups = []
        for (const h of report.hours) {
            const key = JSON.stringify([h.matchedRules, h.gapCount])
            const last = groups[groups.length - 1]
            if (last && last.key === key && last.endHour === h.hour - 1) {
                last.endHour = h.hour
            } else {
                groups.push({ startHour: h.hour, endHour: h.hour, key, sample: h })
            }
        }
        for (const g of groups) {
            const pad2 = (v) => String(v).padStart(2, '0')
            const range = g.startHour === g.endHour ? pad2(g.startHour) : `${pad2(g.startHour)}-${pad2(g.endHour)}`
            const periods = [...new Set(report.hours.slice(g.startHour, g.endHour + 1).map((h) => h.period))].join('/')
            const ruleList = g.sample.matchedRules.map((n) => refs.get(n)).filter(Boolean).join(',') || '-'
            const gapNote = g.sample.gapCount > 0 ? `   G ${g.sample.gapCount}/${g.sample.totalScenarios}` : ''
            L.push(`  ${range}  ${periods.padEnd(16)}${ruleList}${gapNote}`)
        }

        // Gap cells -- the actionable part: hour/scenario combinations no rule can serve.
        if (report.summary.gapCells > 0) {
            L.push(`GAPS -- ${report.summary.gapCells} of ${report.summary.totalCells} cells unmatched:`)
            for (const g of report.gaps.slice(0, 12)) {
                L.push(`  h=${String(g.hour).padStart(2, '0')} (${g.period}) ${g.label}`)
            }
            if (report.gaps.length > 12) L.push(`  ... and ${report.gaps.length - 12} more`)
        } else {
            L.push('GAPS -- none: every hour/scenario combination matches at least one rule')
        }

        // Overlaps -- where several rules compete; note who wins by priority so intent is explicit.
        if (report.overlaps.count > 0) {
            L.push(`OVERLAPS -- ${report.overlaps.count} cells with multiple matching rules (winner by priority):`)
            for (const ex of report.overlaps.examples.slice(0, 4)) {
                const others = ex.names.filter((n) => n !== ex.winnerName).length
                L.push(`  h=${String(ex.hour).padStart(2, '0')} (${ex.period}) ${ex.label} -> "${ex.winnerName}" wins over ${others} other(s)`)
            }
            if (report.overlaps.examples.length > 4) L.push(`  ... and ${report.overlaps.count - 4} more overlapping cell(s)`)
        }

        L.push(`coverage: ${report.summary.coveragePct}% of cells covered`)
        return L
    }

    /**
     * Render the legacy-diff section: for January (winter worst case) and June (summer), list each
     * shifted hour whose set of matchable rules changed versus today's fixed partition, naming what
     * was lost and gained. This surfaces exactly how c1e8c6f moved behavior on existing rules.
     * @private
     * @param {Array<object>} rules - Rules under analysis.
     * @param {{scenarios: Array<Object>}} built - Shared scenario grid so both maps are swept identically.
     * @param {Object} currentReport - analyzeRules() result for the current period map.
     * @param {Array<string>} currentMap - Current hour-to-period mapping.
     * @returns {string[]} Diff lines ready to join and print.
     */
    #renderLegacyDiff(rules, built, currentReport, currentMap) {
        const L = ['-- Legacy diff vs pre-c1e8c6f sun-derived periods --']
        const refs = this.#ruleRefs(rules)
        const nowSet = ruleCoverage.matchedNamesByHour(currentReport)
        const fmtList = (names) => names.length === 0 ? '-' : names.slice(0, 3).map((n) => `${refs.get(n) ?? n}`).join(',') + (names.length > 3 ? ` (+${names.length - 3})` : '')

        for (const [label, month] of [['January (winter worst case)', 0], ['June (summer)', 5]]) {
            const legacyMap = ruleCoverage.buildLegacyHourMap(month)
            const legacyRep = ruleCoverage.analyzeRules({ rules, periodMap: legacyMap, scenarios: built.scenarios })
            const thenSet = ruleCoverage.matchedNamesByHour(legacyRep)
            const rows = []
            for (let h = 0; h < 24; h++) {
                if (currentMap[h] === legacyMap[h]) continue
                const lost = [...thenSet.get(h)].filter((n) => !nowSet.get(h)?.has(n))
                const gained = [...nowSet.get(h)].filter((n) => !thenSet.get(h)?.has(n))
                if (lost.length === 0 && gained.length === 0) continue
                rows.push(`  h=${String(h).padStart(2, '0')} ${legacyMap[h]} -> ${currentMap[h]}   lost: ${fmtList(lost)}   gained: ${fmtList(gained)}`)
            }
            L.push(`${label}:`)
            L.push(rows.length > 0 ? rows.join('\n') : '  no rule-set differences on shifted hours')
        }
        return L
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