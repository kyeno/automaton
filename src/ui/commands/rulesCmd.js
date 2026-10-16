/**
 * Rules Command -- drives the rules window's tab focus.
 * Usage: /rules            list the automations the window knows
 *        /rules <name>     focus one automation (only its box is shown)
 *        /rules all        clear the focus and show every automation box
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

/** Window id of the rules window, as declared in the ui.windows config. */
const RULES_WINDOW_ID = 'rules'

/** Argument that clears the tab focus. */
const CLEAR_FOCUS_ARG = 'all'

class RulesCmd extends CommandBase {
    static name = 'rules'
    static description = 'Focus one automation in the rules window: /rules <name> | /rules all'
    static takesArgs = true

    /** Dispatch on the raw argument string: list, focus, or clear focus.
     * @param {string} args - Raw argument string after the command verb */
    async execute(args) {
        const target = String(args ?? '').trim()
        const win = this.#rulesWindow()

        if (!win) {
            this.ctx.print('(Rules window not available)')
            return
        }

        if (target === '') {
            this.#printAutomations(win)
            return
        }

        if (target.toLowerCase() === CLEAR_FOCUS_ARG) {
            win.clearFocus()
            this.ctx.print('Rules window shows every automation box again')
            return
        }

        if (win.setFocus(target) === true) {
            const focused = typeof win.getFocus === 'function' ? win.getFocus() : target
            this.ctx.print(`Rules window focused on "${focused}"`)
            return
        }

        this.ctx.print(`No automation "${target}" is known to the rules window`)
        this.#printAutomations(win)
    }

    /** Tab-completion candidates for /rules arguments: 'all' plus every automation name.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null when none apply */
    completeNextToken(typedTokens) {
        if (typedTokens && typedTokens.length > 0) return null
        const names = [CLEAR_FOCUS_ARG, ...this.#automationNames(null)]
        if (names.length < 2) return null
        return [...new Set(names)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    }

    //  -- Private helpers ----------------------------------------------------

    /** Resolve the rules window instance, switching to it when the command was typed
     * @returns {Object|null} Rules window instance, or null when it is unavailable
     * @private */
    #rulesWindow() {
        const active = this.ctx.activeWindow
        if (this.#isRulesWindow(active)) return active

        if (typeof this.ctx.switchWindow === 'function') {
            this.ctx.switchWindow(RULES_WINDOW_ID)
            const switched = this.ctx.activeWindow
            if (this.#isRulesWindow(switched)) return switched
        }
        return null
    }

    /** Whether a window instance exposes the rules-window tab API.
     * @param {Object|null} win - Window instance to test
     * @returns {boolean} true when the instance is a rules window
     * @private */
    #isRulesWindow(win) {
        return !!win &&
            typeof win.setFocus === 'function' &&
            typeof win.clearFocus === 'function' &&
            typeof win.getAutomationNames === 'function'
    }

    /** Automation names the rules window knows, falling back to the loaded automations.
     * @param {Object|null} win - Rules window instance (null falls back to the container)
     * @returns {Array<string>} Automation names
     * @private */
    #automationNames(win) {
        if (win) {
            try {
                const names = win.getAutomationNames()
                if (Array.isArray(names) && names.length > 0) return names
            } catch {
                //  Fall through to the container view below.
            }
        }

        const container = this.ctx.automationContainer
        if (!container) return []
        if (typeof container.getNames === 'function') return [...container.getNames()]
        if (typeof container.getAll === 'function') {
            return [...container.getAll().keys()].sort((a, b) => a.localeCompare(b))
        }
        return []
    }

    /** Print the automations the rules window can show, and which one is focused.
     * @param {Object} win - Rules window instance
     * @private */
    #printAutomations(win) {
        const names = this.#automationNames(win)
        const focus = typeof win.getFocus === 'function' ? win.getFocus() : null

        if (names.length === 0) {
            this.ctx.print('(no automation calls recorded yet)')
        } else {
            this.ctx.print(`Automations: ${names.join(', ')}`)
        }
        this.ctx.print(focus
            ? `Focused: ${focus} -- /rules all shows every automation box`
            : 'Focus one automation with /rules <name>')
    }
}

export default RulesCmd
