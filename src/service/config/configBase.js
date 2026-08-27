/**
 * Configuration Base Class.
 *
 * Factory-like class that loads a single YAML configuration file, optionally
 * validates it against a schema found in src/validators/, and provides dot-
 * notation access to its contents via get(), has(), toJSON().
 *
 * Not intended for direct use outside ConfigService - individual modules should
 * access configs through ConfigService.section(name).
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
import { parseDocument as yamlParseDocument } from 'yaml'

import { PROJECT_ROOT } from '../../lib/projectRoot.js'

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * Schema node definition for recursive config validation.
 *
 * @typedef {Object} ConfigSchemaNode
 * @property {'string'|'number'|'boolean'|'object'|'array'|Array<'string'|'number'|'boolean'|'object'|'array'>} [type] - Expected JavaScript type(s); an array allows any of the listed types
 * @property {boolean} [required] - Whether this key must be present
 * @property {unknown[]} [enum] - Allowed values (mutually exclusive with `type` checking)
 * @property {Record<string, ConfigSchemaNode>} [properties] - Child schema for nested objects
 * @property {ConfigSchemaItems} [items] - Schema for array element validation
 *
 * @typedef {Object} ConfigSchemaItems
 * @property {Record<string, ConfigSchemaNode>} [properties] - Per-element schema when array contains objects
 */

// ---------------------------------------------------------------------------
// ConfigBase class
// ---------------------------------------------------------------------------

/**
 * Loads and provides access to a single YAML configuration file.
 *
 * On construction, attempts to discover an optional validator at
 * src/validators/<sectionName>.js. If found, validates the loaded data against
 * it and logs warnings for any issues. Missing validators are silently ignored
 * (the config is still usable without validation).
 */
class ConfigBase {

    /**
     * @param {string} filePath   - Absolute or relative path to the YAML file
     *                               (relative paths resolved against project root)
     * @param {string} [sectionName] - Section name used to look up optional validator
     *                                 in src/validators/{sectionName}.js
     */
    constructor(filePath, sectionName) {
        this.#filePath = filePath
        this.#sectionName = sectionName ?? path.basename(filePath, '.yaml')
        /** @type {Record<string, unknown>} */
        this.#data = {}
        this.#hasValidator = false
        this.#schemaPromise = null


        this.#load()
    }

    // -- Private properties -------------------------------------------------

    /** @type {string} */ #filePath
    /** @type {string} */ #sectionName
    /** @type {Record<string, unknown>} */ #data
    /** @type {boolean} */ #hasValidator
    /** @type {Promise<Record<string, ConfigSchemaNode>|null>} */ #schemaPromise


    // -- Loading ------------------------------------------------------------

    /**
     * Read and parse the YAML file, then attempt schema validation.
     * Falls back to a <path>.dist template when the active config is missing.
     * @private
     */
    #load() {
        let absolutePath = this.#filePath

        // If not already absolute, resolve relative to project root
        if (!path.isAbsolute(absolutePath)) {
            absolutePath = path.join(PROJECT_ROOT, absolutePath)
        }

        // Fall back to .dist template if the active config doesn't exist
        if (!fs.existsSync(absolutePath)) {
            const distPath = absolutePath + '.dist'
            if (fs.existsSync(distPath)) {
                absolutePath = distPath
            } else {
                throw new Error(`Config file not found: ${absolutePath}`)
            }
        }

