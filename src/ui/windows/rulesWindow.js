/**
 * Rules Window -- Window 5.
 * Tab/box view of the rule-based automations: a tab bar of automation names, one box per
 * automation, and inside each box a compact indented log of its last automation calls --
 * timestamp, trigger, outcome and the rules the call fired.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import AutomationContainer from '../../automation/container/automationContainer.js'
import EventBus from '../../service/eventBus.js'
import { padVisible, visibleLen, colCell, formatTime } from '../../lib/terminal.js'
import AnsiColors from '../../enum/ansiColors.js'
import BaseWindow from './baseWindow.js'

//  Layout constants (fixed-width cells, ASCII frame -- no box-drawing glyphs)

/** Automation calls kept and shown per automation box; the oldest falls off. */
const MAX_CALLS_PER_AUTOMATION = 3

/** Refresh interval (ms) -- repaints elapsed times without waiting for a new call. */
const REFRESH_INTERVAL_MS = 5000

/** Width of the timestamp cell in a call log line. */
const TIME_W = 10

/** Width of the trigger cell in a call log line. */
const TRIGGER_W = 12

/** Width of the outcome cell in a call log line. */
const OUTCOME_W = 11

/** Spaces a call log line is indented by inside its box. */
const LOG_INDENT = 3

/** Narrowest box interior the frame is drawn at; wider terminals get the full slot. */
const MIN_INNER_WIDTH = 40

/** Longest automation name shown in a tab label before clipping. */
const TAB_NAME_W = 18

/** Outcome -> color map for the call log. */
const OUTCOME_COLORS = {
    acted: AnsiColors.green,
    noop: AnsiColors.grey,
    'no-match': AnsiColors.grey,
    suppressed: AnsiColors.yellow,
    skipped: AnsiColors.yellow,
    blocked: AnsiColors.red,
    running: AnsiColors.cyan,
}

//  RulesWindow.

/** Automation call boxes displayed in the terminal UI. */
class RulesWindow extends BaseWindow {

    /** Automation name -> { name, calls } entry; calls are newest first. */
    #automations = new Map()
    /** Focused tab: when set, only this automation's box is rendered. */
    #focus = null
    /** Unsubscribe handles for the EventBus channels. */
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

