/**
 * Abstract base class for all interaction handlers.
 *
 * Manages EventBus trigger subscriptions and provides a template-method
 * {@link execute} that subclasses override to implement custom interaction logic
 * (e.g., relay a remote button press to another device).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../../service/eventBus.js'
import LoggerService from '../../service/loggerService.js'

// ---------------------------------------------------------------------------
// InteractionBase (abstract)
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all interaction handlers.
 */
export default class InteractionBase {

    // -- Constructor --------------------------------------------------------

    /**
     * Construct an interaction instance.
     *
     * @param {object} options - Constructor options
     * @param {string} options.name - Display name used in log context (`Interaction:<name>`)
     */
    constructor({ name }) {
        this.name = name
        this._unsubscribes = [] // stored unsubscribe functions for cleanup
    }

    // -- Lifecycle ----------------------------------------------------------

    /**
     * Subscribe to EventBus triggers defined by {@link getTriggerTopics}.
     *
     * Called once during system startup. Subclasses may override but should
     * call `await super.init()` first.
     *
     * @async
     */
    async init() {
        // Subscribe to EventBus triggers.
        const triggers = this.getTriggerTopics()
        if (triggers && triggers.length > 0) {
            for (const topic of triggers) {
                const unsub = EventBus.subscribe(topic, () => {
                    try {
                        this.execute({ trigger: topic })
                    } catch (error) {
                        LoggerService.error(`Error executing event trigger "${topic}" for ${this.name}: ${error.message}`, `Interaction:${this.name}`)
                    }
                })
                if (unsub) {
                    this._unsubscribes.push(unsub)
                }
            }
            LoggerService.info(`${this.name} subscribed to triggers: [${triggers.join(', ')}]`, `Interaction:${this.name}`)
        }
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Determine which EventBus topics this interaction listens on.
     *
     * Default implementation uses `config.name` (or `this.name`) as the zigbee
     * topic slug: `"zigbee:<name>"`. Override for multi-topic or dynamic triggers.
     *
     * @returns {string[]} Topic strings (e.g., `["zigbee:bedroom_shutter"]`)
     */
    getTriggerTopics() {
        const topics = []
        const name = this.config?.name || this.name

        if (typeof name === 'string') {
            topics.push(`zigbee:${name}`)
        }

        return topics
    }

    // -- Abstract method ----------------------------------------------------

    /**
     * Main execution logic -- pure virtual; must be overridden by subclasses.
     *
     * Invoked whenever a subscribed EventBus topic fires.
     *
     * @param {{trigger: string}|null} [triggerData] - Trigger metadata
     * @throws {Error} If not overridden
     */
    execute(triggerData = null) {
        throw new Error('Method "execute()" must be implemented in subclasses.')
    }

    // -- Cleanup ------------------------------------------------------------

    /**
     * Unsubscribe from all EventBus topics and release resources.
     * Called during graceful shutdown.
     */
    cleanup() {
        for (const unsub of this._unsubscribes) {
            try {
                unsub()
            } catch (e) {
                LoggerService.warn(`Error cleaning up subscription for ${this.name}: ${e.message}`, `Interaction:${this.name}`)
            }
        }
        this._unsubscribes = []
    }

    // -- Logging helpers ----------------------------------------------------

    /**
     * Helper method to log messages associated with this interaction.
     *
     * @param {string} message - The message to log
     * @param {string} level - Log level ('info', 'debug', 'warn', 'error')
     */
    log(message, level = 'info') {
        const context = `Interaction:${this.name}`
        switch (level.toLowerCase()) {
            case 'debug': LoggerService.debug(message, context); break
            case 'warn':  LoggerService.warn(message, context); break
            case 'error': LoggerService.error(message, context); break
            default:      LoggerService.info(message, context); break
        }
    }
}