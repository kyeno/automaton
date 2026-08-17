/**
 * Input Component -- persistent bottom-row command prompt.
 *
 * Uses terminal-kit's 'key' event (enabled by grabInput()) to accumulate
 * characters into a buffer. Handles Enter (submit), Backspace (delete),
 * and Arrow keys (history); Ctrl+C exits the application via Ui's own key
 * handler, which is registered before this component's listener. Renders
 * the prompt+buffer in the layout's 'input' slot only.
 *
 * Prompt is dynamically set via setChannel(channelName) so each window
 * shows its IRC-style channel name (e.g., [!log], [#automaton]).
 *
 * Dependencies: receives `term` and `layout` via constructor.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import StateService from '../../service/stateService.js'

// ---------------------------------------------------------------------------
// InputComponent
// ---------------------------------------------------------------------------

/**
 * Persistent bottom-row command prompt widget.
 * Accumulates keystrokes into a buffer, handles Enter (submit), Backspace,
 * and Arrow keys (history navigation). Ctrl+C terminates the UI -- handled
 * earlier by Ui's own key listener. Renders the prompt with the current
 * channel name in the layout's 'input' slot.
 */
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

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new InputComponent instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     */
    constructor(term, layout) {
        this.#term = term
        this.#layout = layout
    }

    /**
     * Activate the input component, register key handlers, and render the initial prompt.
     */
    init() {
        if (!this.#term || !this.#layout) return
        this.#term.on('key', this.#onKey.bind(this))
        this.#active = true

        StateService.set('ui.refreshInputCursor', () => this.#renderPrompt())

        this.#renderPrompt()
    }

    // -- Public API -------------------------------------------------------

    /**
     * Update the channel name shown in the prompt (e.g., "[!log]", "[#automaton]").
     * Called by Ui.switchWindow().
     * @param {string} name - IRC-style channel name
     */
    setChannel(name) {
        this.#channelName = name || ''
        this.#renderPrompt()
    }

    /**
     * Mark specific keys as consumed so InputComponent will ignore them.
     * Used by Ui to prevent duplicate handling of Alt+number shortcuts.
     * @param {string[]} keyNames - Array of key name strings to mark as consumed
     */
    markConsumed(keyNames) {
        for (const k of keyNames) this.#consumedKeys.add(k)
    }

    /**
     * Clear all consumed key markers.
     */
    clearConsumed() {
        this.#consumedKeys.clear()
    }

    /**
     * Register a callback that fires on every submitted command.
     * @param {function(string): void} cb - Callback receiving the command string
     * @returns {function(): void} Unsubscribe function to remove the callback
     */
    onCommand(cb) {
        this.#callbacks.add(cb)
        return () => this.#callbacks.delete(cb)
    }

    /**
     * Destroy this component: deactivate, clear callbacks and state.
     */
    destroy() {
        this.#active = false
        this.#callbacks.clear()
        this.#consumedKeys.clear()
        this.#history = []
        this.#currentBuffer = ''
        this.#cursorPos = 0
        this.#viewStart = 0
        this.#channelName = ''
    }

    // -- Callbacks --------------------------------------------------------

    /**
     * Key event handler. Processes keystrokes for input editing, navigation, and submission.
     * @param {string} name - Key name from terminal-kit
     * @param {object} data - Raw key data from terminal-kit
     */
    #onKey(name, data) {
        if (!this.#active) return

        const n = name.toLowerCase()

        // Skip keys that were pre-consumed by Ui (e.g., Alt+number shortcuts)
        if (this.#consumedKeys.has(n) || this.#consumedKeys.has(name)) {
            this.#consumedKeys.delete(n)
            this.#consumedKeys.delete(name)
            return
        }

        // Ignore standalone Escape (used as prefix for Alt shortcuts)
        if (n === 'escape') return

        // Enter: submit the command
        if (n === 'return' || n === 'enter') {
            this.#submitCommand()
            return
        }

        // Backspace: remove one full Unicode code point before the cursor
        if (n === 'backspace' || n === 'ctrl_h') {
            const from = this.#stepLeft(this.#cursorPos)
            if (from < this.#cursorPos) {
                this.#currentBuffer = this.#currentBuffer.slice(0, from) + this.#currentBuffer.slice(this.#cursorPos)
                this.#cursorPos = from
                this.#renderPrompt()
            }
            return
        }

        // Delete: remove one full Unicode code point at the cursor position
        if (n === 'delete') {
            const to = this.#stepRight(this.#cursorPos)
            if (to > this.#cursorPos) {
                this.#currentBuffer = this.#currentBuffer.slice(0, this.#cursorPos) + this.#currentBuffer.slice(to)
                this.#renderPrompt()
            }
            return
        }

        // Left arrow: move cursor left by one full code point
        if (n === 'left') {
            const pos = this.#stepLeft(this.#cursorPos)
            if (pos !== this.#cursorPos) {
                this.#cursorPos = pos
                this.#renderPrompt()
            }
            return
        }

        // Right arrow: move cursor right by one full code point
        if (n === 'right') {
            const pos = this.#stepRight(this.#cursorPos)
            if (pos !== this.#cursorPos) {
                this.#cursorPos = pos
                this.#renderPrompt()
            }
            return
        }

        // Home: jump to beginning of line
        if (n === 'home') {
            this.#cursorPos = 0
            this.#renderPrompt()
            return
        }

        // End: jump to end of line
        if (n === 'end') {
            this.#cursorPos = this.#currentBuffer.length
            this.#renderPrompt()
            return
        }

        // Up arrow: navigate command history (older entries)
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

        // Down arrow: navigate command history (newer entries)
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

        // Ignore Tab key
        if (n === 'tab') return

        // Printable single-code-point keys: insert at the cursor position.
        // Accepts BMP and astral characters but rejects lone surrogates so a
        // half of a surrogate pair can never corrupt the buffer on later edits.
        if (this.#isInsertableChar(name)) {
            this.#currentBuffer = this.#currentBuffer.slice(0, this.#cursorPos) + name + this.#currentBuffer.slice(this.#cursorPos)
            this.#cursorPos += name.length
            this.#renderPrompt()
        }
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Step an index left by one full Unicode code point. The step first moves
     * back one UTF-16 unit; when that lands on the low half of a surrogate
     * pair it steps back over the matching high half as well, so navigation
     * and deletion always treat a multi-unit character as a single unit.
     * @param {number} pos - Current UTF-16 index into #currentBuffer
     * @returns {number} New index after stepping left (equals pos at buffer start)
     * @private
     */
    #stepLeft(pos) {
        const s = this.#currentBuffer
        let p = Math.min(Math.max(0, pos), s.length)
        if (p === 0) return 0
        p--
        // If we landed on the low half of a surrogate pair, consume its high half too
        if (p > 0) {
            const lo = s.charCodeAt(p)
            const hi = s.charCodeAt(p - 1)
            if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) p--
        }
        return p
    }

    /**
     * Step an index right across one full Unicode code point. If the unit at
     * pos starts a surrogate pair, the step lands past both halves so pairs are
     * always treated as a single character by navigation and deletion.
     * @param {number} pos - Current UTF-16 index into #currentBuffer
     * @returns {number} New index after stepping right (equals pos at buffer end)
     * @private
     */
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

    /**
     * Check whether a key name is one printable Unicode code point that may be
     * inserted into the buffer. Rejects control keys, multi-character strings,
     * and lone surrogates which would corrupt later edits.
     * @param {string} ch - Raw key name from terminal-kit
     * @returns {boolean} true when the character can be safely inserted
     * @private
     */
    #isInsertableChar(ch) {
        if (typeof ch !== 'string' || (ch.length !== 1 && ch.length !== 2)) return false
        const cp = ch.codePointAt(0)
        if (Number.isNaN(cp)) return false
        // Control characters and DEL are never printable; rejecting them keeps
        // invisible bytes out of the buffer no matter how they arrive.
        if (cp < 0x20 || cp === 0x7f) return false
        // A two-unit string must form a valid surrogate pair (astral char);
        // a single unit in the surrogate range is always invalid on its own.
        if (cp >= 0xd800 && cp <= 0xdbff) {
            const lo = ch.charCodeAt(1)
            if (!(lo >= 0xdc00 && lo <= 0xdfff)) return false
        }
        if (ch.length === 1 && cp >= 0xdc00 && cp <= 0xdfff) return false
        return true
    }

    /**
     * Submit the current buffer as a command: push to history, fire callbacks, then clear.
     */
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

    /**
     * Build the prompt string from the current channel name.
     * Format: "[!log] " or "> " when no channel is set.
     * @returns {string}
     */
    get #promptText() {
        return this.#channelName ? `[${this.#channelName}] ` : '> '
    }

    /**
     * Render the prompt and current buffer in the input slot.
     * Implements a sliding window so long commands scroll properly; window
     * edges are kept on code point borders so astral characters are never
     * split across renders into lone surrogates.
     */
    #renderPrompt() {
        if (!this.#term || !this.#layout) return

        const slot = this.#layout.getSlot('input')
        if (!slot) return

        this.#term.hideCursor(true)

        const promptLen = this.#promptText.length
        // Reserve one column at row end so the cursor always gets its own free cell;
        // without it a full-width line clamps the cursor onto the last glyph which
        // reads as overwrite mode while typing long commands.
        const maxTextWidth = Math.max(1, slot.width - promptLen - 1)

        // Sliding window: adjust viewStart so cursor stays visible
        if (this.#cursorPos < this.#viewStart) {
            this.#viewStart = this.#cursorPos
        } else if (this.#cursorPos >= this.#viewStart + maxTextWidth) {
            this.#viewStart = this.#cursorPos - maxTextWidth + 1
        }

        if (this.#viewStart + maxTextWidth > this.#currentBuffer.length) {
            this.#viewStart = Math.max(0, this.#currentBuffer.length - maxTextWidth)
        }

        let viewEnd = Math.min(this.#viewStart + maxTextWidth, this.#currentBuffer.length)

        // Keep both window edges on code point borders -- an edge inside a
        // surrogate pair would render as one invisible replacement character.
        if (this.#isPairInterior(this.#currentBuffer, this.#viewStart)) this.#viewStart++
        if (this.#isPairInterior(this.#currentBuffer, viewEnd)) viewEnd--
        this.#viewStart = Math.min(this.#viewStart, viewEnd)

        const visibleChunk = this.#currentBuffer.slice(this.#viewStart, viewEnd)

        const relCursorPos = Math.max(0, Math.min(this.#cursorPos - this.#viewStart, visibleChunk.length))

        const before = visibleChunk.slice(0, relCursorPos)
        const after = visibleChunk.slice(relCursorPos)

        // Render the input slot (no explicit color -- use terminal default foreground)
        this.#layout.moveToSlot('input')
        this.#term(this.#promptText)

        this.#term.bold.white(before)
        this.#term(after)

        this.#term.eraseLineAfter()
        this.#term.styleReset()

        // Reposition cursor at the correct column; count code points so astral
        // characters occupy exactly one cell like every other single character.
        const col = slot.x + 1 + promptLen + [...before].length
        this.#term.moveTo(Math.min(col, slot.x + slot.width), slot.y + 1)

        this.#term.hideCursor(false)
    }

    /**
     * Check whether a UTF-16 index lands between the two halves of a surrogate
     * pair, i.e., on the low half whose preceding unit is its high partner.
     * Window edges and cursor positions must never rest there or rendering
     * would split the character into an invisible replacement glyph.
     * @param {string} s - Buffer to inspect
     * @param {number} pos - UTF-16 index into s
     * @returns {boolean} true when pos sits inside a surrogate pair
     * @private
     */
    #isPairInterior(s, pos) {
        if (pos <= 0 || pos >= s.length) return false
        const lo = s.charCodeAt(pos)
        const hi = s.charCodeAt(pos - 1)
        return lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff
    }
}

export default InputComponent