        this.#unsubscribes.push(EventBus.subscribe('automation:runCompleted', (record) => {
            this.#recordCall(record)
        }))
        this.#unsubscribes.push(EventBus.subscribe('automation:ruleMatched', (record) => {
            this.#recordMatch(record)
        }))
        this.#unsubscribes.push(EventBus.subscribe('automation:ruleActed', (record) => {
            this.#markActed(record)
        }))
    }

    //  -- Public API -------------------------------------------------------

    /** Show this window, seeding the boxes from the automations' own call histories. */
    show() {
        super.show()
        if (this.#automations.size === 0) this.#seedFromAutomations()
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

    /** Focus one automation tab so only its box is rendered.
     * @param {string} name - Automation name to focus (matched case-insensitively)
     * @returns {boolean} true when the automation is known and now focused */
    setFocus(name) {
        const key = this.#resolveName(String(name ?? ''))
        if (!key) return false
        this.#focus = key
        this.refresh()
        return true
    }

    /** Drop the tab focus so every automation box is rendered again. */
    clearFocus() {
        this.#focus = null
        this.refresh()
    }

    /** Currently focused automation tab.
     * @returns {string|null} Focused automation name, null when every box is shown */
    getFocus() { return this.#focus }

    /** Names of every automation the window knows about, alphabetically.
     * @returns {Array<string>} Automation names */
    getAutomationNames() {
        return [...this.#automations.keys()].sort((a, b) => a.localeCompare(b))
    }

    /** Rebuild the tab bar and the automation boxes and push them to the buffer. */
    refresh() {
        const innerWidth = this.#frameInnerWidth()
        const names = this.#visibleNames()
        const lines = []

        lines.push(this.#renderTitle(names))
        lines.push(this.#renderTabBar(names))

        if (names.length === 0) {
            lines.push('')
            lines.push(AnsiColors.dim + 'No automation calls recorded yet' + AnsiColors.reset)
        } else {
            for (const name of names) {
                lines.push('')
                this.#renderBox(this.#automations.get(name), innerWidth, lines)
            }
        }

        lines.push('')
        lines.push(this.#renderFooter(names))

        if (this.#sameLines(this.#lastRenderedLines, lines)) {
            return
        }
        this.#lastRenderedLines = lines

        //  Preformatted: the box frame and the indented call log are significant
        //  whitespace, which the plain print() path word-wraps and collapses.
        this.clear()
        this.printPreformatted(lines.join('\n'))
    }

    //  -- Rendering --------------------------------------------------------

    /** Width of a box interior that fits the main slot (frame borders included).
     * @returns {number} Interior width in visible characters
     * @private */
    #frameInnerWidth() {
        const slot = this.getLayoutSlot('main')
        const slotWidth = (slot && Number.isFinite(slot.width)) ? slot.width : MIN_INNER_WIDTH + 4
        return Math.max(MIN_INNER_WIDTH, slotWidth - 4)
    }

    /** Automation names to render: the focused one, or every known one.
     * @returns {Array<string>} Names to render, alphabetically
     * @private */
    #visibleNames() {
        const names = [...this.#automations.keys()].sort((a, b) => a.localeCompare(b))
        if (this.#focus !== null && names.includes(this.#focus)) return [this.#focus]
        return names
    }

    /** Render the window title line.
     * @param {Array<string>} names - Automation names being rendered
     * @returns {string} Title line
     * @private */
    #renderTitle(names) {
        return AnsiColors.bold + 'Rules' + AnsiColors.reset +
            AnsiColors.dim + ' - automations: ' + this.#automations.size +
            ' | shown: ' + names.length +
            ' | calls each: ' + MAX_CALLS_PER_AUTOMATION +
            ' | ' + formatTime(new Date()) + AnsiColors.reset
    }

    /** Render the tab bar: one bracketed label per automation, focused one starred.
     * @param {Array<string>} names - Automation names being rendered
     * @returns {string} Tab bar line
     * @private */
    #renderTabBar(names) {
        const width = this.#frameInnerWidth() + 4
        const tabs = []
        let used = 0

        for (const name of names) {
            const tab = '[' + this.#clip(name, TAB_NAME_W) + (name === this.#focus ? '*' : '') + ']'
            if (tabs.length > 0 && used + 1 + visibleLen(tab) > width) {
                tabs.push('...')
                break
            }
            tabs.push(tab)
            used += visibleLen(tab) + 1
        }

        return AnsiColors.cyan + (tabs.length > 0 ? tabs.join(' ') : '[none]') + AnsiColors.reset
    }


    /** Render one automation box: frame, header, and its indented call log.
     * @param {{name: string, calls: Array<Object>}|undefined} entry - Automation entry to render
     * @param {number} innerWidth - Box interior width in visible characters
     * @param {Array<string>} lines - Output array the box lines are appended to
     * @private */
    #renderBox(entry, innerWidth, lines) {
        if (!entry) return
        const calls = entry.calls
        const rule = AnsiColors.grey + '+' + '-'.repeat(innerWidth) + '+' + AnsiColors.reset
        lines.push(rule)

        const label = 'last ' + calls.length + ' call' + (calls.length === 1 ? '' : 's')
        const nameWidth = Math.max(1, innerWidth - visibleLen(label))
        const header = padVisible(this.#clip(entry.name, nameWidth), nameWidth) + label
        lines.push('| ' + padVisible(header, innerWidth) + ' |')

        //  Oldest call first: the newest call sits at the bottom, like a log tail.
        for (let i = calls.length - 1; i >= 0; i--) {
            lines.push('| ' + padVisible(this.#renderCallLine(calls[i], innerWidth), innerWidth) + ' |')
        }

        lines.push(rule)
    }

    /** Render one indented call log line: time, trigger, outcome, and rules fired.
     * @param {Object} call - Normalized call record
     * @param {number} innerWidth - Box interior width in visible characters
     * @returns {string} The rendered log line
     * @private */
    #renderCallLine(call, innerWidth) {
        const indent = ' '.repeat(LOG_INDENT)
        const time = padVisible(formatTime(new Date(call.at), true), TIME_W)
        const trigger = padVisible(this.#clip(call.forced ? call.trigger + '!' : call.trigger, TRIGGER_W), TRIGGER_W)
        const color = OUTCOME_COLORS[call.outcome] ?? AnsiColors.grey
        const outcome = colCell(this.#clip(call.outcome, OUTCOME_W), color, OUTCOME_W)
        const tailWidth = Math.max(
            1,
            innerWidth - LOG_INDENT - TIME_W - TRIGGER_W - OUTCOME_W - 4
        )

        return indent + time + ' ' + trigger + ' ' + outcome + ' ' +
            AnsiColors.dim + this.#clip(this.#callTail(call), tailWidth) + AnsiColors.reset
    }

    /** Text shown after the outcome: the rules a call fired, else why it did nothing.
     * @param {Object} call - Normalized call record
     * @returns {string} Tail text for the call log line
     * @private */
    #callTail(call) {
        if (Array.isArray(call.rules) && call.rules.length > 0) return call.rules.join(', ')
        if (call.reason) return call.reason
        return '-'
    }

    /** Render the summary footer line.
     * @param {Array<string>} names - Automation names being rendered
     * @returns {string} Footer line
     * @private */
    #renderFooter(names) {
        let calls = 0
        for (const name of names) {
            const entry = this.#automations.get(name)
            if (entry) calls += entry.calls.length
        }
        const hint = this.#focus
            ? 'focused: ' + this.#focus + ' | /rules all shows every automation'
            : '/rules <name> focuses one automation'

        return AnsiColors.dim + 'Boxes: ' + names.length + ' | calls: ' + calls +
            ' | newest last | ' + hint + AnsiColors.reset
    }


    //  -- Data Recording ---------------------------------------------------

    /** Record one finished automation call on `automation:runCompleted`.
     * @param {Object} record - Call record ({automation, run, at, trigger, forced, outcome, reason, rules})
     * @private */
    #recordCall(record) {
        const call = this.#normalizeCall(record)
        if (call === null) return

        const entry = this.#entryFor(call.automation)
        const existing = (call.run !== null)
            ? entry.calls.find((item) => item.run === call.run)
            : null

        if (existing) {
            Object.assign(existing, call)
        } else {
            entry.calls.unshift(call)
            if (entry.calls.length > MAX_CALLS_PER_AUTOMATION) {
                entry.calls.length = MAX_CALLS_PER_AUTOMATION
            }
        }

        this.#ping()
    }

    /** Fold a rule match into the call that fired it, creating a call line when the run
     * @param {Object} record - Match record ({automation, rule, at, trigger, forced, acted, run})
     * @private */
    #recordMatch(record) {
        const match = this.#normalizeMatch(record)
        if (match === null) return

        const entry = this.#entryFor(match.automation)
        const call = entry.calls.find((item) => this.#sameCall(item, match))

        if (call) {
            if (!call.rules.includes(match.rule)) call.rules.push(match.rule)
            if (match.acted && call.outcome !== 'acted') call.outcome = 'acted'
            this.#ping()
            return
        }

        //  No run record for this match -- an automation that predates run recording,
        //  or a match whose run event has not arrived yet. Show it as a call of its own.
        entry.calls.unshift({
            automation: match.automation,
            run: match.run,
            at: match.at,
            trigger: match.trigger,
            forced: match.forced,
            outcome: match.acted ? 'acted' : 'noop',
            reason: '',
            rules: [match.rule],
        })
        if (entry.calls.length > MAX_CALLS_PER_AUTOMATION) {
            entry.calls.length = MAX_CALLS_PER_AUTOMATION
        }
        this.#ping()
    }

    /** Flip a call's outcome to 'acted' when its rule-acted event arrives.
     * @param {Object} record - Match record ({automation, rule, at, trigger, forced, acted, run})
     * @private */
    #markActed(record) {
        const match = this.#normalizeMatch(record)
        if (match === null) return

        const entry = this.#automations.get(match.automation)
        if (!entry) return

        const call = entry.calls.find((item) => this.#sameCall(item, match))
        if (!call) return

        call.outcome = 'acted'
        if (match.rule && !call.rules.includes(match.rule)) call.rules.push(match.rule)
        this.#ping()
    }

    /** Validate and copy an incoming call record.
     * @param {Object} record - Raw record from the EventBus
     * @returns {Object|null} A detached call row, or null when the record is unusable
     * @private */
    #normalizeCall(record) {
        if (!record || typeof record !== 'object') return null
        const automation = String(record.automation ?? '').trim()
        const at = Number(record.at)
        const outcome = String(record.outcome ?? '').trim()
        if (!automation || !Number.isFinite(at) || !outcome) return null

        return {
            automation,
            run: this.#runId(record.run),
            at,
            trigger: String(record.trigger ?? '?').trim() || '?',
            forced: record.forced === true,
            outcome,
            reason: String(record.reason ?? '').trim(),
            rules: Array.isArray(record.rules)
                ? record.rules.filter((rule) => typeof rule === 'string' && rule !== '')
                : [],
        }
    }

    /** Validate and copy an incoming rule-match record.
     * @param {Object} record - Raw record ({automation, rule, at, trigger, forced, acted, run})
     * @returns {Object|null} A detached match row, or null when the record is unusable
     * @private */
    #normalizeMatch(record) {
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
            run: this.#runId(record.run),
        }
    }

    /** Read a run id out of a raw record: absent, null, or non-numeric all mean "none".
     * @param {*} raw - Raw run field from the EventBus record
     * @returns {number|null} Run id, or null when the record carries none
     * @private */
    #runId(raw) {
        if (raw === null || raw === undefined || raw === '') return null
        const value = Number(raw)
        return Number.isFinite(value) ? value : null
    }

    /** Decide whether a match belongs to a call row: run ids when both have them,
     * @param {Object} call - Call row being matched against
     * @param {Object} match - Normalized match row
     * @returns {boolean} true when the match belongs to this call row
     * @private */
    #sameCall(call, match) {
        if (call.run !== null && match.run !== null) return call.run === match.run
        return call.at === match.at
    }

    /** Fetch (or create) the box entry for one automation.
     * @param {string} name - Automation name
     * @returns {{name: string, calls: Array<Object>}} The entry for this automation
     * @private */
    #entryFor(name) {
        let entry = this.#automations.get(name)
        if (!entry) {
            entry = { name, calls: [] }
            this.#automations.set(name, entry)
        }
        return entry
    }

    /** Resolve a typed automation name to the stored one, ignoring letter case.
     * @param {string} raw - Name as typed by the user
     * @returns {string|null} Known automation name, or null when none matches
     * @private */
    #resolveName(raw) {
        const typed = String(raw ?? '').trim()
        if (!typed) return null
        if (this.#automations.has(typed)) return typed
        const lower = typed.toLowerCase()
        for (const name of this.#automations.keys()) {
            if (name.toLowerCase() === lower) return name
        }
        return null
    }


    //  -- Seeding -----------------------------------------------------------

    /** Seed the boxes from every automation's own call history, falling back to its
     * @private */
    #seedFromAutomations() {
        const all = AutomationContainer.getAll() ?? {}
        //  The container exposes a Map; plain-object shape accepted too so a stubbed
        const instances = (typeof all?.values === 'function') ? [...all.values()] : Object.values(all)

        for (const automation of instances) {
            const name = String(automation?.name ?? '').trim()
            if (!name) continue
            const entry = this.#entryFor(name)

            if (typeof automation.getRecentAutomationCalls === 'function') {
                for (const record of automation.getRecentAutomationCalls()) {
                    const call = this.#normalizeCall(record)
                    if (call !== null) entry.calls.push(call)
                }
                continue
            }

            if (typeof automation.getRecentRuleMatches !== 'function') continue
            for (const record of automation.getRecentRuleMatches()) {
                const match = this.#normalizeMatch(record)
                if (match !== null) this.#seedMatch(entry, match)
            }
        }

        for (const entry of this.#automations.values()) {
            entry.calls.sort((a, b) => b.at - a.at)
            if (entry.calls.length > MAX_CALLS_PER_AUTOMATION) {
                entry.calls.length = MAX_CALLS_PER_AUTOMATION
            }
        }
    }

    /** Group one seeded rule match under its call (by run id, else by timestamp).
     * @param {{name: string, calls: Array<Object>}} entry - Box entry being seeded
     * @param {Object} match - Normalized match row
     * @private */
    #seedMatch(entry, match) {
        const key = (match.run !== null) ? 'run-' + match.run : 'at-' + match.at
        const existing = entry.calls.find((item) => item.groupKey === key)

        if (existing) {
            if (!existing.rules.includes(match.rule)) existing.rules.push(match.rule)
            if (match.acted) existing.outcome = 'acted'
            return
        }

        entry.calls.push({
            automation: entry.name,
            run: match.run,
            at: match.at,
            trigger: match.trigger,
            forced: match.forced,
            outcome: match.acted ? 'acted' : 'noop',
            reason: '',
            rules: [match.rule],
            groupKey: key,
        })
    }

    //  -- Shared Helpers ---------------------------------------------------

    /** Repaint when visible and ping the status bar.
     * @private */
    #ping() {
        if (this.isVisible) this.refresh()
        EventBus.emit('window:activity', this.#channelShortcut)
    }

    /** Clip a value to a width so the boxes stay aligned.
     * @param {string} value - Plain text to fit
     * @param {number} width - Maximum visible width
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

