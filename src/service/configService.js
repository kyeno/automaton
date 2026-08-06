/**
 * Configuration Service - Container Pattern.
 *
 * Manages multiple named configuration sections loaded from YAML files. Each
 * section is backed by a {@link ConfigBase} instance that handles parsing,
 * optional schema validation, and dot-notation access.
 *
 * At startup, loads the "main" config (etc/automaton.yaml), then discovers any
 * additional configs referenced in its `paths.configs` map and loads them as
 * named sections. Individual automations or interactions can also load their
 * own optional companion configs at runtime via {@link load}.
 *
 * Backward-compatible: exposes get(), getSection(), has() delegates to the
 * "main" section so existing callers don't need immediate changes.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'

import LoggerService from './loggerService.js'
import ConfigBase from './config/configBase.js'

// ---------------------------------------------------------------------------
// Default paths (used when not overridden in main config)
// ---------------------------------------------------------------------------

const DEFAULT_PATHS = Object.freeze({
    configs: {
        network:     'etc/device/network.yaml',
        interaction: 'etc/interaction/interaction.yaml'
    },
    directories: {
        automation:  'etc/automation/',
        interaction: 'etc/interaction/'
    }
})

// ---------------------------------------------------------------------------
// SConfigContainer (singleton)
// ---------------------------------------------------------------------------

/**
 * Configuration container that manages multiple named YAML-backed sections.
 */
class SConfigContainer {

    instance

    /** @type {Map<string, ConfigBase>} */
    #sections = new Map()

    // -- Singleton ----------------------------------------------------------

    constructor() {
        if (!SConfigContainer.instance) SConfigContainer.instance = this
        return SConfigContainer.instance
    }

    // -- Lifecycle ----------------------------------------------------------

    /**
     * Initialize the configuration container.
     *
     * Phase 1 - Validate required environment variables.
     * Phase 2 - Load "main" config (etc/automaton.yaml).
     * Phase 3 - Discover and load additional configs from `paths.configs`.
     *
     * Call once early during bootstrap before any other service needs config.
     * Throws on fatal errors with descriptive messages.
     */
    async init() {
        // ------------------------------------------------------------------
        // Phase 1 - Validate required environment variables
        // ------------------------------------------------------------------
        /** @type {Record<string, string>} */
        const REQUIRED_ENV_VARS = {
            MQTT_URL:    'MQTT broker connection URL (e.g., mqtt://localhost:1883)',
            MQTT_PREFIX: 'MQTT topic prefix for Zigbee messages (e.g., zigbee2mqtt)',
            REDIS_URL:   'Redis connection URL (e.g., redis://localhost:6379)'
        }

        let missingEnvVars = []
        for (const [envVar, description] of Object.entries(REQUIRED_ENV_VARS)) {
            if (!process.env[envVar]) {
                missingEnvVars.push(`  ${envVar}: ${description}`)
            }
        }

        if (missingEnvVars.length > 0) {
            throw new Error(
                '\nMissing required environment variable(s):\n' +
                missingEnvVars.join('\n') +
                '\n\nSet these in your .env file or export them before starting.'
            )
        }

        try { LoggerService.debug?.('Validating environment variables...', 'ConfigService') } catch {}

        // ------------------------------------------------------------------
        // Phase 2 - Load main config
        // ------------------------------------------------------------------
        try {
            this.#sections.set('main', new ConfigBase('etc/automaton.yaml', 'main'))
            try { LoggerService.debug?.('Loaded main configuration from etc/automaton.yaml', 'ConfigService') } catch {}
        } catch (error) {
            throw new Error(
                `Failed to load main configuration: ${error.message}`
            )
        }

        // ------------------------------------------------------------------
        // Phase 3 - Load additional configs from paths.configs
        // ------------------------------------------------------------------
        await this.#loadExtraConfigs()
    }

    /**
     * After main config is loaded, discover and load extra YAML configs.
     * @private
     */
    async #loadExtraConfigs() {
        const main = this.#sections.get('main')
        if (!main) return

        // Get paths from config, falling back to defaults
        const configsMap = main.get('paths.configs') ?? DEFAULT_PATHS.configs

