/**
 * Config Command -- inspects loaded configuration files and applies live overrides.
 *
 * Subcommands:
 *   /config                     Show GNU-style usage help with available subcommands
 *   /config debug               Dump the main config file in full -- metadata header plus
 *                               every live parameter rendered as a box-drawing tree
 *   /config set <path> <value...>
 *                               Apply a runtime override to the main config, validated
 *                               exactly like startup loading; problems are reported
 *                               instead of crashing
 *   /config reload              Re-read config files from disk and safely refresh affected
 *                               subsystems (i18n, TTS, AI conversation, window buffers);
 *                               failed validation leaves everything untouched
 *
 * Values follow the same rules as -c/--config-override at CLI startup: they are parsed
 * as YAML so numbers, booleans and quoted strings keep their natural types. Changes
 * apply to the running process only -- the YAML file on disk stays untouched.
 *
 * The tree dump is printed through the UI's whitespace-preserving preformatted path
 * (plain print() fallback) so indentation survives the window's line wrapping.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'
import I18nLoader from '../../service/i18nLoader.js'
import TtsService from '../../service/ttsService.js'
import AiAssistant from '../../ai/aiAssistant.js'
import channels from '../channels.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max serialized length for collapsing a leaf record onto a single line -- keeps
 * one-line renderings inside a typical terminal width; longer records expand.
 */
const INLINE_LIMIT = 100

// ---------------------------------------------------------------------------
// ConfigCmd
// ---------------------------------------------------------------------------

class ConfigCmd extends CommandBase {
    static name = 'config'
    static description = 'Inspect the main config; apply live, validated overrides'
    static takesArgs = true

    /**
     * Dispatch to a subcommand based on the raw argument string. Bare invocation
     * renders GNU-style usage help; "debug" dumps the main config in full; "set"
     * applies one validated override to it without ever crashing the app.
     *
     * @param {string} args - Raw argument string after the command verb
     */
    async execute(args) {
        const service = this.ctx.configService
        if (!service || typeof service.listSections !== 'function') {
            this.ctx.print('(ConfigService not available)')
            return
        }

        const trimmed = String(args ?? '').trim()
        if (trimmed === '') {
            this.#printUsage(service)
            return
        }

        // First token is the subcommand, everything after it stays intact so values
        // with spaces keep working (same convention as /automation).
        const spaceIdx = trimmed.indexOf(' ')
        const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
        const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

        switch (sub) {
            case 'debug':
                if (rest !== '') {
                    this.ctx.print('Usage: /config debug   -- no arguments needed; dumps the main config in full')
                } else {
                    this.#handleDebug(service)
                }
                break
            case 'set':
                await this.#handleSet(service, rest)
                break
            case 'reload':
                await this.#handleReload(service)
                break
            default:
                this.ctx.print(`Unknown subcommand "${sub}"`)
                this.#printUsage(service)
        }
    }

    /**
     * Tab-completion candidates for /config arguments. The first token offers the known
     * subcommands; once "set" has been typed, loaded section names are offered as path prefixes
     * so "/config set mai<Tab>" starts a valid "<section>.<param>" address.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null when none apply
     */
    completeNextToken(typedTokens) {
        if (!typedTokens || typedTokens.length === 0) return ['debug', 'set', 'reload']
        const sub = String(typedTokens[0]).toLowerCase()
        if (sub !== 'set') return null

        const service = this.ctx.configService
        if (!service || typeof service.listSections !== 'function') return null
        try {
            const sections = service.listSections().map((s) => s?.name).filter(Boolean)
            return sections.length > 0 ? sections : null
        } catch {
            return null
        }
    }

    // -- Subcommands ----------------------------------------------------------

    /**
     * Print GNU-style usage help with all subcommands. Both "debug" and "set" operate on
     * the main config file only -- its resolved path is shown so there is never any
     * ambiguity about which document is being inspected or overridden.
     * @private
     * @param {Object} service - ConfigService instance
     */
    #printUsage(service) {
        const sections = service.listSections()
        const main = sections.find((s) => s.name === 'main') ?? null

