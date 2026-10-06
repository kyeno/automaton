/**
 * Rules Window -- Window 5.
 * Shows the most recent automation rule matches: which automation evaluated.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import AutomationContainer from '../../automation/container/automationContainer.js'
import EventBus from '../../service/eventBus.js'
import { padVisible, colCell, formatTime } from '../../lib/terminal.js'
import AnsiColors from '../../enum/ansiColors.js'
import BaseWindow from './baseWindow.js'

//  Column widths (fixed-width alignment, no tabs)

const TIME_W = 9
const AUTO_W = 24
const RULE_W = 28
const TRIGGER_W = 14
const OUTCOME_W = 7


/** Total match rows the window keeps; oldest rows fall off the top. */
const MAX_TRACKED_MATCHES = 60

/** Refresh interval (ms) -- repaints elapsed times without waiting for a new match. */
const REFRESH_INTERVAL_MS = 5000

//  RulesWindow.

/** Recent rule-match table displayed in the terminal UI. */
class RulesWindow extends BaseWindow {

    /** Newest-first match rows, capped at MAX_TRACKED_MATCHES. */
    #matches = []
    /** Unsubscribe handles for the two EventBus channels. */
    #unsubscribes = []
    /** Periodic repaint timer. */
    #refreshInterval = null
    /** Lines from the last painted frame; used to skip redraws when content is unchanged. */
    #lastRenderedLines = null
    /** Shortcut used for the window:activity status-bar ping. */
    #channelShortcut

    //  -- Initialization ---------------------------------------------------

