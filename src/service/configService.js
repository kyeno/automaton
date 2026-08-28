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

/**
 * Main-config subtrees whose changes gate dependent-subsystem refreshes during
 * `/config reload`: locale drives i18n + TTS templates, ai.* the assistant, and
 * ui.windows the IRC-style channel definitions.
 */
const RELOAD_RELEVANCE_LABELS = Object.freeze(['locale', 'ai', 'ui.windows'])

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

    /** Dot-paths of runtime overrides applied via /config set ("section.path") -- reported as discarded on reload(). */
    #runtimeOverrides = new Set()

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
     * List all currently loaded configuration sections in load order ("main" first).
     * Introspection helper for UI/debug tooling -- e.g., the /config debug listing.
     * @returns {Array<{name: string, filePath: string, hasValidator: boolean, config: ConfigBase}>}
     */
    listSections() {
        const result = []
        for (const [name, base] of this.#sections.entries()) {
            result.push({
                name,
                filePath: base.filePath,
                hasValidator: Boolean(base.hasValidator),
                config: base,
            })
        }
        return result
    }

    // -- Manual reload (/config reload) --------------------------------------

    /**
     * Record a runtime override committed via /config set so that reload() can report it
     * as discarded -- once config files are re-read from disk they are the source of truth.
     * @param {string} sectionName - Section name the override was applied to ("main", "network", ...)
     * @param {string} dotPath - Dotted parameter path that was overridden
     */
    noteSessionOverride(sectionName, dotPath) {
        this.#runtimeOverrides.add(`${String(sectionName).trim()}.${String(dotPath).trim()}`)
    }

    /**
     * All runtime overrides recorded since startup or the last successful reload.
     * @returns {string[]} Entries shaped like "section.parameter.path"
     */
    sessionOverrides() {
        return [...this.#runtimeOverrides]
    }

    /**
     * Re-read every config file from disk and swap the results into the live sections --
     * the manual counterpart of startup loading, used by `/config reload`.
     *
     * Two-phase safe swap:
     *   Phase A -- build candidate ConfigBase instances (main first; extra sections are
     *              discovered from the CANDIDATE main's paths.configs) and validate each
     *              strictly. Missing/unreadable optional sections stay non-fatal exactly
     *              like at startup discovery; a schema violation anywhere is fatal.
     *   Phase B -- only when every candidate is clean: refresh existing section instances
     *              in place (so consumers holding references keep working), add newly
     *              declared ones, drop removed ones ("main" always survives), and clear
     *              the /config set override ledger -- those values lived only in memory.
     * On failure nothing changes and every problem is reported verbatim.
     *
     * The report also carries `changed`: which relevance subtrees (locale.*, ai.*,
     * ui.windows) actually differ pre/post swap so callers can gate dependent subsystems
     * instead of refreshing everything unconditionally.
     *
     * @returns {Promise<{ok:boolean, reloaded:string[], added:string[], dropped:{name:string,error?:string}[], failed:{section:string,error:string}[], discardedOverrides:string[], changed:string[]}>}
     */
    async reload() {
        const pre = this.#snapshotRelevance()

        /** @type {{section:string, error:string}[]} */
        const failed = []
        /** @type {{name:string, base:ConfigBase}[]} */
        const candidates = []
        /** @type {Map<string,string>} Previously loaded sections that could not be re-read, with reason */
        const dropReasons = new Map()

        // ---- Phase A: build + validate candidates --------------------------
        let mainCandidate = null
        try {
            mainCandidate = new ConfigBase('etc/automaton.yaml', 'main')
            await mainCandidate.ensureValidated()
        } catch (error) {
            return {
                ok: false, reloaded: [], added: [], dropped: [],
                failed: [{ section: 'main', error: String(error.message ?? error) }],
                discardedOverrides: this.sessionOverrides(), changed: [],
            }
        }
        candidates.push({ name: 'main', base: mainCandidate })

        const configsMap = mainCandidate.get('paths.configs') ?? DEFAULT_PATHS.configs
        for (const [name, relativePath] of Object.entries(configsMap)) {
            if (!relativePath || typeof relativePath !== 'string') continue

            let filePath = relativePath
            if (!filePath.startsWith('etc/') && !path.isAbsolute(filePath)) {
                filePath = path.join('etc', name, `${name}.yaml`)
            }

            /** @type {ConfigBase|null} */
            let base = null
            try {
                base = new ConfigBase(filePath, name)
            } catch (error) {
                // Same leniency as startup discovery: missing/unreadable optional sections are skipped.
                // If one was loaded before, it drops out of the live set -- with the reason preserved.
                if (this.#sections.has(name)) dropReasons.set(name, String(error.message ?? error))
                continue
            }

            try {
                await base.ensureValidated()   // present-but-invalid is fatal, exactly like at startup
            } catch (error) {
                failed.push({ section: name, error: String(error.message ?? error) })
                continue
            }

            candidates.push({ name, base })
        }

        if (failed.length > 0) {
            return {
                ok: false, reloaded: [], added: [], dropped: [], failed,
                discardedOverrides: this.sessionOverrides(), changed: [],
            }
        }

        // ---- Phase B: safe swap ---------------------------------------------
        const desired = new Set(candidates.map((c) => c.name))
        /** @type {string[]} */
        const reloaded = []
        /** @type {string[]} */
        const added = []
        /** @type {{name:string,error?:string}[]} */
        const dropped = []

        for (const candidate of candidates) {
            const existing = this.#sections.get(candidate.name)
            if (existing && typeof existing.refresh === 'function') {
                existing.refresh()          // same instance -- consumers keep their references
                reloaded.push(candidate.name)
            } else {
                this.#sections.set(candidate.name, candidate.base)
                added.push(candidate.name)
            }
        }

        for (const [name] of [...this.#sections.entries()]) {
            if (!desired.has(name)) {
                this.#sections.delete(name)
                dropped.push(dropReasons.has(name) ? { name, error: dropReasons.get(name) } : { name })
            }
        }

        const discardedOverrides = this.sessionOverrides()
        this.#runtimeOverrides.clear()

        if (added.length > 0 || dropped.length > 0) {
            try {
                LoggerService.info?.(
                    `Config sections changed on reload (+${added.join(', ') || 'none'} / -${dropped.map((d) => d.name).join(',') || 'none'})`,
                    'ConfigService'
                )
            } catch {}
        }

        return { ok: true, reloaded, added, dropped, failed: [], discardedOverrides, changed: this.#diffRelevance(pre) }
    }

    /**
     * Snapshot the config subtrees whose changes should trigger dependent-subsystem
     * refreshes during /config reload. JSON serialization gives stable equality checks
     * over plain YAML data without deep-compare bookkeeping.
     * @private
     * @returns {Record<string,string>} label -> serialized subtree
     */
    #snapshotRelevance() {
        const main = this.#sections.get('main')
        /** @type {Record<string,string>} */
        const snap = {}
        for (const label of RELOAD_RELEVANCE_LABELS) {
            try { snap[label] = JSON.stringify(main?.get(label)) } catch { snap[label] = '' }
        }
        return snap
    }

    /**
     * Compare a pre-reload relevance snapshot against current state.
     * @private
     * @param {Record<string,string>} pre - Snapshot taken before the swap
     * @returns {string[]} Labels that actually differ
     */
    #diffRelevance(pre) {
        const post = this.#snapshotRelevance()
        return RELOAD_RELEVANCE_LABELS.filter((label) => pre[label] !== post[label])
    }

    /**
     * Resolve a section reference to one of the loaded sections. Accepts the exact
     * section name ("main"), its YAML filename ("automaton.yaml") or any path suffix
     * ("device/network"), case-insensitively. First match in load order wins. Retained
     * as an internal/introspection helper -- the /config command surface addresses the
     * main section directly and no longer exposes per-file selection to users.
     * @param {string} query - Section name, filename or path fragment
     * @returns {{name: string, filePath: string, hasValidator: boolean, config: ConfigBase}|null}
     *          Matching section descriptor, or null when nothing matches
     */
    resolveSection(query) {
        const raw = String(query ?? '').trim()
        if (!raw) return null

        const sections = this.listSections()

        // 1) Exact section-name match (case-insensitive for convenience)
        let hit = sections.find((s) => s.name.toLowerCase() === raw.toLowerCase())
        if (hit) return hit

        // 2) Filename / path-suffix fallback against the resolved file location
        const norm = (s) => s.toLowerCase().replace(/\.ya?ml$/i, '')
        const q = norm(raw)
        hit = sections.find((s) => {
            const fileNorm = norm(s.filePath)
            const baseFile = fileNorm.split('/').pop()
            return q === baseFile || fileNorm.endsWith(`/${q}`)
        })
        return hit ?? null
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