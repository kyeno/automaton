/**
 * UI Layout Manager.
 *
 * Partitions the terminal into three fixed slots:
 * 1. main - The primary content area (top).
 * 2. status - A 2-line status area (middle-bottom).
 * 3. input - A 1-line command input area (bottom).
 *
 * Dependencies: receives `term` via constructor.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/** Minimum usable slot width below which rendering is suppressed. */
const MIN_SLOT_WIDTH = 50

// ---------------------------------------------------------------------------
// UiLayoutManager
// ---------------------------------------------------------------------------

/**
 * Partitions the terminal into three fixed slots (main, status, input)
 * and provides methods to position the cursor, clear areas, and handle
 * resize events for IRC-style terminal UI rendering.
 */
class UiLayoutManager {
    #term
    #slots = {}

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new layout manager and calculate initial slot dimensions.
     * @param {*} term - The terminal-kit instance
     */
    constructor(term) {
        this.#term = term
        this.updateSlots()
    }

    // -- Public API -------------------------------------------------------

    /**
     * Recalculate slot dimensions based on current terminal size.
     */
    updateSlots() {
        const t = this.#term
        if (!t) return

        const cols = t.width || 80
        const rows = t.height || 24

        // IRC-style layout:
        // Input = 1 line
        // Status = 2 lines
        // Main = everything else
        this.#slots = {
            main: {
                x: 0,
                y: 0,
                width: cols,
                height: Math.max(rows - 3, 3)
            },
            status: {
                x: 0,
                y: rows - 3,
                width: cols,
                height: 2
            },
            input: {
                x: 0,
                y: rows - 1,
                width: cols,
                height: 1
            }
        }
    }

    /**
     * Get the dimensions and position of a specific slot.
     * @param {string} slotName - 'main' | 'status' | 'input'
     * @returns {{x: number, y: number, width: number, height: number}|null}
     */
    getSlot(slotName) {
        return this.#slots[slotName] || null
    }

    /**
     * Move cursor to the top-left corner of a named slot.
     * @param {string} slotName - 'main' | 'status' | 'input'
     */
    moveToSlot(slotName) {
        const slot = this.#slots[slotName]
        if (!slot || !this.#term) return
        // terminal-kit uses 1-based coordinates
        this.#term.moveTo(slot.x + 1, slot.y + 1)
    }

    /**
     * Clear all content within a named slot.
     * @param {string} slotName - 'main' | 'status' | 'input'
     */
    clearSlot(slotName) {
        const slot = this.#slots[slotName]
        if (!slot || !this.#term) return

        // terminal-kit uses 1-based coordinates
        this.#term.moveTo(slot.x + 1, slot.y + 1)
        for (let i = 0; i < slot.height; i++) {
            this.#term.eraseLine()
            if (i < slot.height - 1) {
                this.#term.nextLine()
            }
        }
        this.moveToSlot(slotName)
    }

    /**
     * Check if any slot is too narrow for safe rendering.
     * Returns true when the main slot width is below MIN_SLOT_WIDTH,
     * indicating renderers should bail out and show a warning instead.
     * @returns {boolean}
     */
    isTooNarrow() {
        const slot = this.#slots['main']
        return !slot || slot.width < MIN_SLOT_WIDTH
    }

    /**
     * Render a "terminal too narrow" warning centered in the given slot.
     * Clears the slot first, then displays a red warning message.
     * @param {string} slotName - 'main' | 'status'
     */
    renderTooNarrowWarning(slotName) {
        const slot = this.#slots[slotName]
        if (!slot || !this.#term) return

        // Clear the slot
        this.clearSlot(slotName)

        const msg = '\x1b[31m\x1b[1m [!] TERMINAL TOO NARROW -- PLEASE RESIZE \x1b[0m'
        const msgLen = msg.replace(/\x1b\[[0-9;]*m/g, '').length
        const padLeft = Math.max(0, Math.floor((slot.width - msgLen) / 2))

        for (let row = 0; row < slot.height; row++) {
            this.#term.moveTo(slot.x + 1, slot.y + 1 + row)
            if (row === 0 && padLeft > 0) {
                this.#term(' '.repeat(padLeft))
            }
            this.#term(msg)
        }

        // Move cursor back to start of slot
        this.moveToSlot(slotName)
    }

    /**
     * Return the underlying terminal-kit instance.
     * @returns {*} The terminal instance
     */
    getTerm() {
        return this.#term
    }
}

export default UiLayoutManager
