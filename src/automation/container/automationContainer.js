/**
 * Automation container.
 *  Manages all automation instances -- auto-discovers concrete automation classes
 *  from `custom/`, instantiates them, initializes them, and provides a registry
 *  for lookup and execution.
 *
 * Directory layout:
 *   src/automation/base/       -- abstract AutomationBase (never loaded here)
 *   etc/automation/            -- concrete automations (auto-discovered by user)
 *   src/automation/container/  -- this file
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'

import Autoloader from '../../lib/autoloader.js'
import LoggerService from '../../service/loggerService.js'
import ConfigService from '../../service/configService.js'
import { PROJECT_ROOT } from '../../lib/projectRoot.js'

// ---------------------------------------------------------------------------
// SAutomationContainer (singleton)
// ---------------------------------------------------------------------------

/**
 * Automation repository and manager.
 *
 * Auto-discovers concrete automation implementations in `src/automation/custom/`,
 * instantiates each one, calls `init()`, and maintains a name-indexed map
 * so that other parts of the system can look up or trigger automations.
 */
class SAutomationContainer {

    instance

    /**
     * Map of automation instances keyed by automation.name.
     * @type {Map}
     */
    #automations = new Map()

    // -- Singleton --------------------------------------------------------

    /**
     * Synchronous singleton constructor.
     *
     * @return {this}
     */
    constructor() {
        if (!SAutomationContainer.instance) SAutomationContainer.instance = this
        return SAutomationContainer.instance
    }

    // -- Lifecycle --------------------------------------------------------

    /**
     * Initialize the container: auto-discover automation classes from `custom/`,
     * instantiate them, then call async init on each one.
     *
     * @async
     */
    async init() {
        await this.#loadAutomationClasses()
        await this.#instantiateAutomations()
    }

    // -- Discovery & instantiation ----------------------------------------

    /**
     * Scan `etc/automation/` for concrete automation classes using Autoloader.
     * Only loads `.js` files (skips `.yaml` config files).
     *
     * @private
     */
    async #loadAutomationClasses() {
        const dirRelative = ConfigService.getDirectoryPath('automation')

        if (!dirRelative) {
            LoggerService.warn(
                'No automation directory configured',
                'AutomationContainer'
            )
            return
        }

        const customDir = path.join(PROJECT_ROOT, dirRelative)

         try {
             const autoloader = new Autoloader()
             const modules = await autoloader.preloadPath(customDir)

             for (const [fileName, moduleExport] of Object.entries(modules)) {
                 // Skip non-JS modules (e.g., YAML configs have no .js extension,
                 // but guard against future autoloaders that might pick them up)
                 if (!fileName.endsWith('.js') && !fileName.includes('Automation')) continue

                 // Autoloader.preloadPath already resolves mod.default ?? mod,
                 // so moduleExport IS the class constructor directly.
                 const AutomationClass = moduleExport
                if (typeof AutomationClass !== 'function') {
                    LoggerService.warn(
                        `Skipping "${fileName}" -- no callable default export found`,
                        'AutomationContainer'
                    )
                    continue
                }

                this.#automations.set(fileName, {
                    class: AutomationClass,
                    instantiated: false
                })
            }

            LoggerService.info(
                `${this.#automations.size} automation class(es) discovered`,
                'AutomationContainer'
            )
        } catch (error) {
            LoggerService.error(
                `Error loading automation classes: ${error.message}`,
                'AutomationContainer'
            )
        }
    }

    /**
     * Instantiate each discovered automation class and call its init().
     *
     * @async
     * @private
     */
    async #instantiateAutomations() {
        const toInstantiate = []

        // Snapshot entries BEFORE iteration to avoid instantiating twice when
        // we add a new Map key (instance.name !== file-name) during the loop.
        // JS Map iterators include entries added mid-iteration, which caused
        // every automation to be created and initialized twice.
        const entries = Array.from(this.#automations.entries())

        for (const [key, entry] of entries) {
            try {
                const instance = new entry.class()
                await instance.init()

                // Store by the automation's own name property
                const automName = instance.name || key
                this.#automations.set(automName, {
                    class: entry.class,
                    instance,
                    instantiated: true
                })
                toInstantiate.push(automName)
            } catch (error) {
                LoggerService.error(
                    `Failed to instantiate automation "${key}": ${error.message}`,
                    'AutomationContainer'
                )
            }
        }

        if (toInstantiate.length > 0) {
            LoggerService.info(
                `${toInstantiate.length} automation(s) loaded`,
                'AutomationContainer'
            )
        }
    }

    // -- Public API -------------------------------------------------------

    /**
     * Get an automation instance by name.
     *
     * @param {string} name - Automation name
     * @returns {AutomationBase|null} Automation instance or null
     */
    getAutomation(name) {
        const entry = this.#automations.get(name)
        return entry?.instance ?? null
    }

    /**
     * Trigger an automation's execute method by name.
     *
     * @param {string} name - Automation name
     * @param {Object} [data={}] - Data to pass to execute()
     * @returns {Promise<void>}
     */
    async callAutomation(name, data = {}) {
        const automation = this.getAutomation(name)
        if (automation && typeof automation.execute === 'function') {
            await automation.execute(data)
        } else {
            LoggerService.warn(
                `Automation "${name}" not found or has no execute() method`,
                'AutomationContainer'
            )
        }
    }

    /**
     * Get all registered automation instances as a Map.
     *
     * @returns {Map}
     */
    getAll() {
        const result = new Map()
        for (const [key, entry] of this.#automations.entries()) {
            if (entry.instance) {
                result.set(key, entry.instance)
            }
        }
        return result
    }

    // -- Lifecycle helpers ------------------------------------------------

    /**
     * Clean up all automations during graceful shutdown.
     * Calls cleanup() on each instance (stops timers, unsubscribes events).
     */
    cleanupAutomations() {
        LoggerService.info('Cleaning up automations...', 'AutomationContainer')
        for (const [name, entry] of this.#automations.entries()) {
            if (!entry.instance) continue
            try {
                if (typeof entry.instance.cleanup === 'function') {
                    entry.instance.cleanup()
                }
            } catch (err) {
                LoggerService.error(
                    `Error cleaning up automation "${name}": ${err.message}`,
                    'AutomationContainer'
                )
            }
        }
    }
}

// Singletonize and export to Node.js.
const AutomationContainer = new SAutomationContainer()
Object.freeze(AutomationContainer)
export default AutomationContainer