/**
 * Base UI Command Class.
 * Abstract base class for all slash commands registered with the UI command.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

//  CommandBase.

/** Abstract base class for all UI slash commands. */
class CommandBase {
    /** Command verb name without leading slash. Used for registration and dispatching.
     * @type {string} */
    static name = null

    /** One-line description shown in /help output.
     * @type {string} */
    static description = ''

    /** Whether this command accepts a free-form argument after its verb.
     * @type {boolean} */
    static takesArgs = false

    /** Alternative verbs that route to this same command instance.
     * @type {Array<string>} */
    static aliases = []

    //  -- Initialization ---------------------------------------------------

    /** Create a new command instance.
     * @param {Object} ctx - Context object from Ui containing: */
    constructor(ctx) {
        if (this.constructor === CommandBase) {
            throw new Error('CommandBase is abstract and cannot be instantiated directly')
        }
        this.ctx = ctx ?? {}
    }

    //  -- Shared rendering helpers ------------------------------------------

    /** Render entries as an aligned tree using box-drawing characters.
     * @param {Array<{name: string, props?: Array<[string, string]>}>} entries - Entries to draw */
    printTree(entries) {
        //  Build the tree output line by line.
        const lines = []
        const total = entries.length

        for (let i = 0; i < total; i++) {
            const entry = entries[i]
            const isLast = i === total - 1

            //  Branch prefix marks whether this is an intermediate or the last entry.
            const branchPrefix = isLast ? '\u2514\u2500 ' : '\u251c\u2500 '
            //  Continuation column keeps nested property lines aligned under the branch.
            const contCol = '\u2502   '

            //  Entry name header.
            lines.push(`${branchPrefix}${entry.name}`)

            //  Properties -- each gets a branch marker based on its position in the list.
            const props = entry.props ?? []
            for (let j = 0; j < props.length; j++) {
                const [label, value] = props[j]
                const propBranch = j === props.length - 1 ? '\u2514\u2500' : '\u251c\u2500'
                lines.push(`${contCol}${propBranch} ${label}: ${value}`)
            }

            //  Blank separator between entries (not after the last one)
            if (!isLast) lines.push('')
        }

        this.printPreformatted(lines.join('\n'))
    }

    /** Print whitespace-significant output (box-drawing trees, aligned tables) through
     * @param {string} text */
    printPreformatted(text) {
        if (typeof this.ctx.printPreformatted === 'function') {
            this.ctx.printPreformatted(text)
        } else {
            this.ctx.print(text)
        }
    }

    //  -- Public API -------------------------------------------------------

    /** Optional tab-completion provider for arguments following this command's verb.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null for no completion */
    completeNextToken(typedTokens) {
        void typedTokens
        return null
    }

    /** Execute the command with parsed arguments.
     * @param {string} args - Raw argument string after the command verb
     * @returns {Promise<void>} */
    async execute(args) {
        const name = this.constructor.name || 'Unknown'
        throw new Error(`execute() not implemented by ${name}`)
    }
}

export default CommandBase
