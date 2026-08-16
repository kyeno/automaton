/**
 * Status Bar Widget.
 *
 * Renders a configurable multi-line status bar within its own grid region.
 * Supports left-aligned widgets and right-aligned bracket groups per line.
 * Updates only the status bar rows -- never touches content or input areas.
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

import ConfigService from '../../service/configService.js'
import EventBus from '../../service/eventBus.js'
import StateService from '../../service/stateService.js'

import channels from '../channels.js'

import renderSeparator from './slotWidgets/separatorWidget.js'
import renderState, { subscribe as subscribeState, unsubscribe as unsubscribeState } from './slotWidgets/stateWidget.js'
import renderTemp, { subscribe as subscribeTemp, unsubscribe as unsubscribeTemp } from './slotWidgets/tempWidget.js'
import renderTime from './slotWidgets/timeWidget.js'
import renderTimeOfDay from './slotWidgets/timeOfDayWidget.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RENDERERS = {
    separator: renderSeparator,
    state: renderState,
    temp: renderTemp,
    time: renderTime,
    time_of_day: renderTimeOfDay,
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

/**
 * Renders a two-line status bar at the bottom of the terminal above the input slot.
 * Displays dynamic widgets (time, date, network status, activity indicators)
 * and handles backscroll and narrow-terminal warnings.
 */
class StatusBar {

