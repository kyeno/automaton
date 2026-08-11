/**
 * UI Command Container.
 *
 * Manages all slash commands for the terminal UI -- auto-discovers concrete
 * command classes from `src/ui/commands/`, instantiates them, initializes them
 * with a shared context object, and provides a registry for lookup and execution.
 *
 * Directory layout:
 *   src/ui/commands/base/         -- abstract CommandBase (never loaded here)
 *   src/ui/commands/container/    -- this file
 *   src/ui/commands/*.Cmd.js      -- concrete commands (auto-discovered)
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'

import Autoloader from '../../../lib/autoloader.js'
import LoggerService from '../../../service/loggerService.js'
import { PROJECT_ROOT } from '../../../lib/projectRoot.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the UI command implementations directory. */
const COMMANDS_DIR = path.join(PROJECT_ROOT, 'src', 'ui', 'commands')

// ---------------------------------------------------------------------------
// SCommandContainer (singleton)
// ---------------------------------------------------------------------------

/**
 * Command repository and dispatcher.
 *
 * Auto-discovers concrete command implementations in `src/ui/commands/`,
 * instantiates each one with a shared context object, and maintains a name-indexed
 * map so that Ui.#handleCommand can look up or trigger commands by verb.
 */
class SCommandContainer {

    instance

    /**
     * Map of command instances keyed by their static `name` property.
     * @type {Map<string, import('../base/commandBase').default>}
     */
    #commands = new Map()

    // -- Singleton --------------------------------------------------------

    /** Synchronous singleton constructor. @return {this} */
    constructor() {
        if (!SCommandContainer.instance) SCommandContainer.instance = this
        return SCommandContainer.instance
    }

    // -- Lifecycle --------------------------------------------------------

    /**
     * Initialize the container: auto-discover command classes from src/ui/commands/,
     * instantiate them with the provided context, and register them.
     *
     * @param {Object} ctx - Context object injected by Ui containing services and helpers
     * @async
     */
    async init(ctx) {
        await this.#loadCommands(ctx)
    }

    // -- Discovery & instantiation ----------------------------------------

    /**
     * Scan `src/ui/commands/` for concrete command classes using Autoloader.
     * Only loads `.js` files directly in the directory (skips base/ and container/ subdirs).
     * Each discovered class is instantiated with the shared context and registered
     * under its static `name` property.
     *
     * @param {Object} ctx - Context object to inject into each command instance
     * @private
     */
    async #loadCommands(ctx) {
        try {
            const autoloader = new Autoloader()
            const modules = await autoloader.preloadPath(COMMANDS_DIR)

            let loadedCount = 0

            for (const [fileName, moduleExport] of Object.entries(modules)) {
                if (!moduleExport || typeof moduleExport !== 'function') continue

                const Class = moduleExport.default ?? moduleExport
                if (!Class || typeof Class !== 'function') continue

                // Require a static name property set on the subclass
                if (!Class.name) continue

                try {
                    const instance = new Class(ctx)
                    const cmdName = String(Class.name).toLowerCase().replace(/^\/+/, '')

                    this.#commands.set(cmdName, instance)
                    loadedCount++
                } catch (error) {
                    LoggerService.error(
                        `Failed to instantiate command from "${fileName}": ${error.message}`,
                        'CommandContainer'
                    )
                }
            }

            LoggerService.info(
                `${loadedCount} UI command(s) loaded`,
                'CommandContainer'
            )
        } catch (error) {
            LoggerService.warn(
                `Failed to load UI commands directory: ${error.message}`,
                'CommandContainer'
            )
        }
    }
    // -- Public API -------------------------------------------------------

    /**
     * Execute a registered command by its verb name.
     * Called by Ui.#handleCommand when the verb is not handled by built-in logic.
     *
     * @param {string} verb - Command verb without leading slash (e.g., 'clear', 'debug-state')
     * @param {string} args - Raw argument string after the verb
     * @returns {Promise<boolean>} True if command was found and executed, false if not found
     */
    async execute(verb, args = '') {
        const cmd = this.#commands.get(verb.toLowerCase())
        if (!cmd) return false

        try {
            await cmd.execute(args)
        } catch (error) {
            LoggerService.error(
                `Error executing command "/${verb}": ${error.message}`,
                'CommandContainer'
            )
        }
        return true
    }

    /**
     * Get all registered commands as an array of info objects for help generation.
     * Each entry contains the command name and description.
     *
     * @returns {Array<Object>} Array of {name: string, description: string}
     */
    getAllInfo() {
        const result = []
        for (const [name, instance] of this.#commands.entries()) {
            const Class = instance.constructor
            result.push({
                name,
                description: Class.description || ''
            })
        }
        // Sort alphabetically by name for consistent /help output
        result.sort((a, b) => a.name.localeCompare(b.name))
        return result
    }

    /**
     * Look up a single command instance by verb name.
     * Useful for external code that needs to inspect or trigger a specific command.
     *
     * @param {string} verb - Command verb without leading slash
     * @returns {import('../base/commandBase').default|null} Command instance or null if not found
     */
    getCommand(verb) {
        return this.#commands.get(verb.toLowerCase()) ?? null
    }
}

// Singletonize and export to Node.js.
const CommandContainer = new SCommandContainer()
Object.freeze(CommandContainer)
export default CommandContainer
