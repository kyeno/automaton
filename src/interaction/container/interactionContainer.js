/**
 * Interaction container.
 *  Manages all interactions -- both YAML-configured and custom JS interactions.
 *  Auto-discovers concrete interaction classes from the interaction directory,
 *  instantiates them, loads YAML configs via ConfigService, and provides a
 *  registry for lookup and execution.
 *
 * Directory layout:
 *   src/interaction/base/       -- abstract InteractionBase (never loaded here)
 *   etc/interaction/            -- concrete interactions (auto-discovered by user)
 *   src/interaction/container/  -- this file
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'

import Autoloader from '../../lib/autoloader.js'
import LoggerService from '../../service/loggerService.js'
import ConfigService from '../../service/configService.js'
import { PROJECT_ROOT } from '../../lib/projectRoot.js'
import DeviceContainer from '../../device/container/deviceContainer.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'

// ---------------------------------------------------------------------------
// SInteractionContainer (singleton)
// ---------------------------------------------------------------------------

/**
 * Interaction repository and manager.
 *
 * Loads YAML-defined interactions from `etc/interaction.yaml` (via ConfigService)
 * and auto-discovers concrete interaction implementations in the interaction
 * directory. Instantiates each one, calls `init()`, and maintains a name-indexed
 * map so that other parts of the system can look up or trigger interactions.
 */
class SInteractionContainer {

    instance

    /**
     * Map of interaction instances keyed by interaction name.
     * @type {Map<string, Object>}
     */
    #interactions = new Map()

    // -- Singleton --------------------------------------------------------

    /**
     * Synchronous singleton constructor.
     * @return {this}
     */
    constructor() {
        if (!SInteractionContainer.instance) SInteractionContainer.instance = this
        return SInteractionContainer.instance
    }

    // -- Lifecycle --------------------------------------------------------

    /**
     * Initialize the container: load YAML configs, discover custom JS classes,
     * instantiate everything, then call async init on each one.
     * @async
     */
    async init() {
        await this.#loadBasicConfigs()
        await this.#loadCustomClasses()
        await this.#instantiateInteractions()
    }

    // -- Discovery --------------------------------------------------------

    /**
     * Load YAML configuration from ConfigService "interaction" section and create
     * basic (config-only) interactions.
     * @private
     */
    async #loadBasicConfigs() {
        const interactionConfig = ConfigService.section('interaction')

        if (!interactionConfig) {
            LoggerService.warn(
                'Interaction config section not available (interaction.yaml not loaded)',
                'InteractionContainer'
            )
            return
        }

