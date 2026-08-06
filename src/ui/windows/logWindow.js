/**
 * Log Window -- Window 1.
 *
 * Displays live log entries piped from Winston via a custom transport.
 * Extends BaseWindow for consistent buffering and rendering.
 *
 * Dependencies: receives `term` and `layout` via constructor (passed to BaseWindow).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import Transport from 'winston-transport'
import EventBus from '../../service/eventBus.js'
import { tsPrefix } from '../../lib/terminal.js'
import BaseWindow from './baseWindow.js'

// ---------------------------------------------------------------------------
// UiLogTransport -- Winston transport that pushes entries to the log window
// ---------------------------------------------------------------------------

// Fixed width for log level labels -- ensures right brackets align on fixed-width fonts.
// Current levels: [DEBUG](7), [INFO](6), [WARN](6), [ERROR](7), [CRIT](6), [TRACE](7)
// Using 8 to give headroom for future longer levels while keeping alignment stable.
const MAX_LEVEL_WIDTH = 8

/**
 * Custom Winston transport that formats log entries and pushes them
 * to the LogWindow via an `onEntry` callback. Accepts all levels (debug
 * through error) so the terminal UI displays every log message.
 */
class UiLogTransport extends Transport {

    #onEntry
    #channelShortcut

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new UiLogTransport instance.
     * @param {{onEntry: function(string): void, channelShortcut: number}} options - Configuration object
     * @param {function(string): void} options.onEntry - Callback invoked with formatted log lines
     * @param {number} options.channelShortcut - Numeric shortcut from channel config for EventBus activity
     */
    constructor({ onEntry, channelShortcut = 1 } = {}) {
        // Accept ALL levels (debug, info, warn, error) so the log window shows everything
        super({ level: 'debug' })
        this.#onEntry = onEntry
        this.#channelShortcut = channelShortcut
    }

    // -- Winston Transport Interface --------------------------------------

    /**
     * Called by Winston for each log entry. Formats the line and passes it
     * to the onEntry callback asynchronously. Also emits window:activity(1)
     * so the status bar shows pending activity when LogWindow is not focused.
     * @param {object} info - Winston log info object
     * @param {function} callback - Winston completion callback
     */
    log(info, callback) {
        setImmediate(() => {
            const line = this.#formatLogLine(info)
            if (this.#onEntry && line) {
                this.#onEntry(line)
            }
            // Emit activity using the configured channel shortcut
            EventBus.emit('window:activity', this.#channelShortcut)
            callback()
        })
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Format a Winston log info object into a colored terminal-friendly string.
     * Log levels use fixed left-padding (MAX_LEVEL_WIDTH) so right brackets align
     * consistently on fixed-width fonts. A trailing ANSI reset prevents color bleeding.
     * Timestamps respect the global time_format setting from I18nLoader.
     *
     * @param {object} info - Winston log info containing level, message, context, timestamp
     * @returns {string} Formatted log line with ANSI color codes
     * @private
     */
    #formatLogLine(info) {
        const { level, message, context, timestamp } = info
        // tsPrefix handles brackets, dim coloring, and time_format -- unified with aiWindow.
        const time = timestamp ? tsPrefix(timestamp) : ''

        const levelLabel = `[${level.toUpperCase()}]`
        // Fixed left-padding using NBSP (\u00A0) so wrapAnsi doesn't split on these spaces.
        // Regular spaces would be eaten by word-wrapping in BaseWindow.#executeRender().
        const padding = '\u00A0'.repeat(MAX_LEVEL_WIDTH - levelLabel.length)

        const levelColors = {
            error: '\x1b[31m',   // red
            warn: '\x1b[33m',    // yellow
            info: '\x1b[36m',    // cyan
            debug: '\x1b[90m',   // dim gray
        }
        const reset = '\x1b[0m'      // full reset (clears color + bold)
        const bold = '\x1b[1m'
        const contextColor = '\x1b[97m'  // bright white for namespace/context
        const color = levelColors[level] || reset

        // Context gets bold emphasis (like IRC nick/channel in BitchX), log level does not
        const ctx = context ? `${contextColor}${bold}[${context}]${reset} ` : ''
        // Trailing reset ensures color never bleeds into the prompt area
        return `${time} ${padding}${color}${levelLabel}${reset} ${ctx}${message}${reset}`
    }

}

// ---------------------------------------------------------------------------
// LogWindow
// ---------------------------------------------------------------------------

/**
 * Live log display window powered by a Winston transport.
 * Receives formatted log lines from UiLogTransport and renders them
 * in the terminal's main slot with proper buffering and scroll support.
 */
class LogWindow extends BaseWindow {

    #transport
    #channelShortcut

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new LogWindow instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     * @param {number} channelShortcut - Numeric shortcut from channel config
     */
    constructor(term, layout, channelShortcut = 1) {
        super('Logs', term, layout, channelShortcut)
        this.#channelShortcut = channelShortcut
    }

    // -- Public API -------------------------------------------------------

    /**
     * Create and return the Winston transport for this window.
     * Lazily initializes the transport on first call.
     * @returns {UiLogTransport}
     */
    getTransport() {
        if (!this.#transport) {
            this.#transport = new UiLogTransport({
                onEntry: (line) => this.print(line),
                channelShortcut: this.#channelShortcut,
            })
        }
        return this.#transport
    }

    /**
     * Destroy this window: hide it and clear the buffer.
     */
    destroy() {
        this.hide()
        this.clear()
    }
}

export default LogWindow
export { UiLogTransport }
