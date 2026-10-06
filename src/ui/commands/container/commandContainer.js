/**
 * UI Command Container.
 * Manages all slash commands for the terminal UI -- auto-discovers concrete.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'

import Autoloader from '../../../lib/autoloader.js'
import LoggerService from '../../../service/loggerService.js'
import { PROJECT_ROOT } from '../../../lib/projectRoot.js'


/** Path to the UI command implementations directory. */
const COMMANDS_DIR = path.join(PROJECT_ROOT, 'src', 'ui', 'commands')

//  SCommandContainer (singleton)

/** Command repository and dispatcher. */
class SCommandContainer {

    instance

    /** Map of command instances keyed by their static `name` property.
     * @type {Map<string, import('../base/commandBase').default>} */
    #commands = new Map()


    /** Synchronous singleton constructor. @return {this} */
    constructor() {
        if (!SCommandContainer.instance) SCommandContainer.instance = this
        return SCommandContainer.instance
    }

    //  -- Lifecycle --------------------------------------------------------

    /** Initialize the container: auto-discover command classes from src/ui/commands/
     * @param {Object} ctx - Context object injected by Ui containing services and helpers
     * @async */
    async init(ctx) {
        await this.#loadCommands(ctx)
    }

    //  -- Discovery & instantiation ----------------------------------------

    /** Scan `src/ui/commands/` for concrete command classes using Autoloader.
     * @param {Object} ctx - Context object to inject into each command instance
     * @private */
    async #loadCommands(ctx) {
        try {
            const autoloader = new Autoloader()
            const modules = await autoloader.preloadPath(COMMANDS_DIR)

            let loadedCount = 0

            for (const [fileName, moduleExport] of Object.entries(modules)) {
                if (!moduleExport || typeof moduleExport !== 'function') continue

                const Class = moduleExport.default ?? moduleExport
                if (!Class || typeof Class !== 'function') continue

                //  Require a static name property set on the subclass.
                if (!Class.name) continue

                try {
                    const instance = new Class(ctx)
                    const cmdName = String(Class.name).toLowerCase().replace(/^\/+/, '')

                    this.#commands.set(cmdName, instance)

                    //  Register aliases pointing to same instance.
                    const aliases = Class.aliases || []
                    for (const alias of aliases) {
                        const key = String(alias).toLowerCase().replace(/^\/+/, '')
                        this.#commands.set(key, instance)
                    }

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
    //  -- Public API -------------------------------------------------------

    /** Two-phase dispatch entry point. Called by Ui with the raw verb string.
     * @param {string} rawInput - Verb without leading slash, may include args (e.g., "win 2")
     * @returns {Promise<boolean>} True if command was found and executed, false otherwise */
    async handle(rawInput) {
        const trimmed = rawInput.trim()
        if (!trimmed) return false

        //  --- Phase 1: exact match -----------------------------------------
        const cmd = this.#commands.get(trimmed.toLowerCase())
        if (cmd) {
            try { await cmd.execute('') } catch (error) {
                LoggerService.warn(`Command "${trimmed}" failed: ${error.message}`, 'CommandContainer')
            }
            return true
        }

        //  --- Phase 2: prefix match (verb + ' ' + args) --------------------
        for (const [name, instance] of this.#commands.entries()) {
            const prefix = `${name} `
            if (trimmed.toLowerCase().startsWith(prefix)) {
                const args = trimmed.slice(prefix.length)
                try { await instance.execute(args) } catch (error) {
                    LoggerService.warn(`Command "${name}" failed: ${error.message}`, 'CommandContainer')
                }
                return true
            }
        }

        LoggerService.warn(`Unknown command: "${trimmed}"`, 'CommandContainer')
        return false
    }

    /** Execute a registered command by its verb name.
     * @param {string} verb - Command verb without leading slash (e.g., 'clear', 'debug-state')
     * @param {string} args - Raw argument string after the verb
     * @returns {Promise<boolean>} True if command was found and executed, false if not found */
    async execute(verb, args = '') {
        const input = args ? `${verb} ${args}` : verb
        return this.handle(input)
    }

    /** Get all registered commands as an array of info objects for help generation.
     * @returns {Array<Object>} Array of {name, description, takesArgs, aliases} */
    getAllInfo() {
        //  Deduplicate: only emit one entry per unique instance (primary name)
        const seen = new Set()
        const result = []

        for (const [name, instance] of this.#commands.entries()) {
            if (seen.has(instance)) continue
            seen.add(instance)

            const Class = instance.constructor
            result.push({
                name,
                description: Class.description || '',
                takesArgs: Boolean(Class.takesArgs),
                aliases: (Class.aliases && Class.aliases.length > 0)
                    ? [...Class.aliases].sort()
                    : [],
            })
        }
        //  Sort alphabetically by name for consistent /help output.
        result.sort((a, b) => a.name.localeCompare(b.name))
        return result
    }

    /** Look up a single command instance by verb name or alias.
     * @param {string} verb - Command verb without leading slash
     * @returns {import('../base/commandBase').default|null} Command instance or null if not found */
    getCommand(verb) {
        return this.#commands.get(verb.toLowerCase()) ?? null
    }
}

//  Singletonize and export to Node.js.
const CommandContainer = new SCommandContainer()
Object.freeze(CommandContainer)
export default CommandContainer