        try {
            const doc = interactionConfig.toJSON()

            if (!doc?.interactions || !Array.isArray(doc.interactions)) {
                LoggerService.warn('No interactions defined in config', 'InteractionContainer')
                return
            }

            for (const interactionConfig of doc.interactions) {
                const name = interactionConfig?.name
                if (!name) {
                    LoggerService.warn('Interaction without name in config, skipping', 'InteractionContainer')
                    continue
                }

                // Store config for later instantiation
                this.#interactions.set(name, {
                    instance: null,
                    config: interactionConfig,
                    isYaml: true
                })
            }

            LoggerService.info(
                `Loaded ${doc.interactions.length} YAML interaction(s) from config`,
                'InteractionContainer'
            )
        } catch (error) {
            LoggerService.error(
                `Failed to load interactions config: ${error.message}`,
                'InteractionContainer'
            )
        }
    }

    /**
     * Scan the interaction directory for concrete interaction classes using Autoloader.
     * Directory path resolved via ConfigService.getDirectoryPath('interaction').
     * Only loads `.js` files (skips `.yaml` config files).
     * @private
     */
    async #loadCustomClasses() {
        const dirRelative = ConfigService.getDirectoryPath('interaction')

        if (!dirRelative) {
            LoggerService.warn(
                'No interaction directory configured',
                'InteractionContainer'
            )
            return
        }

        const customDir = path.join(PROJECT_ROOT, dirRelative)

        if (!fs.existsSync(customDir)) {
            LoggerService.warn(
                `Interaction directory not found: ${customDir}`,
                'InteractionContainer'
            )
            return
        }

        try {
            const autoloader = new Autoloader()
            const modules = await autoloader.preloadPath(customDir)

            for (const [fileName, moduleExport] of Object.entries(modules)) {
                // Skip YAML files - only load JS interaction classes
                if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) continue

                const InteractionClass = moduleExport
                if (typeof InteractionClass !== 'function') {
                    LoggerService.warn(
                        `Skipping "${fileName}" -- no callable default export found`,
                        'InteractionContainer'
                    )
                    continue
                }

                this.#interactions.set(fileName, {
                    instance: null,
                    class: InteractionClass,
                    isYaml: false
                })
            }

            LoggerService.info(
                `${Object.keys(modules).length} custom interaction class(es) discovered`,
                'InteractionContainer'
            )
        } catch (error) {
            LoggerService.error(
                `Error loading custom interaction classes: ${error.message}`,
                'InteractionContainer'
            )
        }
    }

    /**
     * Instantiate all discovered interactions and call their init().
     * @async
     * @private
     */
    async #instantiateInteractions() {
        const instantiated = []

        for (const [name, entry] of this.#interactions.entries()) {
            try {
                let instance

                if (entry.isYaml) {
                    instance = this.#createYamlInteraction(name, entry.config)
                } else {
                    instance = new entry.class({ name })
                    await instance.init()
                }

                this.#interactions.set(name, {
                    ...entry,
                    instance
                })
                instantiated.push(name)
            } catch (error) {
                LoggerService.error(
                    `Failed to instantiate interaction "${name}": ${error.message}`,
                    'InteractionContainer'
                )
            }
        }

        if (instantiated.length > 0) {
            LoggerService.info(
                `${instantiated.length} interaction(s) loaded`,
                'InteractionContainer'
            )
        }
    }

    // -- Public API -------------------------------------------------------

    /**
     * Get an interaction instance by name.
     * @param {string} name - Interaction name
     * @returns {Object|null} Interaction instance or null
     */
    getInteraction(name) {
        const entry = this.#interactions.get(name)
        return entry?.instance ?? null
    }

    /**
     * Trigger an interaction's execute method by name.
     * @param {string} name - Interaction name
     * @param {Object} [data={}] - Data to pass to execute()
     * @returns {Promise<void>}
     */
    async callInteraction(name, data = {}) {
        const interaction = this.getInteraction(name)
        if (interaction && typeof interaction.execute === 'function') {
            await interaction.execute(data)
        } else {
            LoggerService.warn(
                `Interaction "${name}" not found or has no execute() method`,
                'InteractionContainer'
            )
        }
    }

    /**
     * Get all registered interaction instances as a Map.
     * @returns {Map<string, Object>}
     */
    getAll() {
        const result = new Map()
        for (const [key, entry] of this.#interactions.entries()) {
            if (entry.instance) {
                result.set(key, entry.instance)
            }
        }
        return result
    }

    // -- Lifecycle helpers ------------------------------------------------

    /**
     * Clean up all interactions during graceful shutdown.
     * Calls cleanup() on each instance (stops timers, unsubscribes events).
     */
    cleanupInteractions() {
        LoggerService.info('Cleaning up interactions...', 'InteractionContainer')
        for (const [name, entry] of this.#interactions.entries()) {
            if (!entry.instance) continue
            try {
                if (typeof entry.instance.cleanup === 'function') {
                    entry.instance.cleanup()
                }
            } catch (err) {
                LoggerService.error(
                    `Error cleaning up interaction "${name}": ${err.message}`,
                    'InteractionContainer'
                )
            }
        }
    }

    // -- YAML interaction factory -----------------------------------------

    /**
     * Create a YAML-based interaction instance from config.
     * @param {string} name - Interaction name
     * @param {Object} config - Interaction config from YAML
     * @returns {Object} Interaction instance
     * @private
     */
    #createYamlInteraction(name, config) {
        const interactionsMap = this.#interactions

        return {
            name,
            config,
            async execute(triggerData = null) {
                const actionType = triggerData?.action || null

                if (!config.actions) {
                    LoggerService.warn(`No actions defined for interaction "${name}"`, `Interaction:${name}`)
                    return
                }

                // Find matching action by type
                const action = config.actions.find(a => a.type === actionType)
                if (!action) {
                    LoggerService.debug(
                        `No matching action for type "${actionType}" in "${name}"`,
                        `Interaction:${name}`
                    )
                    return
                }

                // Handle "targets" -- simple device commands
                if (action.targets && Array.isArray(action.targets)) {
                    await _executeTargets(action.targets)
                }

                // Handle "calls" -- call another interaction
                if (action.calls) {
                    const targetEntry = interactionsMap.get(action.calls)
                    if (targetEntry?.instance && typeof targetEntry.instance.execute === 'function') {
                        targetEntry.instance.execute(triggerData)
                    } else {
                        LoggerService.warn(
                            `Target interaction "${action.calls}" not found`,
                            `Interaction:${name}`
                        )
                    }
                }
            },
            cleanup() {
                // YAML interactions don't need special cleanup
            }
        }

        /**
         * Execute a list of device targets.
         * Commands are enqueued through MqttService's internal FIFO queue which
         * handles global rate-limiting across all sources automatically.
         * @param {Array} targets - Array of {device, command} objects
         */
        async function _executeTargets(targets) {
            for (const target of targets) {
                const cmd = target.command?.toUpperCase()
                if (!cmd) continue

                const device = DeviceContainer.findByName(target.device)
                if (!device) {
                    LoggerService.warn(
                        `Device "${target.device}" not found in interaction target`,
                        `Interaction:${name}`
                    )
                    continue
                }

                try {
                    // Interaction targets are human-configured actions -> HUMAN provenance.
                    device.receiveCommand(cmd, DeviceCommandSource.HUMAN)
                } catch (err) {
                    LoggerService.error(
                        `Failed to dispatch "${cmd}" to "${target.device}": ${err.message}`,
                        `Interaction:${name}`
                    )
                }
            }
        }
    }
}

// Singletonize and export to Node.js.
const InteractionContainer = new SInteractionContainer()
Object.freeze(InteractionContainer)
export default InteractionContainer