    #term
    #layout
    #pendingActivity = new Set()
    #activeWindowId = null
    #activeChannelName = ''
    #unsubscribeActivity
    /** Whether the active window is currently backscrolled (showing "-- more --"). */
    #backscrolled = false
    /** Tracks whether the status bar previously showed the narrow warning. */
    #wasNarrow = false

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new StatusBar instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     */
    constructor(term, layout) {
        this.#term = term
        this.#layout = layout

        // Subscribe to window activity events - immediately refresh so indicator appears
        this.#unsubscribeActivity = EventBus.subscribe('window:activity', (windowId) => {
            if (windowId !== this.#activeWindowId) {
                this.#pendingActivity.add(windowId)
                this.refresh()
            }
        })
    }

    /**
     * Initialize the status bar -- wire up event-driven subscriptions.
     * No fixed interval; each widget type subscribes to its own data sources
     * and triggers refresh reactively.
     */
    init() {
        const { lines } = this.#loadConfig()

        // Collect all widgets across every line (left + right sections)
        const tempWidgets = []
        const stateWidgets = []

        for (const line of lines) {
            const left = line.left || []
            const rightFlat = (line.right || []).flat()
            for (const w of [...left, ...rightFlat]) {
                if (w.type === 'temp') tempWidgets.push(w)
                if (w.type === 'state') stateWidgets.push(w)
            }
        }

        // Wire per-widget subscriptions that trigger statusBar.refresh()
        const self = this
        subscribeTemp(tempWidgets, () => self.refresh())
        subscribeState(stateWidgets, () => self.refresh())

        // Initial render
        this.refresh()
    }

    /**
     * Notify the status bar which window is currently focused so that
     * activity for that window is no longer considered "pending".
     * Called by Ui.switchWindow().
     * @param {number} windowId - The numeric window ID (1, 2, 3)
     */
    notifyActiveWindow(windowId) {
        this.#activeWindowId = windowId
        this.#pendingActivity.delete(windowId)
        // Look up the channel name for this window id
        const ch = channels.getByShortcut(windowId)
        this.#activeChannelName = ch ? ch.channel : ''
        // Reset backscroll state on window switch
        this.#backscrolled = false
        // Refresh immediately so indicator appears
        this.refresh()
    }

    /**
     * Update the backscroll state of the active window.
     * When true, shows "-- more --" in the status bar between channel and [Act:].
     * @param {boolean} scrolled - Whether the active window is backscrolled
     */
    notifyBackscrolled(scrolled) {
        if (this.#backscrolled !== !!scrolled) {
            this.#backscrolled = !!scrolled
            this.refresh()
        }
    }

    // -- Public API -------------------------------------------------------

    /**
     * Refresh all status bar lines using BitchX-style Dark Blue Theme rendering.
     */
    refresh() {
        if (!this.#term) return

        const r = this.#layout.getSlot('status')
        if (!r) return

        // Use centralized narrow check -- skip rendering widget details when terminal is too small
        if (this.#layout.isTooNarrow()) {
            if (!this.#wasNarrow) {
                this.#wasNarrow = true
                this.#term.hideCursor(true)
                this.#layout.renderTooNarrowWarning('status')
                this.#term.hideCursor(false)
            }
            return
        }

        // Auto-recover: was narrow but now wide enough again
        if (this.#wasNarrow) {
            this.#wasNarrow = false
        }

        // Save cursor position to prevent it from jumping during input typing
        this.#term.saveCursor()

        const { lines } = this.#loadConfig()
        const terminalWidth = r.width

        for (let i = 0; i < lines.length; i++) {
            const lineCfg = lines[i]
            const leftWidgets = lineCfg.left || []
            const rightGroups = lineCfg.right || []

            const currentRow = r.y + i + 1 // 1-based row number

            // --- Paint full blue background for this line --------------------
            // Fill the entire terminalWidth with spaces over a blue background so
            // there are no gaps between left and right sections, and stale content
            // from longer previous frames is overwritten.
            this.#term.moveTo(1, currentRow)
            this.#term.bgBlue()
            this.#term(' '.repeat(terminalWidth))

            // --- Render left section on top of blue background ---------------
            this.#term.moveTo(1, currentRow)

            // Classic BitchX-style status line opening bracket
            this.#term.bold.cyan('[')

            // Stream left widgets with intelligent color styling
            leftWidgets.forEach((widget) => {
                const renderer = RENDERERS[widget.type]
                if (!renderer) return

                const rawText = renderer(widget)

                if (widget.type === 'separator') {
                    // Delimiters (e.g., | or :): bold cyan
                    this.#term.bold.cyan(rawText)
                }
                else if (widget.type === 'time') {
                    // Clock: bright yellow or white
                    this.#term.bold.yellow(rawText)
                }
                else if (widget.type === 'time_of_day') {
                    // Time-of-day period: same bright yellow as clock
                    this.#term.bold.yellow(rawText)
                }
                else if (widget.type === 'temp') {
                    // Temperature -- label in plain white, value in bold white
                    const tempData = typeof rawText === 'object' ? rawText : { label: '', value: String(rawText) }
                    this.#term.white(tempData.label)
                    this.#term.bold.white(tempData.value)
                }
                else if (widget.type === 'state') {
                    // Service state -- color only the icon, label is always white
                    const { icon, label } = rawText
                    const svcConnected = StateService.get(widget.key)

                    let iconColor
                    if (svcConnected === true) {
                        iconColor = 'green'
                    } else if (svcConnected === false) {
                        iconColor = 'red'
                    } else {
                        iconColor = 'white'
                    }

                    this.#term.bold[iconColor](` ${icon}`)
                    this.#term.white(label ? ` ${label} ` : ' ')
                }
                else {
                    this.#term.white(rawText)
                }
            })

            this.#term.bold.cyan(']')

            // Channel name bracket (BitchX-style): separate brackets, line 0 only
            // e.g.: [time|tod] [#automaton] -- more -- [Act: 2]
            if (i === 0 && this.#activeChannelName) {
                this.#term.bgBlue()
                this.#term(' ')
                this.#term.bold.cyan('[')
                this.#term.bold.white(this.#activeChannelName)
                this.#term.bold.cyan(']')
            }

            // Backscroll indicator: "-- more --" in cyan between channel and [Act:]
            if (i === 0 && this.#backscrolled) {
                this.#term.bgBlue()
                this.#term(' ')
                this.#term.bold.cyan('-- more --')
                this.#term.bgBlue()
                this.#term(' ')
            }

            // Append activity bracket group on line 0 when there is pending activity
            if (i === 0 && this.#pendingActivity.size > 0) {
                const activeIds = [...this.#pendingActivity].sort((a, b) => a - b)
                const idsStr = activeIds.join(',')

                // Space before activity bracket for separation
                this.#term.bgBlue()
                this.#term(' ')
                this.#term.bold.cyan('[')
                this.#term.white(`Act: `)
                this.#term.bold.white(idsStr)
                this.#term.bold.cyan(']')
            }
            // --- Render right-aligned section as single bracket group --------
            // Merges all right groups into one [item | item | item] bracket,
            // e.g.: [[o]MQTT | [o]Redis]
            if (rightGroups.length > 0) {
                const mergedWidgets = rightGroups.flat()
                const rightLineLen = this.#measureRightLineWidth(mergedWidgets)

                // Position so the closing ] lands exactly at column terminalWidth
                const startCol = terminalWidth - rightLineLen + 1

                this.#term.moveTo(startCol, currentRow)
                this.#term.bgBlue()
                this.#renderMergedRightBrackets(mergedWidgets)
            }

            // Clean up any trailing stale content after whatever we just rendered.
            // Cursor is positioned at the end of our content, so eraseLineAfter
            // only clears the tail -- not our widgets.
            this.#term.bgBlue()
            this.#term.eraseLineAfter()
        }

        // Reset styles and restore cursor back to the input prompt
        this.#term.styleReset()
        this.#term.restoreCursor()
    }

    /**
     * Render all right groups merged into a single bracket with pipe separators.
     * Format: [[o]MQTT | [o]Redis]
     * @param {Array} widgets - Flat array of widget configs from all groups
     */
    #renderMergedRightBrackets(widgets) {
        this.#term.bold.cyan('[')

        for (let i = 0; i < widgets.length; i++) {
            const widget = widgets[i]
            const renderer = RENDERERS[widget.type]
            if (!renderer) continue

            // Pipe separator between items from different original groups
            if (i > 0) {
                this.#term.bold.cyan(' | ')
            }

            const rawText = renderer(widget)

            if (widget.type === 'state') {
                const { icon, label } = rawText
                const svcConnected = StateService.get(widget.key)

                let iconColor
                if (svcConnected === true) {
                    iconColor = 'green'
                } else if (svcConnected === false) {
                    iconColor = 'red'
                } else {
                    iconColor = 'white'
                }

                // Compact format inside brackets: no leading space, just "icon" + "label"
                this.#term.bold[iconColor](icon)
                if (label) {
                    this.#term.white(label)
                }
            }
            else {
                this.#term.white(rawText)
            }
        }

        this.#term.bold.cyan(']')
    }

    /**
     * Measure the character width of a merged right bracket line.
     * Format: [icon_label | icon_label | ...]
     * @param {Array} widgets - Flat array of widget configs
     * @returns {number} Total character width including brackets and separators
     */
    #measureRightLineWidth(widgets) {
        let width = 2 // Opening [ and closing ]

        for (let i = 0; i < widgets.length; i++) {
            const widget = widgets[i]
            const renderer = RENDERERS[widget.type]
            if (!renderer) continue

            // Pipe separator between items
            if (i > 0) {
                width += 3 // " | "
            }

            const rawText = renderer(widget)

            if (widget.type === 'state') {
                const { icon, label } = rawText
                width += String(icon).length
                if (label) {
                    width += String(label).length
                }
            }
            else {
                width += String(rawText).length
            }
        }

        return width
    }

    /**
     * Hide the status bar -- clear its rendered lines.
     * Erased rows are clamped to the slot height so extra configured lines can
     * never cause erasure past the status region into the input row.
     */
    hide() {
        if (!this.#term) return

        const r = this.#layout.getSlot('status')
        if (!r) return

        const { lines } = this.#loadConfig()
        // Clamp to the actual slot height -- config may define more lines than the layout allocates
        const rows = Math.min(lines.length, r.height)

        this.#layout.moveToSlot('status')
        for (let i = 0; i < rows; i++) {
            this.#term.eraseLine()
            if (i < rows - 1) {
                this.#term.nextLine()
            }
        }
    }

    /**
     * Destroy this component: unsubscribe from all widget events and window activity.
     */
    destroy() {
        unsubscribeTemp()
        unsubscribeState()
        if (this.#unsubscribeActivity) {
            this.#unsubscribeActivity()
            this.#unsubscribeActivity = null
        }
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Load the status bar configuration from ConfigService.
     * Supports both new structure (lines[].left / lines[].right) and old flat widgets.
     * @returns {{lines: Array}} Parsed configuration with normalized line structure
     */
    #loadConfig() {
        try {
            const cfg = ConfigService.getSection('status_bar')
            if (!cfg) return { lines: [{ left: [], right: [] }, { left: [], right: [] }] }

            // New structure: lines[] with left/right sections
            if (cfg.lines && Array.isArray(cfg.lines)) {
                return { lines: cfg.lines }
            }
            // Fallback for old flat slots structure
            return {
                lines: [
                    { left: cfg.slots || [], right: [] },
                    { left: [], right: [] }
                ]
            }
        } catch {
            return { lines: [{ left: [], right: [] }, { left: [], right: [] }] }
        }
    }
}

export default StatusBar