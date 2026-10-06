/**
 * Input Component -- persistent bottom-row command prompt.
 * Uses terminal-kit's 'key' event (enabled by grabInput()) to accumulate.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import StateService from '../../service/stateService.js'

//  InputComponent.

/** Persistent bottom-row command prompt widget. */
class InputComponent {
    #term
    #layout
    #callbacks = new Set()
    #consumedKeys = new Set()
    #history = []
    #historyIndex = -1
    #currentBuffer = ''
    #cursorPos = 0
    #viewStart = 0
    #channelName = ''   // e.g. "!log", "#automaton"
    #active = false
    #completionProvider = null   // tab-completion fn or null when Tab stays a no-op
    #pendingCompletion = null    // in-progress ambiguous cycle {alternatives, index, tokenStart}

    //  -- Initialization ---------------------------------------------------

    /** Create a new InputComponent instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance */
    constructor(term, layout) {
        this.#term = term
        this.#layout = layout
    }

    /** Activate the input component, register key handlers, and render the initial prompt. */
    init() {
        if (!this.#term || !this.#layout) return
        this.#term.on('key', this.#onKey.bind(this))
        this.#active = true

        StateService.set('ui.refreshInputCursor', () => this.#renderPrompt())

        this.#renderPrompt()
    }

    //  -- Public API -------------------------------------------------------

    /** Update the channel name shown in the prompt (e.g., "[!log]", "[#automaton]").
     * @param {string} name - IRC-style channel name */
    setChannel(name) {
        this.#channelName = name || ''
        this.#renderPrompt()
    }

    /** Mark specific keys as consumed so InputComponent will ignore them.
     * @param {string[]} keyNames - Array of key name strings to mark as consumed */
    markConsumed(keyNames) {
        for (const k of keyNames) this.#consumedKeys.add(k)
    }

    /** Clear all consumed key markers. */
    clearConsumed() {
        this.#consumedKeys.clear()
    }

    /** Register a callback that fires on every submitted command.
     * @param {function(string): void} cb - Callback receiving the command string
     * @returns {function(): void} Unsubscribe function to remove the callback */
    onCommand(cb) {
        this.#callbacks.add(cb)
        return () => this.#callbacks.delete(cb)
    }

    /** Install the tab-completion provider consulted on every Tab press. The provider receives
     * @param {?function(string, number): ({text: string, tokenStart: number, alternatives?: Array<string>}|null)} fn */
    setCompletionProvider(fn) {
        this.#completionProvider = typeof fn === 'function' ? fn : null
        this.#resetCompletionCycle()
    }

    /** Destroy this component: deactivate, clear callbacks and state. */
    destroy() {
        this.#active = false
        this.#callbacks.clear()
        this.#consumedKeys.clear()
        this.#history = []
        this.#currentBuffer = ''
        this.#cursorPos = 0
        this.#viewStart = 0
        this.#channelName = ''
        this.#completionProvider = null
        this.#pendingCompletion = null
    }

    //  -- Callbacks --------------------------------------------------------

    /** Key event handler. Processes keystrokes for input editing, navigation, and submission.
     * @private
     * @param {string} name - Key name from terminal-kit
     * @param {object} data - Raw key data from terminal-kit */
    #onKey(name, data) {
        if (!this.#active) return

        const n = name.toLowerCase()

        //  Any keystroke other than Tab invalidates a previous ambiguous-completion cycle so stale.
        if (n !== 'tab') this.#resetCompletionCycle()

        //  Skip keys that were pre-consumed by Ui (e.g., Alt+number shortcuts)
        if (this.#consumedKeys.has(n) || this.#consumedKeys.has(name)) {
            this.#consumedKeys.delete(n)
            this.#consumedKeys.delete(name)
            return
        }

        //  Ignore standalone Escape (used as prefix for Alt shortcuts)
        if (n === 'escape') return

        if (n === 'return' || n === 'enter') {
            this.#submitCommand()
            return
        }

        //  Backspace: remove one full Unicode code point before the cursor.
        if (n === 'backspace' || n === 'ctrl_h') {
            const from = this.#stepLeft(this.#cursorPos)
            if (from < this.#cursorPos) {
                this.#currentBuffer = this.#currentBuffer.slice(0, from) + this.#currentBuffer.slice(this.#cursorPos)
                this.#cursorPos = from
                this.#renderPrompt()
            }
            return
        }

        //  Delete: remove one full Unicode code point at the cursor position.
        if (n === 'delete') {
            const to = this.#stepRight(this.#cursorPos)
            if (to > this.#cursorPos) {
                this.#currentBuffer = this.#currentBuffer.slice(0, this.#cursorPos) + this.#currentBuffer.slice(to)
                this.#renderPrompt()
            }
            return
        }

        //  Left arrow: move cursor left by one full code point.
        if (n === 'left') {
            const pos = this.#stepLeft(this.#cursorPos)
            if (pos !== this.#cursorPos) {
                this.#cursorPos = pos
                this.#renderPrompt()
            }
            return
        }

        //  Right arrow: move cursor right by one full code point.
        if (n === 'right') {
            const pos = this.#stepRight(this.#cursorPos)
            if (pos !== this.#cursorPos) {
                this.#cursorPos = pos
                this.#renderPrompt()
            }
            return
        }

        //  Home: jump to beginning of line.
        if (n === 'home') {
            this.#cursorPos = 0
            this.#renderPrompt()
            return
        }

        //  End: jump to end of line.
        if (n === 'end') {
            this.#cursorPos = this.#currentBuffer.length
            this.#renderPrompt()
            return
        }

        //  Up arrow: navigate command history (older entries)
        if (n === 'up') {
            if (this.#history.length > 0) {
                if (this.#historyIndex < this.#history.length - 1) {
                    this.#historyIndex++
                    this.#currentBuffer = this.#history[this.#historyIndex]
                    this.#cursorPos = this.#currentBuffer.length
                    this.#renderPrompt()
                }
            }
            return
        }

        //  Down arrow: navigate command history (newer entries)
        if (n === 'down') {
            if (this.#historyIndex > 0) {
                this.#historyIndex--
                this.#currentBuffer = this.#history[this.#historyIndex]
                this.#cursorPos = this.#currentBuffer.length
                this.#renderPrompt()
            } else {
                this.#historyIndex = -1
                this.#currentBuffer = ''
                this.#cursorPos = 0
                this.#renderPrompt()
            }
            return
        }

        //  Tab: complete the token under the cursor via the installed provider (if any), cycling.
        if (n === 'tab') {
            this.#handleTab()
            return
        }

        //  Printable single-code-point keys: insert at the cursor position.
        if (this.#isInsertableChar(name)) {
            this.#currentBuffer = this.#currentBuffer.slice(0, this.#cursorPos) + name + this.#currentBuffer.slice(this.#cursorPos)
            this.#cursorPos += name.length
            this.#renderPrompt()
        }
    }

    //  -- Private Helpers --------------------------------------------------

    /** Handle a Tab press using the installed completion provider. When a previous Tab left an
     * @private */
    #handleTab() {
        if (!this.#completionProvider) return

        let text = ''
        let start = 0
        try {
            const pending = this.#pendingCompletion
            if (pending && Array.isArray(pending.alternatives) && pending.alternatives.length > 1) {
                //  Cycle: step to the next alternative in offer order.
                const alts = pending.alternatives
                const idx = (pending.index + 1) % alts.length
                text = String(alts[idx])
                start = Math.max(0, Number(pending.tokenStart) || 0)
                this.#pendingCompletion = { ...pending, index: idx }
            } else {
                const result = this.#completionProvider(this.#currentBuffer, this.#cursorPos)
                if (!result || typeof result !== 'object') return
                text = String(result.text ?? '')
                if (text === '') return
                start = Number.isInteger(result.tokenStart) ? Math.max(0, result.tokenStart) : 0
                if (Array.isArray(result.alternatives) && result.alternatives.length > 1) {
                    this.#pendingCompletion = { alternatives: [...result.alternatives], index: 0, tokenStart: start }
                } else {
                    this.#pendingCompletion = null
                }
            }
        } catch {
            this.#pendingCompletion = null
            return
        }

        //  Replace exactly what was typed for this word; code-point counting keeps astral characters.
        const safeStart = Math.min(start, this.#cursorPos)
        this.#currentBuffer = this.#currentBuffer.slice(0, safeStart) + text + this.#currentBuffer.slice(this.#cursorPos)
        this.#cursorPos = safeStart + [...text].length
        this.#renderPrompt()
    }

    /** Drop any in-progress ambiguous-completion cycle so a stale candidate list can never be applied
     * @private */
    #resetCompletionCycle() {
        this.#pendingCompletion = null
    }

    /** Step an index left by one full Unicode code point.
     * @param {number} pos - Current UTF-16 index into #currentBuffer
     * @returns {number} New index after stepping left (equals pos at buffer start)
     * @private */
    #stepLeft(pos) {
        const s = this.#currentBuffer
        let p = Math.min(Math.max(0, pos), s.length)
        if (p === 0) return 0
        p--
        //  If we landed on the low half of a surrogate pair, consume its high half too.
        if (p > 0) {
            const lo = s.charCodeAt(p)
            const hi = s.charCodeAt(p - 1)
            if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) p--
        }
        return p
    }

