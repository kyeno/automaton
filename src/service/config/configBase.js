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

        this.#load()
    }

    // -- Private properties -------------------------------------------------

    /** @type {string} */ #filePath
    /** @type {string} */ #sectionName
    /** @type {Record<string, unknown>} */ #data
    /** @type {boolean} */ #hasValidator

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

        // Attempt to load optional validator
        this.#tryLoadValidator()
    }

    /**
     * Try to discover and apply a validator from src/validators/.
     * Validators are optional - missing validators do NOT cause errors.
     * @private
     */
    async #tryLoadValidator() {
        const validatorPath = path.join(
            PROJECT_ROOT, 'src', 'validators', `${this.#sectionName}.js`
        )

        if (!fs.existsSync(validatorPath)) {
            this.#hasValidator = false
            return
        }

        try {
            /* v8 ignore next 2 */
            const mod = await import(validatorPath)
            /** @type {Record<string, ConfigSchemaNode>} */
            const schema = mod.default ?? mod

            if (schema && typeof schema === 'object') {
                const errors = this.#validate(this.#data, schema, '')
                // Import LoggerService dynamically to avoid circular deps at init time
                const { default: LoggerService } = await import('../loggerService.js')
                if (errors.length > 0) {
                    for (const err of errors) {
                        LoggerService.warn?.(`Config validation [${this.#sectionName}]: ${err}`, 'ConfigBase')
                    }
                } else {
                    LoggerService.debug?.(
                        `Config "${this.#filePath}" validated OK (${Object.keys(this.#data).length} top-level keys)`,
                        'ConfigBase'
                    )
                }
                this.#hasValidator = true
            } else {
                this.#hasValidator = false
            }
        } catch {
            // Validator load failure is non-fatal - just skip validation
            this.#hasValidator = false
        }
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