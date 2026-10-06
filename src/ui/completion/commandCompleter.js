/**
 * Command Completer -- tab-completion engine for the UI command prompt.
 * Sits between InputComponent.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import terminalKit from 'terminal-kit'
import CommandContainer from '../commands/container/commandContainer.js'

//  CommandCompleter.

/** Stateless tab-completion engine for slash-command lines. Inject a container exposing. */
class CommandCompleter {
    /** @type {Object} Container providing verb lookup and introspection */
    #container

    /** Create a new completer bound to the given command registry.
     * @param {Object} [container=CommandContainer] - Registry with getAllInfo() and getCommand() */
    constructor(container = CommandContainer) {
        this.#container = container ?? null
    }

    //  -- Public API -------------------------------------------------------

    /** Complete the whitespace-delimited token ending at cursorPos in buffer.
     * @param {string} buffer - Full current line content
     * @param {number} cursorPos - Cursor index into buffer (UTF-16 units, as maintained by InputComponent)
     * @returns {{text: string, tokenStart: number, alternatives?: Array<string>}|null} */
    complete(buffer, cursorPos) {
        try {
            const line = String(buffer ?? '')
            const rawCursor = Number(cursorPos)
            const cursor = Math.max(0, Math.min(Number.isFinite(rawCursor) ? rawCursor : line.length, line.length))
            const left = line.slice(0, cursor)

            if (!left.trim()) return null   // nothing typed yet -- there is no word to complete

            //  Walk back over the current token -- whitespace boundaries are always on code point.
            let i = left.length - 1
            while (i >= 0 && !/\s/.test(left[i])) i--
            let tokenStart = i + 1
            let token = left.slice(tokenStart)
            let logicalPrefix = left.slice(0, tokenStart)

            //  A leading slash marks command mode but never takes part in matching -- verbs are.
            if (logicalPrefix.trim() === '' && token.startsWith('/')) {
                token = token.slice(1)
                tokenStart++
                logicalPrefix = ''
            }

            const headTokens = logicalPrefix.split(/\s+/).filter(Boolean)

            let candidates = null
            if (headTokens.length === 0) {
                //  Completing the first logical word: the verb itself. Bare and /-prefixed forms.
                candidates = this.#verbCandidates()
            } else {
                const first = headTokens[0]
                const verb = first.startsWith('/') ? first.slice(1) : first
                const cmd = this.#container?.getCommand?.(verb) ?? null
                if (cmd && typeof cmd.completeNextToken === 'function') {
                    try {
                        candidates = cmd.completeNextToken(headTokens.slice(1))
                    } catch {
                        candidates = null
                    }
                }
            }
            if (!Array.isArray(candidates) || candidates.length === 0) return null

            const matched = this.#match(candidates, token)
            if (!matched) return null
            if (matched.alternatives) {
                return { text: matched.alternatives[0], tokenStart, alternatives: matched.alternatives }
            }
            return { text: matched.text, tokenStart }
        } catch {
            return null
        }
    }

    //  -- Private Helpers --------------------------------------------------

    /** Collect every registered verb and alias as a deduplicated sorted candidate pool.
     * @returns {string[]} Candidate verbs for first-token completion
     * @private */
    #verbCandidates() {
        let info = []
        try {
            info = this.#container?.getAllInfo?.() ?? []
        } catch {
            info = []
        }
        const set = new Set()
        for (const entry of info) {
            if (!entry) continue
            if (typeof entry.name === 'string' && entry.name !== '') set.add(entry.name)
            if (Array.isArray(entry.aliases)) {
                for (const alias of entry.aliases) {
                    if (typeof alias === 'string' && alias !== '') set.add(alias)
                }
            }
        }
        return [...set].sort()
    }

    /** Match the typed token against a candidate pool using terminal-kit's autoComplete() helper.
     * @param {Array<string>} candidates - Candidate strings offered by the command/registry
     * @param {string} token - Partially-typed token being completed
     * @returns {{text: string}|{alternatives: Array<string>}|null} Completion result or null when nothing matches
     * @private */
    #match(candidates, token) {
        const needle = String(token ?? '').toLowerCase()

        //  Case-insensitive prefix pre-filter, deduplicated on the lowercase twin and preserving.
        const seen = new Set()
        const pool = []
        const lowerPool = []
        for (const raw of candidates) {
            if (typeof raw !== 'string' || raw === '') continue
            const low = raw.toLowerCase()
            if (!low.startsWith(needle)) continue
            if (seen.has(low)) continue
            seen.add(low)
            pool.push(raw)
            lowerPool.push(low)
        }
        if (pool.length === 0) return null

        //  terminal-kit does the actual completion math over the normalized twins: unique match.
        let result
        try {
            result = terminalKit.autoComplete(lowerPool, needle, true)
        } catch {
            return null
        }

        if (Array.isArray(result)) {
            const alts = []
            for (const low of result) {
                const orig = pool.find((p) => p.toLowerCase() === low) ?? low
                if (!alts.includes(orig)) alts.push(orig)
            }
            if (alts.length > 1) return { alternatives: alts }
            if (alts[0] && alts[0].toLowerCase() !== needle) return { text: alts[0] }
            return null
        }

        const completed = String(result)
        if (completed === needle) return null   // token already complete -- Tab stays a no-op
        const exact = pool.find((p) => p.toLowerCase() === completed)
        if (exact) return { text: exact }
        //  A partial shared extension: keep exactly the common part.
        const carrier = pool.find((p) => p.toLowerCase().startsWith(completed))
        return { text: carrier ? carrier.slice(0, completed.length) : completed }
    }
}

export default CommandCompleter