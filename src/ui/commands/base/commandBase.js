/**
 * Base UI Command Class.
 *
 * Abstract base class for all slash commands registered with the UI command
 * container. Subclasses must override `static name`, `static description`,
 * and `async execute(args)`.
 *
 * Commands receive a context object (`this.ctx`) at construction time that
 * provides access to services, the active window, and helper methods.
 *
 * Directory layout:
 *   src/ui/commands/base/         -- this file (abstract base)
 *   src/ui/commands/container/    -- CommandContainer (autoloader + dispatcher)
 *   src/ui/commands/*.Cmd.js      -- concrete commands (auto-discovered)
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

// ---------------------------------------------------------------------------
// CommandBase
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all UI slash commands.
 *
 * Each subclass represents one slash command (e.g., /clear, /status, /debug-state).
 * The static `name` property is used as the command verb registered in the container.
 * Subclasses must override `execute()` with their logic.
 */
class CommandBase {
    /**
     * Command verb name without leading slash. Used for registration and dispatching.
     * Subclasses MUST override this.
     * @type {string}
     */
    static name = null

    /**
     * One-line description shown in /help output.
     * Subclasses SHOULD override this.
     * @type {string}
     */
    static description = ''

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new command instance.
     * Injects context object providing access to services and helpers.
     *
     * @param {Object} ctx - Context object from Ui containing:
     *   - print(...args): Print text to active window
     *   - activeWindow: BaseWindow | null getter for current active window
     *   - deviceContainer: DeviceContainer singleton
     *   - stateService: StateService singleton
     *   - automationContainer: AutomationContainer singleton
     *   - interactionContainer: InteractionContainer singleton
     *   - logger: LoggerService singleton
     *   - shutdown(): Function to exit the application
     */
    constructor(ctx) {
        if (this.constructor === CommandBase) {
            throw new Error('CommandBase is abstract and cannot be instantiated directly')
        }
        this.ctx = ctx ?? {}
    }

    // -- Public API -------------------------------------------------------

    /**
     * Execute the command with parsed arguments.
     * Override in subclass with actual command logic.
     *
     * @param {string} args - Raw argument string after the command verb
     * @returns {Promise<void>}
     */
    async execute(args) {
        const name = this.constructor.name || 'Unknown'
        throw new Error(`execute() not implemented by ${name}`)
    }
}

export default CommandBase
