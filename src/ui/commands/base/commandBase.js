/**
 * Base UI Command Class.
 *
 * Abstract base class for all slash commands registered with the UI command
 * container. Subclasses must override `static name`, `static description`,
 * and `async execute(args)`.
 *
 * Commands receive a context object (`this.ctx`) at construction time that
 * provides access to services, the active window, and helper methods.
 *
 * Directory layout:
 *   src/ui/commands/base/         -- this file (abstract base)
 *   src/ui/commands/container/    -- CommandContainer (autoloader + dispatcher)
 *   src/ui/commands/*.Cmd.js      -- concrete commands (auto-discovered)
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

// ---------------------------------------------------------------------------
// CommandBase
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all UI slash commands.
 *
 * Each subclass represents one slash command (e.g., /clear, /status, /debug-state).
 * The static `name` property is used as the command verb registered in the container.
 * Subclasses must override `execute()` with their logic.
 */
class CommandBase {
    /**
     * Command verb name without leading slash. Used for registration and dispatching.
     * Subclasses MUST override this.
     * @type {string}
     */
    static name = null

    /**
     * One-line description shown in /help output.
     * Subclasses SHOULD override this.
     * @type {string}
     */
    static description = ''

    /**
     * Whether this command accepts a free-form argument after its verb.
     * When true, /help annotates the entry with [arg].
     * Defaults to false -- set to true if your execute() method parses args.
     * @type {boolean}
     */
    static takesArgs = false

    /**
     * Alternative verbs that route to this same command instance.
     * E.g., ['exit', 'q'] on QuitCmd means /quit, /exit, and /q all work.
     * Each alias is registered alongside the primary name so exact-match
     * dispatch finds it instantly. No prefix-matching is done on aliases.
     * @type {Array<string>}
     */
    static aliases = []

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new command instance.
     * Injects context object providing access to services and helpers.
     *
     * @param {Object} ctx - Context object from Ui containing:
     *   - print(...args): Print text to active window
     *   - activeWindow: BaseWindow | null getter for current active window
     *   - switchWindow(idOrShortcut): Switch to a named window by id or shortcut number
     *   - stateService: StateService singleton
     *   - logger: LoggerService singleton
     *   - shutdown(): Function to exit the application
     *   - commandContainer: CommandContainer reference (for introspection)
     */
    constructor(ctx) {
        if (this.constructor === CommandBase) {
            throw new Error('CommandBase is abstract and cannot be instantiated directly')
        }
        this.ctx = ctx ?? {}
    }

    // -- Shared rendering helpers ------------------------------------------

    /**
     * Render entries as an aligned tree using box-drawing characters via ctx.print().
     * Shared by listing commands (/automations list|debug, /config debug ...) so every
     * command renders its trees identically. Each entry is
     * { name, props: [[label, value], ...] }.
     * @param {Array<{name: string, props?: Array<[string, string]>}>} entries - Entries to draw
     */
    printTree(entries) {
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

            // Entry name header
            lines.push(`${branchPrefix}${entry.name}`)

            // Properties -- each gets a branch marker based on its position in the list
            const props = entry.props ?? []
            for (let j = 0; j < props.length; j++) {
                const [label, value] = props[j]
                const propBranch = j === props.length - 1 ? '\u2514\u2500' : '\u251c\u2500'
                lines.push(`${contCol}${propBranch} ${label}: ${value}`)
            }

            // Blank separator between entries (not after the last one)
            if (!isLast) lines.push('')
        }

        this.ctx.print(lines.join('\n'))
    }

    // -- Public API -------------------------------------------------------

    /**
     * Optional tab-completion provider for arguments following this command's verb.
     * Receives the fully-typed tokens AFTER the verb, excluding the partial token currently
     * being completed (e.g., [] when completing "/config <TAB>", ['run'] when completing
     * "/automations run TtsWea<TAB>") and returns an array of candidate strings for the next
     * token, or null when nothing can be offered at that position. Candidate lists are matched
     * with terminal-kit's autoComplete() helper by the UI completer, so plain string arrays are
     * all that is required here; data should come from the ctx containers' getNames()-style
     * helpers rather than re-scanning registries. The default offers nothing -- override only
     * in commands whose grammar accepts known values.
     *
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null for no completion
     */
    completeNextToken(typedTokens) {
        void typedTokens
        return null
    }

    /**
     * Execute the command with parsed arguments.
     * Override in subclass with actual command logic.
     *
     * @param {string} args - Raw argument string after the command verb
     * @returns {Promise<void>}
     */
    async execute(args) {
        const name = this.constructor.name || 'Unknown'
        throw new Error(`execute() not implemented by ${name}`)
    }
}

export default CommandBase