    /** Step an index right across one full Unicode code point. If the unit.
     * @param {number} pos - Current UTF-16 index into #currentBuffer
     * @returns {number} New index after stepping right (equals pos at buffer end)
     * @private */
    #stepRight(pos) {
        const s = this.#currentBuffer
        const p = Math.min(Math.max(0, pos), s.length)
        if (p >= s.length) return p
        const cur = s.charCodeAt(p)
        if (cur >= 0xd800 && cur <= 0xdbff && p + 1 < s.length) {
            const next = s.charCodeAt(p + 1)
            if (next >= 0xdc00 && next <= 0xdfff) return p + 2
        }
        return p + 1
    }

    /** Check whether a key name is one printable Unicode code point.
     * @param {string} ch - Raw key name from terminal-kit
     * @returns {boolean} true when the character can be safely inserted
     * @private */
    #isInsertableChar(ch) {
        if (typeof ch !== 'string' || (ch.length !== 1 && ch.length !== 2)) return false
        const cp = ch.codePointAt(0)
        if (Number.isNaN(cp)) return false
        //  Control characters and DEL are never printable; rejecting them keeps.
        if (cp < 0x20 || cp === 0x7f) return false
        //  A two-unit string must form a valid surrogate pair (astral char);
        if (cp >= 0xd800 && cp <= 0xdbff) {
            const lo = ch.charCodeAt(1)
            if (!(lo >= 0xdc00 && lo <= 0xdfff)) return false
        }
        if (ch.length === 1 && cp >= 0xdc00 && cp <= 0xdfff) return false
        return true
    }

    /** Submit the current buffer as a command: push to history, fire callbacks, then clear.
     * @private */
    #submitCommand() {
        const cmd = this.#currentBuffer.trim()
        if (!cmd) return

        this.#history.unshift(cmd)
        if (this.#history.length > 100) this.#history.pop()
        this.#historyIndex = -1

        for (const cb of this.#callbacks) {
            try { cb(cmd) } catch (e) { /* ignore */ }
        }

        this.#currentBuffer = ''
        this.#cursorPos = 0
        this.#viewStart = 0
        this.#renderPrompt()
    }

    /** Build the prompt string from the current channel name.
     * @private
     * @returns {string} */
    get #promptText() {
        return this.#channelName ? `[${this.#channelName}] ` : '> '
    }

    /** Render the prompt and current buffer in the input slot.
     * @private */
    #renderPrompt() {
        if (!this.#term || !this.#layout) return

        const slot = this.#layout.getSlot('input')
        if (!slot) return

        this.#term.hideCursor(true)

        const promptLen = this.#promptText.length
        //  Reserve one column at row end so the cursor always gets its own free cell;
        const maxTextWidth = Math.max(1, slot.width - promptLen - 1)

        //  Sliding window: adjust viewStart so cursor stays visible.
        if (this.#cursorPos < this.#viewStart) {
            this.#viewStart = this.#cursorPos
        } else if (this.#cursorPos >= this.#viewStart + maxTextWidth) {
            this.#viewStart = this.#cursorPos - maxTextWidth + 1
        }

        if (this.#viewStart + maxTextWidth > this.#currentBuffer.length) {
            this.#viewStart = Math.max(0, this.#currentBuffer.length - maxTextWidth)
        }

        let viewEnd = Math.min(this.#viewStart + maxTextWidth, this.#currentBuffer.length)

        //  Keep both window edges on code point borders.
        if (this.#isPairInterior(this.#currentBuffer, this.#viewStart)) this.#viewStart++
        if (this.#isPairInterior(this.#currentBuffer, viewEnd)) viewEnd--
        this.#viewStart = Math.min(this.#viewStart, viewEnd)

        const visibleChunk = this.#currentBuffer.slice(this.#viewStart, viewEnd)

        const relCursorPos = Math.max(0, Math.min(this.#cursorPos - this.#viewStart, visibleChunk.length))

        const before = visibleChunk.slice(0, relCursorPos)
        const after = visibleChunk.slice(relCursorPos)

        //  Render the input slot (no explicit color -- use terminal default foreground)
        this.#layout.moveToSlot('input')
        this.#term(this.#promptText)

        this.#term.bold.white(before)
        this.#term(after)

        this.#term.eraseLineAfter()
        this.#term.styleReset()

        //  Reposition cursor at the correct column; count code points so astral.
        const col = slot.x + 1 + promptLen + [...before].length
        this.#term.moveTo(Math.min(col, slot.x + slot.width), slot.y + 1)

        this.#term.hideCursor(false)
    }

    /** Check whether a UTF-16 index lands between the two halves of a surrogate.
     * @param {string} s - Buffer to inspect
     * @param {number} pos - UTF-16 index into s
     * @returns {boolean} true when pos sits inside a surrogate pair
     * @private */
    #isPairInterior(s, pos) {
        if (pos <= 0 || pos >= s.length) return false
        const lo = s.charCodeAt(pos)
        const hi = s.charCodeAt(pos - 1)
        return lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff
    }
}

export default InputComponent