        for (const [name, relativePath] of Object.entries(configsMap)) {
            if (this.#sections.has(name)) continue // already loaded

            let filePath = relativePath
            // If the path doesn't start with "etc/", prepend it
            if (!filePath.startsWith('etc/') && !path.isAbsolute(filePath)) {
                filePath = path.join('etc', name, `${name}.yaml`)
            }

            try {
                this.#sections.set(name, new ConfigBase(filePath, name))
                try { LoggerService.debug?.(`Loaded config section "${name}" from ${filePath}`, 'ConfigService') } catch {}
            } catch (error) {
                try { LoggerService.warn?.(`Failed to load config section "${name}": ${error.message}`, 'ConfigService') } catch {}
                // Non-fatal - section simply won't be available
            }
        }

        const sectionNames = Array.from(this.#sections.keys())
        try { LoggerService.info?.(`Config container ready (${sectionNames.length} section(s): ${sectionNames.join(', ')})`, 'ConfigService') } catch {}
    }

    // -- Public API: Section access -----------------------------------------

    /**
     * Get a named configuration section.
     * @param {string} name - Section name (e.g., "main", "network", "interaction")
     * @returns {ConfigBase|undefined} The section's accessor, or undefined if not loaded
     */
    section(name) {
        return this.#sections.get(name) ?? undefined
    }

    /**
     * Load an additional YAML config file as a named section on demand.
     *
     * Used by individual automations/interactions that have their own optional
     * companion configs. Loaded sections are cached - repeated calls with the
     * same path return the existing instance.
     *
     * @param {string} filePath  - Path to YAML file (relative to project root or absolute)
     * @param {string} [sectionName] - Name for the section (default: derived from filename)
     * @returns {ConfigBase|null} ConfigBase instance, or null if file doesn't exist
     */
    load(filePath, sectionName) {
        const name = sectionName ?? path.basename(filePath, '.yaml')

        // Return cached instance if already loaded under this name
        if (this.#sections.has(name)) {
            try { LoggerService.debug?.(`Returning cached section "${name}"`, 'ConfigService') } catch {}
            return this.#sections.get(name)
        }

        try {
            const base = new ConfigBase(filePath, name)
            this.#sections.set(name, base)
            try { LoggerService.debug?.(`Loaded config section "${name}" from ${filePath}`, 'ConfigService') } catch {}
            return base
        } catch (error) {
            try { LoggerService.warn?.(`Failed to load config "${filePath}" as "${name}": ${error.message}`, 'ConfigService') } catch {}
            return null
        }
    }

    /**
     * Remove a dynamically loaded section from cache.
     * Cannot unload "main".
     * @param {string} name - Section name to unload
     * @returns {boolean} true if removed, false if not found or protected
     */
    unload(name) {
        if (name === 'main') return false
        return this.#sections.delete(name)
    }

    // -- Public API: Backward-compatible delegates (delegate to "main") -----

    /**
     * Get a value from the main configuration using dot notation.
     * @param {string} key       - Dot-separated key (e.g., "logger.file.max_size")
     * @param {*}      [defaultVal] - Fallback value if key doesn't exist
     * @returns {*}
     */
    get(key, defaultVal) {
        const main = this.#sections.get('main')
        return main ? main.get(key, defaultVal) : defaultVal
    }

    /**
     * Get an entire section of the main configuration as a shallow copy.
     * @param {string} key - Dot-notation path to a nested object
     * @returns {Object|undefined} Shallow copy of the section, or undefined
     */
    getSection(key) {
        const main = this.#sections.get('main')
        return main ? main.getSection(key) : undefined
    }

    /**
     * Check whether a key exists in the main configuration.
     * @param {string} key - Dot-separated key
     * @returns {boolean}
     */
    has(key) {
        const main = this.#sections.get('main')
        return main ? main.has(key) : false
    }

    // -- Public API: Paths helpers ------------------------------------------

    /**
     * Resolve a config file path from `paths.configs`, falling back to defaults.
     * @param {string} name - Config name (e.g., "network", "interaction")
     * @returns {string|null} Resolved relative path, or null if not configured
     */
    getConfigPath(name) {
        const main = this.#sections.get('main')
        if (!main) return DEFAULT_PATHS.configs[name] ?? null

        const configsMap = main.get('paths.configs') ?? {}
        return configsMap[name] ?? DEFAULT_PATHS.configs[name] ?? null
    }

    /**
     * Resolve a directory path from `paths.directories`, falling back to defaults.
     * @param {string} name - Directory name (e.g., "automation", "interaction")
     * @returns {string|null} Resolved relative path, or null if not configured
     */
    getDirectoryPath(name) {
        const main = this.#sections.get('main')
        if (!main) return DEFAULT_PATHS.directories[name] ?? null

        const dirsMap = main.get('paths.directories') ?? {}
        return dirsMap[name] ?? DEFAULT_PATHS.directories[name] ?? null
    }
}

// Singleton instance - frozen public API surface
const ConfigService = Object.freeze(new SConfigContainer())
export default ConfigService