        try {
            const content = fs.readFileSync(absolutePath, 'utf8')
            const doc = yamlParseDocument(content)
            this.#data = /** @type {Record<string, unknown>} */ (doc.toJS()) || {}
        } catch (error) {
            throw new Error(
                `Failed to parse config "${this.#filePath}": ${error.message}`
            )
        }

    }

    /**
     * Load (and cache) this section's validator schema from src/validators/.
     *
     * Memoized: repeated calls share one import promise so validation stays
     * deterministic no matter how many code paths trigger it. A missing or
     * broken validator file simply means "nothing to check" for this section.
     * @private
     * @returns {Promise<Record<string, ConfigSchemaNode>|null>} Schema object, or null when absent
     */
    async #ensureSchema() {
        if (!this.#schemaPromise) {
            this.#schemaPromise = (async () => {
                const validatorPath = path.join(
                    PROJECT_ROOT, 'src', 'validators', `${this.#sectionName}.js`
                )

                if (!fs.existsSync(validatorPath)) return null

                try {
                    /* v8 ignore next 2 */
                    const mod = await import(validatorPath)
                    const schema = mod.default ?? mod
                    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
                        this.#hasValidator = true
                        return /** @type {Record<string, ConfigSchemaNode>} */ (schema)
                    }
                    return null
                } catch {
                    // Validator load failure is non-fatal - skip validation for this section.
                    return null
                }
            })()
        }

        return this.#schemaPromise
    }

    /**
     * Validate the current data against this section's schema and THROW on any violation.
     *
     * Strict by design (nginx-style): a config that exists but breaks its schema must
     * abort startup with every problem listed at once instead of running degraded.
     * Sections without a validator are no-ops. Safe to call repeatedly -- e.g., after
     * applyOverrides() -- since it always re-checks the live data.
     *
     * @throws {Error} Aggregated list of every schema violation found
     */
    async ensureValidated() {
        const schema = await this.#ensureSchema()
        if (!schema) return

        const errors = this.#validate(this.#data, schema, '')
        if (errors.length > 0) {
            throw new Error(
                `Config validation failed [${this.#sectionName}] (${this.#filePath}):\n` +
                errors.map(e => `  ${e}`).join('\n')
            )
        }
    }

    /**
     * Apply parsed CLI overrides ("key.path: value" pairs) onto the loaded data.
     *
     * Every target parameter must already exist in the configuration or be declared
     * by the section's schema; anything else is reported as an unknown-parameter error
     * so typos can never silently create brand-new keys. All problems are collected
     * before any mutation happens. Type/enum conformance of the merged document is
     * enforced afterwards by ensureValidated().
     *
     * @param {{ path: string, value: unknown }[]} entries - Parsed override pairs
     * @throws {Error} When one or more target parameters are unknown
     */
    async applyOverrides(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return

        const schema = await this.#ensureSchema() ?? {}
        /** @type {string[]} */
        const unknowns = []

        for (const entry of entries) {
            const knownInData = this.has(entry.path)
            const knownInSchema = !!this.#resolveInSchema(schema, String(entry.path))
            if (!knownInData && !knownInSchema) {
                unknowns.push(`Unknown config parameter "${entry.path}" -- not found in ${this.#filePath} nor in its schema`)
            }
        }

        if (unknowns.length > 0) {
            const validTopLevel = Array.from(new Set([...Object.keys(this.#data), ...Object.keys(schema)])).sort()
            throw new Error(
                'Invalid config override(s):\n' +
                unknowns.map(u => `  ${u}`).join('\n') + '\n' +
                `Valid top-level parameters: ${validTopLevel.join(', ')}`
            )
        }

        for (const entry of entries) {
            this.#setPath(String(entry.path).split('.'), entry.value)
        }
    }

    /**
     * Resolve a dot-notation path against the validator schema and return the leaf
     * definition, or undefined when any segment is missing. Walks through each node's
     * `properties` map; array item schemas are intentionally not addressable by name.
     * @private
     * @param {Record<string, ConfigSchemaNode>} schema - Top-level schema object
     * @param {string} dotPath - Dot-separated key path
     * @returns {ConfigSchemaNode|undefined} Leaf schema definition, if present
     */
    #resolveInSchema(schema, dotPath) {
        const parts = dotPath.split('.')
        if (!parts.length || !schema[parts[0]]) return undefined

        /** @type {unknown} */
        let def = schema[parts[0]]
        for (let i = 1; i < parts.length; i++) {
            if (def == null || typeof def !== 'object') return undefined
            def = /** @type {Record<string, unknown>} */ (def).properties?.[parts[i]]
        }
        return def
    }

    /**
     * Write a value at a dot-path inside the loaded data, materializing plain-object
     * intermediates as needed (e.g., overriding paths.configs.network while the whole
     * `paths:` block is still commented out in the YAML file). Existing objects and
     * arrays are descended into untouched.
     * @private
     * @param {string[]} segments - Non-empty key segments
     * @param {unknown} value - Value to store at the leaf
     */
    #setPath(segments, value) {
        /** @type {Record<string, unknown>} */
        let cur = this.#data
        for (let i = 0; i < segments.length - 1; i++) {
            const seg = segments[i]
            let next = cur[seg]
            if (next === undefined || next === null || typeof next !== 'object') {
                next = {}
                cur[seg] = next
            }
            cur = /** @type {Record<string, unknown>} */ (next)
        }
        cur[segments[segments.length - 1]] = value
    }


    /**
     * Recursively validate a config object against a schema definition.
     * Collects all errors and returns them as an array of descriptive strings.
     *
     * Schema format matches the existing CONFIG_SCHEMA structure in validators.
     *
     * @private
     * @param {Record<string, unknown>}             value  - Config subtree to validate
     * @param {Record<string, ConfigSchemaNode>}    schema - Schema for this level
     * @param {string}                              prefix - Dot-notation path prefix (e.g., "logger.file")
     * @returns {string[]} Array of error messages (empty if valid)
     */
    #validate(value, schema, prefix) {
        /** @type {string[]} */
        const errors = []

        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return errors
        }

        for (const [key, def] of Object.entries(schema)) {
            const fullPath = prefix ? `${prefix}.${key}` : key
            const isRequired = def.required === true
            const hasValue = key in value

            // Check required fields
            if (isRequired && !hasValue) {
                errors.push(`Missing required config key: "${fullPath}"`)
                continue
            }

            if (!hasValue) continue

            const actualValue = value[key]

            // Type checking (a schema may list several allowed types as an array)
            if (def.type && actualValue !== undefined) {
                const actualType = Array.isArray(actualValue) ? 'array' : typeof actualValue
                const allowedTypes = Array.isArray(def.type) ? def.type : [def.type]
                if (!allowedTypes.includes(actualType)) {
                    errors.push(
                        `Invalid type for "${fullPath}": expected ${allowedTypes.join(' | ')}, got ${actualType}`
                    )
                    continue
                }
            }

            // Enum validation
            if (def.enum && actualValue !== undefined && !def.enum.includes(actualValue)) {
                errors.push(
                    `Invalid value for "${fullPath}": expected one of [${def.enum.join(', ')}],`
                    + ` got "${String(actualValue)}"`
                )
            }

            // Recurse into nested objects
            if (def.properties
                && typeof actualValue === 'object'
                && actualValue !== null
                && !Array.isArray(actualValue)) {
                const nestedErrors = this.#validate(actualValue, def.properties, fullPath)
                errors.push(...nestedErrors)
            }

            // Validate array items
            if (def.items && Array.isArray(actualValue)) {
                for (let i = 0; i < actualValue.length; i++) {
                    const item = actualValue[i]
                    if (typeof item === 'object' && item !== null) {
                        const itemErrors = this.#validate(
                            item, def.items.properties || {}, `${fullPath}[${i}]`
                        )
                        errors.push(...itemErrors)
                    }
                }
            }
        }

        return errors
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Get a config value using dot notation.
     * @template T
     * @param {string} key       - Dot-separated key (e.g., "logger.file.max_size")
     * @param {T}      [defaultVal] - Fallback value if key doesn't exist
     * @returns {T | undefined}
     */
    get(key, defaultVal) {
        const val = this.#resolve(key)
        return val === undefined ? defaultVal : val
    }

    /**
     * Get an entire section of the configuration as a shallow copy.
     * @param {string} key - Dot-notation path to a nested object
     * @returns {Record<string, unknown>|undefined} Shallow copy of the section, or undefined
     */
    getSection(key) {
        const val = this.#resolve(key)
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            return { ...val }
        }
        return undefined
    }

    /**
     * Check whether a key exists in the configuration.
     * @param {string} key - Dot-separated key
     * @returns {boolean}
     */
    has(key) {
        return this.#resolve(key) !== undefined
    }

    /**
     * Return the full parsed config data as a deep-cloned plain object.
     * @returns {Record<string, unknown>}
     */
    toJSON() {
        return structuredClone(this.#data)
    }

    /**
     * Whether a validator was found and applied for this section.
     * @returns {boolean}
     */
    get hasValidator() {
        return this.#hasValidator
    }

    // -- Private helpers ----------------------------------------------------

    /**
     * Resolve a dot-notation key against the loaded config.
     * Supports nested traversal (e.g., "a.b.c") and returns undefined if any
     * intermediate segment is not a traversable object.
     * @param {string} key - Dot-separated key path
     * @returns {unknown|undefined}
     * @private
     */
    #resolve(key) {
        const parts = key.split('.')
        /** @type {unknown} */
        let cur = this.#data
        for (const part of parts) {
            if (cur == null || typeof cur !== 'object') return undefined
            cur = /** @type {Record<string, unknown>} */ (cur)[part]
        }
        return cur
    }
}

// Export ConfigBase class
export default ConfigBase