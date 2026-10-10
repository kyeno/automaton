/**
 * Sequence Command -- lists sequences with live status and drives runs/loops.
 * Subcommands: list | run <name> [ON|OFF] | loop start <name> | loop stop <name>.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'


class SequenceCmd extends CommandBase {
    static name = 'sequence'
    static description = 'Run device sequences & control their loops'
    static takesArgs = true

    /** Dispatch to a subcommand based on the raw argument string. Bare invocation lists all
     * sequences with their live status; unknown verbs print usage lines.
     * @param {string} args - Raw argument string after the command verb */
    async execute(args) {
        const trimmed = String(args ?? '').trim()
        if (trimmed === '') {
            this.#handleList()
            return
        }

        //  First token is the subcommand; everything after it stays intact as the payload.
        const spaceIdx = trimmed.indexOf(' ')
        const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
        const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

        switch (sub) {
            case 'list':
                this.#handleList()
                break
            case 'run':
                await this.#handleRun(rest)
                break
            case 'loop':
                await this.#handleLoop(rest)
                break
            default:
                this.ctx.print(`Unknown subcommand "${sub}"`)
                this.#printUsageLines()
        }
    }

    /** Tab-completion candidates for /sequence arguments. The first token offers the subcommands;
     * `run` and both `loop` operations offer registered sequence names.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null when none apply */
    completeNextToken(typedTokens) {
        if (!typedTokens || typedTokens.length === 0) return ['list', 'run', 'loop']
        const sub = String(typedTokens[0]).toLowerCase()
        if (sub === 'run') return this.#names()
        if (sub === 'loop') {
            if (typedTokens.length < 2) return ['start', 'stop']
            const op = String(typedTokens[1]).toLowerCase()
            if (op === 'start' || op === 'stop') return this.#names()
        }
        return null
    }

    //  -- Subcommand handlers ---------------------------------------------------

    /** List all sequences with live status (active/phase/loop).
     * @private */
    #handleList() {
        const sc = this.ctx.sequenceContainer
        if (!sc || typeof sc.getAll !== 'function') {
            this.ctx.print('(sequence service unavailable)')
            return
        }
        const all = sc.getAll() ?? []
        if (all.length === 0) {
            this.ctx.print('(no sequences configured)')
            return
        }
        for (const seq of all) {
            const s = seq.getStateSummary?.() ?? {}
            const state = s.active ? `running (${s.phase})` : 'idle'
            const loop = s.loopActive ? ' [LOOP]' : ''
            this.ctx.print(`${seq.getName()} [${seq.getSlug()}] -- ${state}${loop}`)
        }
    }

    /** Single run: `/sequence run <name> [ON|OFF]`. The name may be a slug or friendly name;
     * an optional trailing ON/OFF token selects the action (default ON). Multi-word names work.
     * @param {string} rest - Tokens after "run"
     * @private */
    async #handleRun(rest) {
        if (!rest) {
            this.ctx.print('Usage: /sequence run <name> [ON|OFF]')
            this.#printAvailableNames()
            return
        }
        //  A trailing ON/OFF word is the action; everything before it is the (possibly multi-word) name.
        let action = 'ON'
        let namePart = rest
        const tokens = rest.split(/\s+/)
        if (tokens.length > 1 && ['on', 'off'].includes(tokens[tokens.length - 1].toLowerCase())) {
            action = tokens.pop().toUpperCase()
            namePart = tokens.join(' ')
        }
        await this.#dispatch(namePart, action)
    }

    /** Loop control: `/sequence loop start <name>` | `/sequence loop stop <name>`.
     * @param {string} rest - Tokens after "loop"
     * @private */
    async #handleLoop(rest) {
        const tokens = String(rest ?? '').trim().split(/\s+/).filter(Boolean)
        const op = (tokens[0] ?? '').toLowerCase()
        const namePart = tokens.slice(1).join(' ').trim()
        if (op !== 'start' && op !== 'stop') {
            this.ctx.print('Usage: /sequence loop start|stop <name>')
            this.#printAvailableNames()
            return
        }
        if (!namePart) {
            this.ctx.print(`Missing sequence name for "loop ${op}"`)
            this.#printAvailableNames()
            return
        }
        const sc = this.ctx.sequenceContainer
        if (!sc || typeof sc.resolveSequence !== 'function') {
            this.ctx.print('(sequence service unavailable)')
            return
        }
        const seq = sc.resolveSequence(namePart)
        if (!seq) {
            this.ctx.print(`Unknown sequence "${namePart}"`)
            this.#printAvailableNames()
            return
        }
        if (op === 'start') {
            const started = await sc.startLoop(seq.getSlug())
            this.ctx.print(started ? `Loop started: ${seq.getName()}` : `Loop not started: ${seq.getName()} (busy or no loop configured)` )
        } else {
            const stopped = sc.stopLoop(seq.getSlug())
            this.ctx.print(stopped ? `Loop stop requested: ${seq.getName()}` : `Nothing to stop: ${seq.getName()} is not looping`)
        }
    }

    /** Resolve a name and send one command down the sequence, reporting the outcome.
     * @param {string} rawName - Slug or friendly name as typed by the user
     * @param {'ON'|'OFF'} action - Action to send
     * @private */
    async #dispatch(rawName, action) {
        const sc = this.ctx.sequenceContainer
        if (!sc || typeof sc.callCommand !== 'function') {
            this.ctx.print('(sequence service unavailable)')
            return
        }
        const seq = sc.resolveSequence(rawName)
        if (!seq) {
            this.ctx.print(`Unknown sequence "${rawName}"`)
            this.#printAvailableNames()
            return
        }
        const ok = await sc.callCommand(seq.getSlug(), action)
        this.ctx.print(ok ? `${action} sent to ${seq.getName()}` : `${action} rejected for ${seq.getName()} (already running)`)
    }

    //  -- Helpers ---------------------------------------------------------------

    /** Registered sequence names for display/completion, sorted; null when none exist.
     * @returns {Array<string>|null}
     * @private */
    #names() {
        const sc = this.ctx.sequenceContainer
        if (!sc || typeof sc.getNames !== 'function') return null
        try {
            const names = sc.getNames() ?? []
            return names.length > 0 ? [...names].sort() : null
        } catch {
            return null
        }
    }

    /** Print the union of known sequence names (or a note when none exist).
     * @private */
    #printAvailableNames() {
        const names = this.#names()
        if (!names) {
            this.ctx.print('(no sequences registered)')
        } else {
            this.ctx.print(`Available: ${names.join(', ')}`)
        }
    }

    /** Usage lines shown after an unknown subcommand or missing argument.
     * @private */
    #printUsageLines() {
        this.ctx.print('Usage:')
        this.ctx.print('  /sequence                     list all sequences with live status')
        this.ctx.print('  /sequence run <name> [ON|OFF] single run (default ON); name may be slug or friendly name')
        this.ctx.print('  /sequence loop start <name>   start the loop')
        this.ctx.print('  /sequence loop stop <name>    graceful stop')
    }
}

export default SequenceCmd