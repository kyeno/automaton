/**
 * Base Window Class.
 *
 * Provides the foundation for all windows in the main slot.
 * Handles line buffering, scroll offsets, and rendering within
 * the constraints of the UiLayoutManager's main slot.
 *
 * Dependencies: receives `term` and `layoutManager` via constructor.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import StateService from '../../service/stateService.js'
import { wrapAnsi, visibleLen } from '../../lib/terminal.js'
import AnsiColors from '../../enum/ansiColors.js'

// ---------------------------------------------------------------------------
// Constants (overridable via ui.yaml windows.max_buffer_lines / layout.min_width)
// ---------------------------------------------------------------------------

/** Max buffered entries per window; above 5000 risks OOM on narrow-terminal resize. */
const DEFAULT_MAX_BUFFER_LINES = 2000

/** Minimum wrapping width for plain-string entries (log lines). Prevents OOM from wrapping explosion. */
const MIN_WRAP_WIDTH = 50

/** Minimum effective wrapping width for structured messages after subtracting prefix length. */
const MIN_EFFECTIVE_WIDTH = 30

// ---------------------------------------------------------------------------
// BaseWindow
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all terminal UI windows.
 * Manages line buffering with configurable max lines, scroll offsets,
 * backscroll detection, and rendering within the layout's main slot.
 * Supports both plain-string print() and structured message buffering
 * for proper text wrapping on terminal resize.
 */
class BaseWindow {
    /** How to interpret text input: 'chat' (send to AI silently) or 'command' (log + slash-command) */
    static inputMode = 'command'

    #term
    #layout
    // Buffer stores either plain strings or structured objects:
    //   { text: string, prefix: string } -- IRC-style message with prefix on first wrapped line
    #buffer = []
    #title = 'Window'
    #visible = false
    #renderPending = false
    /** Configurable buffer limit (settable externally). */
    #maxBufferLines = DEFAULT_MAX_BUFFER_LINES
    /** Tracks whether the terminal was previously too narrow for rendering. */
    #wasNarrow = false
    /** Numeric shortcut for EventBus activity emissions (from channel config). */
    #channelShortcut = 0
    /** Scroll offset from the bottom (0 = following tail/live mode). */
    #scrollOffset = 0
    /** Number of buffer entries at last render -- used to detect new content for incremental rendering. */
    #bufferEntryCountAtLastRender = 0
    /** Slot width at last render -- detects resize forcing full re-render. */
    #lastSlotWidth = 0
    /** Whether the next render must be a full re-render (resize, clear, etc.). */
    #forceFullRender = true

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new BaseWindow instance.
     * @param {string} title - Display title for this window
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     * @param {number} channelShortcut - Numeric shortcut from channel config for EventBus activity
     */
    constructor(title, term, layout, channelShortcut = 0) {
        this.#title = title
        this.#term = term
        this.#layout = layout
        this.#channelShortcut = channelShortcut
    }

    // -- Public API -------------------------------------------------------

    /**
     * Show or hide this window.
     * When made visible, triggers an immediate render.
     * @param {boolean} visible
     */
    setVisible(visible) {
        this.#visible = visible
        if (visible) {
            this.render()
        }
    }

    /**
     * Show this window, force a full re-render, and trigger draw.
     */
    show() {
        this.#forceFullRender = true
        this.setVisible(true)
    }

    /**
     * Hide this window.
     */
    hide() { this.setVisible(false) }

