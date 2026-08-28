/**
 * Config Command -- inspects loaded configuration files and applies live overrides.
 *
 * Subcommands:
 *   /config                     Show GNU-style usage help with available subcommands
 *   /config debug               Dump the main config file in full -- metadata header plus
 *                               every live parameter rendered as indented text
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
import I18nLoader from '../../service/i18nLoader.js'
import TtsService from '../../service/ttsService.js'
import AiAssistant from '../../ai/aiAssistant.js'
import channels from '../channels.js'

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
        // with spaces keep working (same convention as /automations).
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
     * value rendered as indented YAML-ish text. /config deliberately operates on the
     * main config only; other files stay reachable through their own services.
     * @param {Object} service - ConfigService instance
     */
    #handleDebug(service) {
        const base = service.section('main')
        if (!base) {
            this.ctx.print('(main config not loaded)')
            return
        }

        // Metadata header in the shared tree style (/automations debug looks like this too)
        this.printTree([{
            name: 'main',
            props: [
                ['file', base.filePath],
                ['validator', base.hasValidator ? 'yes' : 'none'],
                ['top-level keys', String(Object.keys(base.toJSON()).length)],
            ],
        }])

        // Full live contents as indented YAML-ish text
        this.ctx.print('')
        this.ctx.print(ConfigCmd.dumpConfig(base.toJSON()).join('\n'))
    }

    /**
     * "set" subcommand -- parse "<path> <value...>", dry-run the override through the same
     * validation startup uses against the MAIN config section, then commit it when clean.
     * Problems are printed one per line with an explicit NOT-applied note; the app never
     * crashes here. Paths address the main config only (e.g., ai.max_tokens).
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
     * the change: i18n bundle + TTS template when locale.* moved, AI conversation/provider when
     * ai.* or locale.* moved. Stale rendered output in existing windows is cleared whenever any
     * relevant setting changed, and the channel-definition cache resets when ui.windows did.
     * A failed validation reports its problems verbatim and leaves the running configuration
     * completely untouched.
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

        if (changed.has('locale')) {
            if (I18nLoader.isReady) {
                const r = await I18nLoader.reload()
                refreshed.push(r.changed
                    ? `i18n switched to locale=${r.locale} time_format=${r.timeFormat}`
                    : 'i18n re-checked (no effective change)')
            } else {
                refreshed.push('i18n skipped (not initialized yet)')
            }

            if (TtsService.isReady()) {
                const r = await TtsService.refreshConfig()
                refreshed.push(`TTS now ${r.enabled ? `enabled, model=${r.model}` : 'disabled'}`)
            } else {
                refreshed.push('TTS skipped (not initialized / disabled by env)')
            }
        }

        if ((changed.has('ai') || changed.has('locale')) && AiAssistant.isReady()) {
            const r = await AiAssistant.resetConversation()
            if (r.reset) refreshed.push(`AI conversation cleared (${r.dropped} message(s))`)
        }

        // ---- Housekeeping for the UI ------------------------------------------
        /** @type {string[]} */
        let clearedWindows = []
        if (changed.size > 0 && typeof this.ctx.clearWindows === 'function') {
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
        if (report.changed.length === 0) {
            this.ctx.print('  no i18n/TTS/AI-relevant settings changed')
        } else {
            for (const line of refreshed) this.ctx.print(`  ${line}`)
        }
        if (clearedWindows.length > 0) this.ctx.print(`  windows cleared: ${clearedWindows.join(', ')}`)
    }

    // -- Shared helpers -------------------------------------------------------

    /** Short usage reminder for malformed "set" invocations. */
    #printSetHint() {
        this.ctx.print('Usage: /config set <parameter.path> <value...>')
        this.ctx.print('Tip: paths address the main config; values parse as YAML -- quote multi-word strings ("some text")')
    }

    /** Format an old value for confirmation lines; undefined renders as "(unset)". */
    #fmt(value) {
        return value === undefined ? '(unset)' : JSON.stringify(value)
    }

    // -- Data rendering -------------------------------------------------------

    /**
     * Render a full config document as indented YAML-ish text (read-only view). Scalars
     * use JSON quoting so strings and numbers stay unambiguous; empty containers collapse
     * to {} / []; arrays of objects hang their first key off the "- " marker.
     * @param {Record<string, unknown>} data - Parsed config tree
     * @returns {string[]} Lines of rendered text
     */
    static dumpConfig(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return [JSON.stringify(data)]
        return ConfigCmd.#renderPairs(Object.entries(data), 0, false)
    }

    /**
     * Core renderer for [key, value] pairs at a given depth. When dashFirst is true the
     * very first emitted line carries a "- " prefix -- used for array elements that are
     * objects, mirroring how YAML lays them out.
     * @private
     * @param {Array<[string, unknown]>} pairs - Key/value pairs to render
     * @param {number} depth - Current indentation level
     * @param {boolean} dashFirst - Whether the first line starts with "- "
     * @returns {string[]} Rendered lines
     */
    static #renderPairs(pairs, depth, dashFirst) {
        const pad = '  '.repeat(depth)
        const childPad = '  '.repeat(depth + 1)
        /** @type {string[]} */
        const lines = []
        let first = true

        for (const [key, value] of pairs) {
            const prefix = first && dashFirst ? '- ' : ''
            // Blank separator between top-level blocks keeps long dumps scannable
            if (depth === 0 && !first) lines.push('')
            first = false

            if (value === null || typeof value !== 'object') {
                lines.push(`${pad}${prefix}${key}: ${JSON.stringify(value)}`)
            } else if (Array.isArray(value)) {
                if (value.length === 0) {
                    lines.push(`${pad}${prefix}${key}: []`)
                } else {
                    lines.push(`${pad}${prefix}${key}:`)
                    for (const item of value) {
                        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
                            lines.push(...ConfigCmd.#renderPairs(Object.entries(item), depth + 1, true))
                        } else {
                            lines.push(`${childPad}- ${JSON.stringify(item)}`)
                        }
                    }
                }
            } else {
                const entries = Object.entries(value)
                if (entries.length === 0) {
                    lines.push(`${pad}${prefix}${key}: {}`)
                } else {
                    lines.push(`${pad}${prefix}${key}:`)
                    lines.push(...ConfigCmd.#renderPairs(entries, depth + 1, false))
                }
            }
        }

        return lines
    }
}

export default ConfigCmd