    /** Create a new RulesWindow instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     * @param {number} channelShortcut - Numeric shortcut from channel config */
    constructor(term, layout, channelShortcut = 5) {
        super('Rules', term, layout, channelShortcut)
        this.#channelShortcut = channelShortcut

        this.#unsubscribes.push(EventBus.subscribe('automation:ruleMatched', (record) => {
            this.#recordMatch(record)
        }))
        this.#unsubscribes.push(EventBus.subscribe('automation:ruleActed', (record) => {
            this.#markActed(record)
        }))
    }

    //  -- Public API -------------------------------------------------------

    /** Show this window, seed the table from the automations' own histories. */
    show() {
        super.show()
        if (this.#matches.length === 0) this.#seedFromAutomations()
        this.refresh()
        this.#startRefreshTimer()
    }

    /** Hide this window and stop the periodic repaint timer. */
    hide() {
        this.#stopRefreshTimer()
        super.hide()
    }

    /** Destroy this window: unsubscribe from events, hide, and clear the buffer. */
    destroy() {
        this.#unsubscribes.forEach((unsub) => {
            if (typeof unsub === 'function') unsub()
        })
        this.#unsubscribes = []
        this.#stopRefreshTimer()
        this.clear()
        this.hide()
    }

    /** Rebuild the table from the tracked matches and push it to the buffer. */
    refresh() {
        const lines = []

        if (this.#matches.length === 0) {
            lines.push(AnsiColors.dim + 'No rule matches recorded yet' + AnsiColors.reset)
        } else {
            lines.push(
                AnsiColors.dim +
                padVisible('Time', TIME_W) +
                padVisible('Automation', AUTO_W) +
                padVisible('Rule', RULE_W) +
                padVisible('Trigger', TRIGGER_W) +
                padVisible('Action', OUTCOME_W) +
                AnsiColors.reset
            )
            for (let i = this.#matches.length - 1; i >= 0; i--) {
                lines.push(this.#renderRow(this.#matches[i]))
            }
        }

        lines.push('')
        lines.push(
            AnsiColors.dim + 'Matches: ' + this.#matches.length + ' | newest last' + AnsiColors.reset
        )

        if (this.#sameLines(this.#lastRenderedLines, lines)) {
            return
        }
        this.#lastRenderedLines = lines

        this.clear()
        lines.forEach((line) => this.print(line))
    }

    //  -- Private Helpers --------------------------------------------------

    /** Record one incoming match row (newest first, capped).
     * @param {Object} record - Match record from the EventBus
     * @private */
    #recordMatch(record) {
        const row = this.#normalize(record)
        if (row === null) return

        this.#matches.unshift(row)
        if (this.#matches.length > MAX_TRACKED_MATCHES) {
            this.#matches.length = MAX_TRACKED_MATCHES
        }

        if (this.isVisible) this.refresh()
        EventBus.emit('window:activity', this.#channelShortcut)
    }

    /** Flip the 'acted' flag on the row an 'automation:ruleActed' event refers to.
     * @param {Object} record - Match record from the EventBus
     * @private */
    #markActed(record) {
        const row = this.#normalize(record)
        if (row === null) return

        const existing = this.#matches.find(
            (item) => item.automation === row.automation && item.rule === row.rule && item.at === row.at
        )
        if (!existing) return

        existing.acted = true
        if (this.isVisible) this.refresh()
        EventBus.emit('window:activity', this.#channelShortcut)
    }

    /** Validate and copy an incoming EventBus record.
     * @param {Object} record - Raw record ({automation, rule, at, trigger, forced, acted})
     * @returns {Object|null} A detached row, or null when the record is unusable
     * @private */
    #normalize(record) {
        if (!record || typeof record !== 'object') return null
        const automation = String(record.automation ?? '').trim()
        const rule = String(record.rule ?? '').trim()
        const at = Number(record.at)
        if (!automation || !rule || !Number.isFinite(at)) return null

        return {
            automation,
            rule,
            at,
            trigger: String(record.trigger ?? '?').trim() || '?',
            forced: record.forced === true,
            acted: record.acted === true,
        }
    }

    /** Seed the table from every automation's own recent-match history.
     * @private */
    #seedFromAutomations() {
        const all = AutomationContainer.getAll() ?? {}
        //  The container exposes a Map; plain-object shape accepted too so a stubbed.
        const instances = (typeof all?.values === 'function') ? [...all.values()] : Object.values(all)
        const seeded = []

        for (const automation of instances) {
            if (typeof automation?.getRecentRuleMatches !== 'function') continue
            for (const record of automation.getRecentRuleMatches()) {
                const row = this.#normalize(record)
                if (row !== null) seeded.push(row)
            }
        }

        seeded.sort((a, b) => b.at - a.at)
        this.#matches = seeded.slice(0, MAX_TRACKED_MATCHES)
    }

    /** Render one match row as a fixed-width line.
     * @param {Object} match - Normalized match row
     * @returns {string} The rendered line
     * @private */
    #renderRow(match) {
        const trigger = match.forced ? match.trigger + '!' : match.trigger

        return padVisible(formatTime(new Date(match.at), true), TIME_W) +
            padVisible(this.#clip(match.automation, AUTO_W), AUTO_W) +
            padVisible(this.#clip(match.rule, RULE_W), RULE_W) +
            padVisible(this.#clip(trigger, TRIGGER_W), TRIGGER_W) +
            colCell(
                match.acted ? 'acted' : 'matched',
                match.acted ? AnsiColors.green : AnsiColors.grey,
                OUTCOME_W,
                'left'
            )
    }

    /** Clip a value to the column width so the table stays aligned.
     * @param {string} value - Plain text to fit
     * @param {number} width - Column width
     * @returns {string} Text no wider than width
     * @private */
    #clip(value, width) {
        const text = String(value ?? '')
        return text.length > width ? text.slice(0, Math.max(0, width - 1)) + '~' : text
    }

    /** Compare two rendered line arrays element-wise for strict equality.
     * @param {string[]|null} previous - Lines from the last painted frame
     * @param {string[]} next - Newly built lines
     * @returns {boolean} true when both frames are identical
     * @private */
    #sameLines(previous, next) {
        if (!previous || previous.length !== next.length) return false
        for (let i = 0; i < next.length; i++) {
            if (previous[i] !== next[i]) return false
        }
        return true
    }

    /** Start the periodic repaint timer.
     * @private */
    #startRefreshTimer() {
        this.#stopRefreshTimer()
        this.#refreshInterval = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS)
    }

    /** Stop the periodic repaint timer.
     * @private */
    #stopRefreshTimer() {
        if (this.#refreshInterval) {
            clearInterval(this.#refreshInterval)
            this.#refreshInterval = null
        }
    }
}

export default RulesWindow