    /**
     * Check if this window is currently visible.
     * @returns {boolean}
     */
    get isVisible() { return this.#visible }

    /**
     * Get the dimensions of a named layout slot.
     * @param {string} slotName - 'main' | 'status' | 'input'
     * @returns {{x: number, y: number, width: number, height: number}|null}
     */
    getLayoutSlot(slotName) { return this.#layout.getSlot(slotName) }

    /**
     * Set the maximum number of buffered entries before trimming oldest.
     * @param {number} n
     */
    setMaxBufferLines(n) {
        this.#maxBufferLines = Math.max(100, Number(n) || DEFAULT_MAX_BUFFER_LINES)
    }

    /**
     * Append plain text to the buffer and re-render if visible.
     * Splits multi-line strings on '\n' so each segment becomes its own visual line
     * (wrapAnsi does NOT handle newlines -- that responsibility is on the caller).
     * Truncates extremely large inputs to prevent OOM / render freezes.
     * @param {string} text
     */
    print(text) {
        // Guard against massive single prints (e.g., StateService.dump JSON)
        const MAX_CHARS = 50_000
        let truncated = false
        if (text.length > MAX_CHARS) {
            text = text.slice(0, MAX_CHARS) + '\n... [output truncated]'
            truncated = true
        }
        for (const line of text.split('\n')) {
            this.#buffer.push(line)
            // If truncating, check budget after each line to avoid overshooting
            if (truncated && this.#buffer.length >= this.#maxBufferLines) break
        }
        this.#trimBuffer()
        if (this.#visible) {
            this.render()
        }
    }

    /**
     * Append an IRC-style structured message to the buffer.
     * The raw `text` is wrapped at render time using the current slot width,
     * with `prefix` applied to the first wrapped line and matching spaces
     * applied to continuation lines. This ensures correct re-wrapping on resize.
     *
     * @param {string} text - Raw message body (unwrapped)
     * @param {string} prefix - Prefix for the first line (e.g. "[HH:mm:ss] <AI> ")
     */
    printMessage(text, prefix) {
        this.#buffer.push({ text, prefix })
        this.#trimBuffer()
        if (this.#visible) {
            this.render()
        }
    }

    /**
     * Clear the buffer and force a full re-render on next draw.
     */
    clear() {
        this.#buffer = []
        this.#scrollOffset = 0
        this.#forceFullRender = true
        this.#bufferEntryCountAtLastRender = 0
        if (this.#visible) {
            this.render()
        }
    }

    /**
     * Scroll one page up (away from the live tail).
     * No-op if already at the top of the buffer.
     */
    scrollPageUp() {
        const slot = this.#layout?.getSlot('main')
        if (!slot) return
        // Calculate total visual lines to know if there's room to scroll
        const wrapWidth = Math.max(slot.width, MIN_WRAP_WIDTH)
        const totalVisual = this.#countVisualLines(wrapWidth)
        const maxOffset = Math.max(0, totalVisual - slot.height)
        this.#scrollOffset = Math.min(this.#scrollOffset + slot.height, maxOffset)
        this.#forceFullRender = true
        if (this.#visible) {
            this.render()
        }
    }

    /**
     * Scroll one page down toward the live tail.
     * When reaching the bottom, reset to live-follow mode.
     */
    scrollPageDown() {
        const slot = this.#layout?.getSlot('main')
        if (!slot) return
        const wrapWidth = Math.max(slot.width, MIN_WRAP_WIDTH)
        const totalVisual = this.#countVisualLines(wrapWidth)
        const maxOffset = Math.max(0, totalVisual - slot.height)
        this.#scrollOffset = Math.max(0, this.#scrollOffset - slot.height)
        // If at or below the bottom, snap to live-follow mode
        if (this.#scrollOffset <= 0) {
            this.#scrollOffset = 0
        }
        this.#forceFullRender = true
        if (this.#visible) {
            this.render()
        }
    }

    /**
     * Return current scroll offset (for status bar "More" indicator).
     * @returns {number}
     */
    getScrollOffset() { return this.#scrollOffset }

    /**
     * Check if buffer has no entries.
     * @returns {boolean} true when buffer is empty
     */
    get isEmpty() { return this.#buffer.length === 0 }

    /**
     * Check if window is currently in backscrolled state (not following tail).
     * @returns {boolean}
     */
    isBackscrolled() { return this.#scrollOffset > 0 }

    /**
     * Force the next render to be a full re-render.
     * Call this on resize or when wrapping may have changed.
     */
    forceFullRender() {
        this.#forceFullRender = true
    }

    /**
     * Trim the buffer to stay within #maxBufferLines by removing oldest entries first.
     * @private
     */
    #trimBuffer() {
        if (this.#buffer.length > this.#maxBufferLines) {
            this.#buffer = this.#buffer.slice(-this.#maxBufferLines)
        }
    }

    /**
     * Return the display title for this window.
     * @returns {string}
     */
    getTitle() { return this.#title }

    /**
     * Return the numeric channel shortcut for EventBus activity emissions.
     * @returns {number}
     */
    getChannelShortcut() { return this.#channelShortcut }

    // -- Rendering --------------------------------------------------------

    /**
     * Throttled render -- caps refresh rate at ~33 FPS to prevent lag during heavy output.
     */
    render() {
        if (!this.#visible || !this.#term || this.#renderPending) return

        this.#renderPending = true
        setTimeout(() => {
            this.#renderPending = false
            this.#executeRender()
        }, 30) // Max ~33 refreshes per second
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Count total visual lines produced by wrapping all buffer entries.
     * Used by scrollPageUp/scrollPageDown to determine scroll boundaries.
     * @param {number} wrapWidth - Width to use for wrapping
     * @returns {number} Total visual line count
     * @private
     */
    #countVisualLines(wrapWidth) {
        let count = 0
        this.#buffer.forEach(entry => {
            if (typeof entry === 'string') {
                count += wrapAnsi(entry, wrapWidth).length
            } else {
                const { text, prefix } = entry
                const prefixVisibleLen = visibleLen(prefix)
                const effectiveWidth = Math.max(
                    wrapWidth - prefixVisibleLen,
                    MIN_EFFECTIVE_WIDTH
                )
                const segments = text.split('\n').map(s => s.trim()).filter(Boolean)
                segments.forEach(segment => {
                    count += wrapAnsi(segment, effectiveWidth).length
                })
            }
        })
        return count
    }

    /**
     * Wrap a single buffer entry into visual lines.
     * Extracted so it can be reused for both full and incremental rendering.
     * @param {*} entry - Buffer entry (string or {text, prefix})
     * @param {number} wrapWidth - Wrapping width
     * @returns {string[]} Wrapped visual lines
     * @private
     */
    #wrapEntry(entry, wrapWidth) {
        if (typeof entry === 'string') {
            return wrapAnsi(entry, wrapWidth)
        }
        const { text, prefix } = entry
        const prefixVisibleLen = visibleLen(prefix)
        const effectiveWidth = Math.max(
            wrapWidth - prefixVisibleLen,
            MIN_EFFECTIVE_WIDTH
        )
        const padding = ' '.repeat(prefixVisibleLen)
        const result = []
        const segments = text.split('\n').map(s => s.trim()).filter(Boolean)
        let isFirstSegment = true
        segments.forEach(segment => {
            const wrapped = wrapAnsi(segment, effectiveWidth)
            wrapped.forEach((line, i) => {
                if (isFirstSegment && i === 0) {
                    result.push(`${prefix}${line}`)
                    isFirstSegment = false
                } else {
                    result.push(`${padding}${line}`)
                }
            })
        })
        return result
    }

    /**
     * Perform the actual rendering of the window content within the main slot.
     * Uses ANSI-aware wrapping from lib/terminal to preserve color formatting.
     * Structured messages ({text, prefix}) are wrapped dynamically at render time
     * so they re-wrap correctly when the terminal is resized.
     *
     * Supports incremental rendering: when width hasn't changed and no force flag
     * is set, only new entries since last render are wrapped and appended -- avoiding
     * the costly clearSlot() + full redraw that causes screen flicker.
     * @private
     */
    #executeRender() {
        if (!this.#visible || !this.#term) return

        const slot = this.#layout.getSlot('main')
        if (!slot) return

        // Use centralized check from layout manager
        const tooNarrow = this.#layout.isTooNarrow()

        if (tooNarrow) {
            if (!this.#wasNarrow) {
                this.#wasNarrow = true
                this.#term.hideCursor(true)
                this.#layout.renderTooNarrowWarning('main')
                this.#term.hideCursor(false)
            }
            return
        }

        if (this.#wasNarrow) {
            this.#wasNarrow = false
            this.#forceFullRender = true
        }

        // Detect resize -- forces full re-render since wrapping changes
        if (slot.width !== this.#lastSlotWidth) {
            this.#forceFullRender = true
        }

        const wrapWidth = Math.max(slot.width, MIN_WRAP_WIDTH)
        const term = this.#term

        // Hide cursor during drawing to prevent flickering
        term.hideCursor(true)

        if (this.#forceFullRender) {
            // --- FULL RENDER: redraw everything from the buffer ---------------
            this.#renderAll(slot, wrapWidth, this.#scrollOffset)

            // Update tracking state for next incremental render
            this.#lastSlotWidth = slot.width
            this.#bufferEntryCountAtLastRender = this.#buffer.length
            this.#forceFullRender = false

        } else {
            // --- INCREMENTAL RENDER: only process new entries -----------------
            const newEntries = this.#buffer.slice(this.#bufferEntryCountAtLastRender)

            if (newEntries.length > 0 || this.#scrollOffset !== 0) {
                if (this.#scrollOffset === 0) {
                    // Live-follow mode: append only new lines at absolute positions

                    // First, count how many visual lines were already on screen
                    const oldVisualCount = Math.min(
                        this.#bufferEntryCountAtLastRender > 0
                            ? this.#countExistingVisualLines(this.#bufferEntryCountAtLastRender, wrapWidth)
                            : 0,
                        slot.height
                    )

                    // Wrap only new entries
                    const newVisualLines = []
                    newEntries.forEach(entry => {
                        newVisualLines.push(...this.#wrapEntry(entry, wrapWidth))
                    })

                    // If existing content scrolled off the top, fall back to a full
                    // re-render for correctness. scrollOffset is 0 here by guard, so
                    // #renderAll draws exactly the bottom `slot.height` lines.
                    const overflow = oldVisualCount + newVisualLines.length - slot.height
                    if (overflow > 0) {
                        this.#renderAll(slot, wrapWidth, 0)
                    } else {
                        // No overflow -- true incremental case: draw the new lines
                        // below whatever was already on screen.
                        let screenRow = oldVisualCount
                        newVisualLines.forEach((line) => {
                            if (screenRow < slot.height) {
                                term.moveTo(slot.x + 1, slot.y + 1 + screenRow)
                                term(line)
                            }
                            screenRow++
                        })
                    }
                } else {
                    // Backscrolled -- do a full re-render to update positions correctly
                    this.#renderAll(slot, wrapWidth, this.#scrollOffset)
                }

                this.#bufferEntryCountAtLastRender = this.#buffer.length
            }
        }

        // Restore the input prompt cursor position after rendering
        const refreshInput = StateService.get('ui.refreshInputCursor')
        if (refreshInput) {
            refreshInput()
        }

        // Show the cursor again
        term.hideCursor(false)
    }

    /**
     * Count visual lines produced by the first N buffer entries.
     * Used to determine how many screen rows were occupied before new content arrived.
     * @param {number} entryCount - Number of buffer entries from start to count
     * @param {number} wrapWidth - Wrapping width
     * @returns {number} Visual line count
     * @private
     */
    #countExistingVisualLines(entryCount, wrapWidth) {
        let count = 0
        for (let i = 0; i < Math.min(entryCount, this.#buffer.length); i++) {
            count += this.#wrapEntry(this.#buffer[i], wrapWidth).length
        }
        return count
    }

    /**
     * Full-screen render of all buffered entries within the main slot.
     *
     * Clears the slot, wraps every entry at the current width, applies the
     * scroll offset (tail window), appends the "-- More --" indicator when
     * backscrolled, and draws each line at its absolute position. Shared by
     * the forced-full, backscrolled, and overflow-fallback paths so they
     * cannot drift apart.
     *
     * @param {{x: number, y: number, width: number, height: number}} slot - Main layout slot
     * @param {number} wrapWidth - Wrapping width in visible characters
     * @param {number} scrollOffset - Scroll offset from bottom (0 = live tail)
     * @private
     */
    #renderAll(slot, wrapWidth, scrollOffset) {
        const term = this.#term
        this.#layout.clearSlot('main')

        const visualLines = []
        this.#buffer.forEach(entry => {
            visualLines.push(...this.#wrapEntry(entry, wrapWidth))
        })

        // Apply scroll offset: tailStart counts back from the end
        const tailStart = Math.max(0, visualLines.length - slot.height - scrollOffset)
        const linesToRender = visualLines.slice(tailStart, tailStart + slot.height)

        // Show "-- More --" indicator when backscrolled
        if (scrollOffset > 0 && linesToRender.length < slot.height) {
            linesToRender.push(this.#buildMoreIndicator(wrapWidth, tailStart, visualLines.length))
        }

        linesToRender.forEach((line, index) => {
            term.moveTo(slot.x + 1, slot.y + 1 + index)
            term(line)
        })
    }

    /**
     * Build a "-- More --" indicator line with padding matching slot width.
     * @param {number} wrapWidth - Slot wrapping width
     * @param {number} tailStart - Index in visualLines where viewport starts
     * @param {number} totalLines - Total visual lines available
     * @returns {string} Formatted indicator line
     * @private
     */
    #buildMoreIndicator(wrapWidth, tailStart, totalLines) {
        const label = `-- ${tailStart + 1}/${totalLines} --`
        const pad = Math.max(0, wrapWidth - label.length)
        return `${AnsiColors.dim}${label}${' '.repeat(pad)}${AnsiColors.reset}`
    }
}

export default BaseWindow
