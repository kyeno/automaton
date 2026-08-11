/**
 * Command Router -- delegates slash commands between built-in handlers and pluggable container.
 *
 * Keeps Ui.#handleCommand clean by encapsulating the dispatch logic for
 * both hardcoded lifecycle commands (/quit) and auto-discovered debug commands.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import LoggerService from '../service/loggerService.js'
import StateService from '../service/stateService.js'
import channels from './channels.js'
import CommandContainer from './commands/container/commandContainer.js'

// ---------------------------------------------------------------------------
// Built-in command handlers (lifecycle / structural operations)
// ---------------------------------------------------------------------------

/**
 * Handle window switching shortcuts: /1, /2, /3...
 * @param {string} verb - The numeric shortcut string
 * @param {Object} uiRef - Reference to Ui instance for switchWindow() call
 * @returns {boolean} True if handled
 */
function handleShortcut(verb, uiRef) {
    const allChannels = channels.getAll()
    const ch = allChannels.find(c => String(c.shortcut) === verb)
    if (!ch) return false

    uiRef.switchWindow(ch.id)
    return true
}

/**
 * Handle quit/exit/q commands.
 * @param {string} verb - Command verb
 * @param {Object} uiRef - Reference to Ui instance for shutdown() call
 * @returns {boolean} True if handled
 */
function handleQuit(verb, uiRef) {
    if (['quit', 'exit', 'q'].includes(verb)) {
        uiRef.shutdown()
        return true
    }
    return false
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Route a parsed slash-command verb+args to the appropriate handler.
 * Called by Ui.#handleCommand after parsing mode and extracting verb.
 *
 * Priority order:
 *   1. Window shortcuts (/1, /2, ...)
 *   2. Quit/shutdown (/quit, /exit, /q)
 *   3. Pluggable command container (everything else)
 *
 * @param {string} verb - Command verb without leading slash
 * @param {string} arg - Raw argument string after the verb
 * @param {Object} uiRef - Reference to Ui instance
 * @returns {Promise<boolean>} True if command was handled
 */
export async function routeCommand(verb, arg, uiRef) {
    // Built-in window shortcuts take priority
    if (handleShortcut(verb, uiRef)) return true

    // Built-in quit commands
    if (handleQuit(verb, uiRef)) return true

    // Delegate everything else to pluggable command container
    try {
        const executed = await CommandContainer.execute(verb, arg)
        if (executed) return true
    } catch (error) {
        LoggerService.error(`Error executing command "/${verb}": ${error.message}`, 'UI')
    }

    return false
}