        const lines = [
            'Usage: /config <subcommand> [args]',
            '',
            '  debug                 Dump the main config in full (live values)',
            '  set <path> <value...> Override one main-config parameter for this session',
            '  reload                Re-read config files from disk and refresh affected subsystems',
            '',
            '<path>: dotted parameter inside the main config, e.g., ai.max_tokens',
            '<value>: parsed as YAML like -c/--config-override -- quote multi-word strings',
            '',
        ]
        if (main) {
            lines.push(`Main config: ${main.filePath}`)
        } else {
            lines.push('(no config sections loaded)')
        }
        if (sections.length > 0) {
            lines.push(`Loaded: ${sections.map(s => s.name).join(', ')}`)
        }
        this.ctx.print(lines.join('\n'))
    }

    /**
     * "debug" subcommand -- dumps the main config file in full: metadata header
     * (resolved path, validator status, top-level key count) followed by every live
     * value rendered as a box-drawing tree. /config deliberately operates on the
     * main config only; other files stay reachable through their own services.
     * @private
     * @param {Object} service - ConfigService instance
     */
    #handleDebug(service) {
        const base = service.section('main')
        if (!base) {
            this.ctx.print('(main config not loaded)')
            return
        }

        // Metadata header in the shared tree style (/automation debug looks like this too)
        this.printTree([{
            name: 'main',
            props: [
                ['file', base.filePath],
                ['validator', base.hasValidator ? 'yes' : 'none'],
                ['top-level keys', String(Object.keys(base.toJSON()).length)],
            ],
        }])

        // Full live contents as a box-drawing tree (same glyphs as the header above)
        this.ctx.print('')
        this.printPreformatted(ConfigCmd.dumpConfig(base.toJSON()).join('\n'))
    }

    /**
     * "set" subcommand -- parse "<path> <value...>", dry-run the override through the same
     * validation startup uses against the MAIN config section, then commit it when clean.
     * Problems are printed one per line with an explicit NOT-applied note; the app never
     * crashes here. Paths address the main config only (e.g., ai.max_tokens).
     * @private
     * @param {Object} service - ConfigService instance
     * @param {string} rest - Argument string after "set" (may be empty)
     */
    async #handleSet(service, rest) {
        const base = service.section('main')
        if (!base) {
            this.ctx.print('(main config not loaded)')
            return
        }

        // Split into exactly two logical parts while keeping value spaces intact
        const firstSpace = rest.indexOf(' ')
        if (firstSpace === -1) {
            if (rest.trim() !== '') this.ctx.print(`Missing value for "${rest.trim()}"`)
            this.#printSetHint()
            return
        }
        const pathToken = rest.slice(0, firstSpace).trim()
        const rawValue = rest.slice(firstSpace + 1).trim()

        if (rawValue === '') {
            this.ctx.print(`Missing value for "${pathToken}"`)
            this.#printSetHint()
            return
        }

        // Same parser as the CLI -c/--config-override flag: YAML-typed values, identical errors
        /** @type {{ path: string, value: unknown }} */
        let entry
        try {
            entry = service.parseConfigOverride(`${pathToken}: ${rawValue}`)
        } catch (error) {
            this.ctx.print(error.message)
            return
        }

        // Dry-run through startup validation WITHOUT mutating anything
        const result = await base.validateOverride(entry)
        if (result.problems.length > 0) {
            for (const problem of result.problems) this.ctx.print(problem)
            if (result.validTopLevel && result.validTopLevel.length > 0) {
                this.ctx.print(`Valid top-level parameters: ${result.validTopLevel.join(', ')}`)
            }
            this.ctx.print('Change NOT applied -- fix the value above and retry.')
            return
        }

        // Clean -- commit via the very same mutation path startup uses
        const oldValue = base.get(entry.path)
        await base.applyOverrides([entry])
        service.noteSessionOverride('main', entry.path)
        this.ctx.print(
            `Applied [main] ${entry.path}: ${this.#fmt(oldValue)} -> ${JSON.stringify(entry.value)}`
        )
        this.ctx.print('(runtime only -- the YAML file on disk is unchanged, restarts reload it)')
    }

    /**
     * "reload" subcommand -- re-read every config file from disk through ConfigService.reload()
     * (two-phase safe swap), then refresh ONLY the initialized subsystems actually affected by
     * the change. Relevance is detected at two levels: automaton.yaml subtrees via report.changed
     * (ai.*, locale.*, ui.windows) AND content movement inside each service's own cache-vs-disk
     * comparison -- the per-locale bundles under etc/i18n/{dir}/ (tts.yaml + ai.yaml) belong to no
     * config section, so only their owners can tell whether an edit landed since last load.
     * Stale rendered output in existing windows is cleared whenever any relevant setting moved,
     * and the channel-definition cache resets when ui.windows did. A failed validation reports its
     * problems verbatim and leaves the running configuration completely untouched.
     * @private
     * @param {Object} service - ConfigService instance
     */
    async #handleReload(service) {
        const report = await service.reload()

        if (!report.ok) {
            this.ctx.print('Config reload FAILED -- live configuration unchanged:')
            for (const issue of report.failed) this.ctx.print(`  [${issue.section}] ${issue.error}`)
            return
        }

        // ---- Refresh dependent subsystems (initialized AND actually affected) ----
        const changed = new Set(report.changed)
        /** @type {string[]} */
        const refreshed = []

        const localeChanged   = changed.has('locale')
        let i18nBundleMoved   = false
        let ttsTemplateMoved  = false

        // Probe first: both services are idempotent and cheap; each one's own cache-vs-disk
        // comparison is what detects edits under an UNCHANGED language (files outside sections).
        if (I18nLoader.isReady) {
            const r = await I18nLoader.reload()
            i18nBundleMoved = Boolean(r.bundleChanged)
            if (r.changed || r.bundleChanged) {
                refreshed.push(r.changed
                    ? `i18n switched to locale=${r.locale} time_format=${r.timeFormat}`
                    : 'i18n bundle reloaded from disk')
            } else if (localeChanged) {
                refreshed.push('i18n re-checked (no effective change)')
            }
        } else if (localeChanged) {
            refreshed.push('i18n skipped (not initialized yet)')
        }

        // TTS template follows the active locale directory -- runs after i18n so getLocale()
        // reflects any switch before its tts.yaml path resolves.
        if (TtsService.isReady()) {
            const t = await TtsService.refreshConfig()
            ttsTemplateMoved = Boolean(t.changed)
            if (t.changed || localeChanged) {
                refreshed.push(`TTS now ${t.enabled ? `enabled, model=${t.model}` : 'disabled'}`)
            }
        } else if (localeChanged) {
            refreshed.push('TTS skipped (not initialized / disabled by env)')
        }

        if ((changed.has('ai') || localeChanged || i18nBundleMoved) && AiAssistant.isReady()) {
            const r = await AiAssistant.resetConversation()
            if (r.reset) refreshed.push(`AI conversation cleared (${r.dropped} message(s))`)
        }

        // ---- Housekeeping for the UI ------------------------------------------
        /** @type {string[]} */
        let clearedWindows = []
        if ((changed.size > 0 || localeChanged || i18nBundleMoved || ttsTemplateMoved) && typeof this.ctx.clearWindows === 'function') {
            try { clearedWindows = this.ctx.clearWindows(['ai', 'tts']) ?? [] } catch {}
        }

        // Window definitions changed -- force the channel cache to re-read them on next access.
        // Adding/removing windows still needs a restart: Ui builds window instances eagerly.
        if (changed.has('ui.windows') && channels.isLoaded) channels.reset()

        // ---- Report -------------------------------------------------------------
        this.ctx.print(`Config reloaded -- sections: ${report.reloaded.join(', ') || '(none)'}`)
        if (report.added.length > 0) this.ctx.print(`  + added sections: ${report.added.join(', ')}`)
        for (const d of report.dropped) this.ctx.print(`  - dropped section: ${d.name}${d.error ? ` (${d.error})` : ''}`)
        if (report.discardedOverrides.length > 0) {
            this.ctx.print(`  runtime overrides discarded (file is source of truth): ${report.discardedOverrides.join(', ')}`)
        }
        if (refreshed.length > 0) {
            for (const line of refreshed) this.ctx.print(`  ${line}`)
        } else if (report.changed.length === 0 && !localeChanged) {
            this.ctx.print('  no i18n/TTS/AI-relevant settings changed')
        }
        if (clearedWindows.length > 0) this.ctx.print(`  windows cleared: ${clearedWindows.join(', ')}`)
    }

    // -- Shared helpers -------------------------------------------------------

    /**
     * Short usage reminder for malformed "set" invocations.
     * @private
     */
    #printSetHint() {
        this.ctx.print('Usage: /config set <parameter.path> <value...>')
        this.ctx.print('Tip: paths address the main config; values parse as YAML -- quote multi-word strings ("some text")')
    }

    /**
     * Format an old value for confirmation lines; undefined renders as "(unset)".
     * @private
     * @param {*} value - Previous parameter value (any JSON type or undefined)
     * @returns {string} Quoted rendering safe to embed in a status line
     */
    #fmt(value) {
        return value === undefined ? '(unset)' : JSON.stringify(value)
    }

    // -- Data rendering -------------------------------------------------------

    /**
     * Render a full config document as a box-drawing tree (read-only view) using the
     * same glyphs as printTree(). Scalars use JSON quoting so strings and numbers stay
     * unambiguous; empty containers collapse to {} / []; arrays of scalars stay on one
     * line; arrays of containers expand under [i] element nodes; records whose values
     * are all scalars collapse to one JSON line while longer ones expand into branches.
     * @param {Record<string, unknown>} data - Parsed config tree
     * @returns {string[]} Lines of rendered text
     */
    static dumpConfig(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return [JSON.stringify(data)]
        return ConfigCmd.#renderEntries(Object.entries(data), '')
    }

    /**
     * Core recursive renderer for [name, value] pairs under a shared prefix column.
     * Each pair becomes one branch: a leaf line (scalar, empty container, scalar array,
     * or a small record collapsed to JSON) or a node line whose children recurse with
     * the branch's continuation column, so nesting depth is always visually explicit.
     * @private
     * @param {Array<[string, unknown]>} entries - Name/value pairs to render
     * @param {string} prefix - Continuation column carried from all ancestor branches
     * @returns {string[]} Rendered lines
     */
    static #renderEntries(entries, prefix) {
        /** @type {string[]} */
        const lines = []
        entries.forEach(([name, value], i) => {
            const last = i === entries.length - 1
            const branch = `${prefix}${last ? '\u2514\u2500 ' : '\u251c\u2500 '}`
            const cont = `${prefix}${last ? '    ' : '\u2502   '}`

            if (value === null || typeof value !== 'object') {
                lines.push(`${branch}${name}: ${JSON.stringify(value)}`)
            } else if (Array.isArray(value)) {
                if (value.length === 0) {
                    lines.push(`${branch}${name}: []`)
                } else if (value.every((v) => ConfigCmd.#isScalar(v))) {
                    lines.push(`${branch}${name}: ${JSON.stringify(value)}`)
                } else {
                    // Synthetic element names ([i]) already identify the item; only named keys
                    // get the [n] count suffix (windows[4]), so nested arrays read [0] not [0][1]
                    lines.push(`${branch}${name.startsWith('[') ? name : `${name}[${value.length}]`}`)
                    lines.push(...ConfigCmd.#renderEntries(value.map((item, j) => [`[${j}]`, item]), cont))
                }
            } else if (ConfigCmd.#isLeafRecord(value) && JSON.stringify(value).length <= INLINE_LIMIT) {
                lines.push(`${branch}${name}: ${JSON.stringify(value)}`)
            } else {
                lines.push(`${branch}${name}`)
                lines.push(...ConfigCmd.#renderEntries(Object.entries(value), cont))
            }
        })
        return lines
    }

    /**
     * Whether a value is a scalar (null or primitive) rather than a container.
     * @private
     * @param {*} value - Value to classify
     * @returns {boolean} True for null, string, number, boolean, symbol, bigint
     */
    static #isScalar(value) {
        return value === null || typeof value !== 'object'
    }

    /**
     * Whether an object is a "leaf record": every value is a scalar or an array of
     * scalars, so the whole record can be shown on one line without losing structure.
     * @private
     * @param {*} value - Value to classify
     * @returns {boolean} True for plain records with no nested containers
     */
    static #isLeafRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            && Object.values(value).every((v) => ConfigCmd.#isScalar(v) || (Array.isArray(v) && v.every((x) => ConfigCmd.#isScalar(x))))
    }
}

export default ConfigCmd