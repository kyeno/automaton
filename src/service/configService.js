/**
 * Configuration Service - Container Pattern.
 *
 * Manages multiple named configuration sections loaded from YAML files. Each
 * section is backed by a {@link ConfigBase} instance that handles parsing,
 * optional strict schema validation, CLI overrides, and dot-notation access.

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

import { parse as yamlParse } from 'yaml'


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
     * Phase 2 - Parse raw --config-override values (all syntax problems reported at once).
     * Phase 3 - Load "main" config (etc/automaton.yaml), apply overrides, validate strictly.
     * Phase 4 - Discover and load additional configs from `paths.configs`.
     *
     * Validation is strict (nginx-style): a missing file, unparseable YAML or any
     * schema violation aborts startup instead of running with broken settings.
     *
     * @param {string[]} [overrides] - Raw "key.path: value" strings collected from repeated
     *                                 -c/--config-override flags; applied to the main section only
     * @throws {Error} On missing env vars, bad override syntax, unknown parameters or schema violations

     */
    async init(overrides = []) {

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
        // Phase 2 - Parse CLI overrides (strict syntax check, all problems at once)
        // ------------------------------------------------------------------
        const rawOverrides = Array.isArray(overrides) ? overrides : []
        /** @type {{ path: string, value: unknown }[]} */
        const entries = []
        /** @type {string[]} */
        const parseProblems = []

        for (const raw of rawOverrides) {
            try {
                entries.push(this.parseConfigOverride(raw))
            } catch (error) {
                parseProblems.push(error.message)
            }
        }

        if (parseProblems.length > 0) {
            throw new Error('Invalid --config-override value(s):\n' + parseProblems.map(p => `  ${p}`).join('\n'))
        }

        // ------------------------------------------------------------------
        // Phase 3 - Load main config, apply overrides, validate strictly.
        // Any violation is fatal (nginx-style): die here with a clear message
        // instead of starting up with broken settings.
        // ------------------------------------------------------------------
        let base
        try {
            base = new ConfigBase('etc/automaton.yaml', 'main')
        } catch (error) {
            throw new Error(`Failed to load main configuration: ${error.message}`)
        }

        if (entries.length > 0) {
            await base.applyOverrides(entries)
        }

        await base.ensureValidated()

        this.#sections.set('main', base)
        try { LoggerService.debug?.('Loaded main configuration from etc/automaton.yaml', 'ConfigService') } catch {}

        // ------------------------------------------------------------------
        // Phase 4 - Load additional configs from paths.configs
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

            /** @type {ConfigBase|null} */
            let base = null
            try {
                base = new ConfigBase(filePath, name)
            } catch (error) {
                try { LoggerService.warn?.(`Failed to load config "${filePath}" as "${name}": ${error.message}`, 'ConfigService') } catch {}
                // Missing/unreadable optional sections stay non-fatal -- the section simply won't be available.
                continue
            }

            this.#sections.set(name, base)
            try { LoggerService.debug?.(`Loaded config section "${name}" from ${filePath}`, 'ConfigService') } catch {}

            // Strict validation: a present-but-invalid section aborts startup.
            await base.ensureValidated()

        }

        const sectionNames = Array.from(this.#sections.keys())
        try { LoggerService.info?.(`Config container ready (${sectionNames.length} section(s): ${sectionNames.join(', ')})`, 'ConfigService') } catch {}
    }

    /**
     * Parse one raw --config-override / -c CLI value into a typed override pair.
     *
     * Expected shape is a single YAML mapping entry: "key.path: value". The value side
     * is interpreted as YAML so numbers, booleans and quoted strings keep their natural
     * types (inline objects/arrays are allowed for whole-subtree overrides too).
     *
     * @param {string} raw - Raw CLI string (e.g., 'locale.language: en_US')
     * @returns {{ path: string, value: unknown }} Dot-path plus its typed value
     * @throws {Error} Descriptive message describing the syntax problem
     */
    parseConfigOverride(raw) {
        const trimmed = String(raw ?? '').trim()
        if (!trimmed) {
            throw new Error('empty --config-override value (expected format: "key.path: value")')
        }

        let doc
        try {
            doc = yamlParse(trimmed)
        } catch (error) {
            throw new Error(`"${raw}" is not valid YAML (${String(error.message).split('\n')[0]})`)
        }

        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
            throw new Error(`"${raw}" must be a single "key.path: value" pair`)
        }

        const entries = Object.entries(/** @type {Record<string, unknown>} */ (doc))
        if (entries.length !== 1) {
            throw new Error(
                `"${raw}" contains ${entries.length} keys -- repeat the -c/--config-override flag instead of listing several in one`
            )
        }

        const [path, value] = entries[0]
        if (value === null || value === undefined) {
            throw new Error(`"${raw}" has an empty value for "${path}" (expected format: "key.path: value")`)
        }
        if (path.split('.').some(seg => seg.trim().length === 0)) {
            throw new Error(`invalid parameter path "${path}" in "${raw}" (segments between dots must not be empty)`)
        }

        return { path, value }
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