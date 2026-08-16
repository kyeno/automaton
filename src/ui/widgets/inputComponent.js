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

        // Backspace: remove character before the cursor
        if (n === 'backspace' || n === 'ctrl_h') {
            if (this.#cursorPos > 0) {
                this.#currentBuffer = this.#currentBuffer.slice(0, this.#cursorPos - 1) + this.#currentBuffer.slice(this.#cursorPos)
                this.#cursorPos--
                this.#renderPrompt()
            }
            return
        }

        // Delete: remove character at the cursor position
        if (n === 'delete') {
            if (this.#cursorPos < this.#currentBuffer.length) {
                this.#currentBuffer = this.#currentBuffer.slice(0, this.#cursorPos) + this.#currentBuffer.slice(this.#cursorPos + 1)
                this.#renderPrompt()
            }
            return
        }

        // Left arrow: move cursor left
        if (n === 'left') {
            if (this.#cursorPos > 0) {
                this.#cursorPos--
                this.#renderPrompt()
            }
            return
        }

        // Right arrow: move cursor right
        if (n === 'right') {
            if (this.#cursorPos < this.#currentBuffer.length) {
                this.#cursorPos++
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

        // Single-character keys: insert character at cursor position
        if (name.length === 1) {
            this.#currentBuffer = this.#currentBuffer.slice(0, this.#cursorPos) + name + this.#currentBuffer.slice(this.#cursorPos)
            this.#cursorPos++
            this.#renderPrompt()
        }
    }

    // -- Private Helpers --------------------------------------------------

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
     * Implements a sliding window so long commands scroll properly.
     */
    #renderPrompt() {
        if (!this.#term || !this.#layout) return

        const slot = this.#layout.getSlot('input')
        if (!slot) return

        this.#term.hideCursor(true)

        const promptLen = this.#promptText.length
        const maxTextWidth = Math.max(1, slot.width - promptLen)

        // Sliding window: adjust viewStart so cursor stays visible
        if (this.#cursorPos < this.#viewStart) {
            this.#viewStart = this.#cursorPos
        } else if (this.#cursorPos >= this.#viewStart + maxTextWidth) {
            this.#viewStart = this.#cursorPos - maxTextWidth + 1
        }

        if (this.#viewStart + maxTextWidth > this.#currentBuffer.length) {
            this.#viewStart = Math.max(0, this.#currentBuffer.length - maxTextWidth)
        }

        const visibleChunk = this.#currentBuffer.slice(this.#viewStart, this.#viewStart + maxTextWidth)

        const relCursorPos = this.#cursorPos - this.#viewStart

        const before = visibleChunk.slice(0, relCursorPos)
        const after = visibleChunk.slice(relCursorPos)

        // Render the input slot (no explicit color -- use terminal default foreground)
        this.#layout.moveToSlot('input')
        this.#term(this.#promptText)

        this.#term.bold.white(before)
        this.#term(after)

        this.#term.eraseLineAfter()
        this.#term.styleReset()

        // Reposition cursor at the correct column
        const col = slot.x + 1 + promptLen + before.length
        this.#term.moveTo(Math.min(col, slot.x + slot.width), slot.y + 1)

        this.#term.hideCursor(false)
    }
}

export default InputComponent