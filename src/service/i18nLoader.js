/**
 * I18n Loader -- Unified Internationalization & Formatting Configuration Manager.
 *
 * Loads etc/automaton.yaml which controls AI language (`ai_language`) and time format
 * (`time_format`) settings for consistent display across the entire UI (status bar,
 * log window, AI chat). Also loads the AI language bundle from
 * etc/ai/i18n/{lang}.yaml. Provides a singleton so all modules share the same
 * loaded configuration and bundle.
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

import ConfigService from './configService.js'
import LoggerService from './loggerService.js'
import { PROJECT_ROOT } from '../lib/projectRoot.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Default fallback language. */
const DEFAULT_LANGUAGE = 'pl'

/** Short-code → BCP 47 locale mapping (e.g., config "pl" → directory "pl_PL"). */
const LOCALE_MAP = { pl: 'pl_PL', en: 'en_US' }

/** Supported short-language codes as written in automaton.yaml ai_language. */
const SUPPORTED_LANGUAGES = Object.keys(LOCALE_MAP)

/** Valid time format values. */
const VALID_TIME_FORMATS = ['12h', '24h']

/** Default time format. */
const DEFAULT_TIME_FORMAT = '12h'

// ---------------------------------------------------------------------------
// I18nLoader (singleton)
// ---------------------------------------------------------------------------

/**
 * Loads and provides access to UI internationalization settings and the active
 * AI language bundle. ES module caching guarantees single instantiation.
 */
class SI18nLoader {

    /** @type {string} */ #language = DEFAULT_LANGUAGE
    /** @type {string} */ #timeFormat = DEFAULT_TIME_FORMAT
    /** @type {Record<string, unknown>|null} */ #bundle = null
    /** @type {boolean} */ #initialized = false

    // -- Public API -------------------------------------------------------

    /**
     * Load the i18n configuration and AI language bundle. Call once during
     * application startup.
     * @async
     */
    async init() {
        this.#loadConfig()
        await this.#loadBundle()
        this.#initialized = true
        LoggerService.debug(
            `i18n: ai_language='${this.#language}', time_format='${this.#timeFormat}'`,
            'I18nLoader'
        )
    }

    /**
     * Return the resolved AI language code (e.g., 'pl', 'en').
     * @returns {string}
     */
    getLanguage() {
        return this.#language
    }

    /**
     * Alias for getLanguage() -- used by consumers that expect "ai_language".
     * @returns {string}
     */
    getAiLanguage() {
        return this.#language
    }

    /**
     * Return the configured time display format.
     * @returns {'12h'|'24h'}
     */
    getTimeFormat() {
        return this.#timeFormat
    }

    /**
     * Check whether timestamps should use 12-hour (am/pm) format.
     * Convenience method for consumers that need a boolean.
     * @returns {boolean}
     */
    is12HourFormat() {
        return this.#timeFormat === '12h'
    }

    /**
     * Return the full loaded AI language bundle as a plain object.
     * @returns {Object}
     */
    getBundle() {
        return this.#bundle || {}
    }

    /**
     * Return the decimal separator for the active locale.
     * @returns {string} e.g., "," for pl_PL, "." for en_US
     */
    getDecimalSeparator() {
        return this.t('formatting.decimal_separator', '.')
    }

    /**
     * Format a numeric value using the active locale's decimal rules via Intl.NumberFormat.
     * Uses the BCP 47 locale mapped from the short language code.
     * Trailing zeros are stripped so e.g. "23,00" becomes "23" and "50,50" becomes "50,5".
     *
     * @param {number} value - The number to format
     * @param {number} [fractionDigits=2] - Maximum decimal precision
     * @returns {string} Formatted number string respecting locale conventions
     */
    formatNumber(value, fractionDigits = 2) {
        // Convert underscore to hyphen for BCP 47 compliance (pl_PL → pl-PL)
        const locale = (LOCALE_MAP[this.#language] || this.#language).replace('_', '-')
        try {
            let formatted = new Intl.NumberFormat(locale, {
                minimumFractionDigits: 0,
                maximumFractionDigits: fractionDigits
            }).format(value)

            // Strip trailing zeros after the decimal separator, then strip the separator itself if bare.
            // Handles both "," (Polish) and "." (English) decimal separators.
            formatted = formatted.replace(/([,.])0+($|\s+)/g, '$2')

            return formatted
        } catch {
            // Fallback if locale is unsupported by the runtime
            return String(value)
        }
    }

    /**
     * Format the current local time using the active locale and configured
     * time format (12h or 24h). Used by {% %} interpolation in i18n strings.
     *
     * Example output: "04:09" (24h) or "4:09 AM" (12h).
     *
     * @param {Date} [date] - Optional date; defaults to Date.now()
     * @returns {string} Formatted time string respecting locale and time_format config
     */
    formatTime(date = new Date()) {
        const locale = (LOCALE_MAP[this.#language] || this.#language).replace('_', '-')
        try {
            return new Intl.DateTimeFormat(locale, {
                hour: 'numeric',
                minute: '2-digit',
                hour12: this.is12HourFormat()
            }).format(date)
        } catch {
            // Fallback if locale is unsupported by the runtime
            return String(date.toLocaleTimeString())
        }
    }

    /**
     * Resolve a dotted key path against the loaded AI language bundle.
     * Example: t('sections.devices_header') → "=== DOSTĘPNE URZĄDZENIA ==="
     *
     * @param {string} key - Dot-separated key path
     * @param {string} [fallback] - Value returned if key not found
     * @returns {*} The resolved value or fallback
     */
    t(key, fallback = undefined) {
        if (!this.#bundle) return fallback

        const parts = key.split('.')
        let current = this.#bundle
        for (const part of parts) {
            if (current == null || typeof current !== 'object' || !(part in current)) {
                return fallback
            }
            current = current[part]
        }
        return current !== undefined ? current : fallback
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Load and parse etc/automaton.yaml to extract ai_language and time_format.
     * @private
     */
    #loadConfig() {
        try {
            // ConfigService is initialized early in main.js before LoggerService,
            // so it's guaranteed to be ready by the time I18nLoader.init() runs.
            const lang = ConfigService.get('ai_language')
            const tf   = ConfigService.get('time_format')

            // Parse ai_language
            if (lang && SUPPORTED_LANGUAGES.includes(String(lang).trim().toLowerCase())) {
                this.#language = String(lang).trim().toLowerCase()
            }

            // Parse time_format
            if (tf && VALID_TIME_FORMATS.includes(String(tf).trim())) {
                this.#timeFormat = String(tf).trim()
            }
        } catch (error) {
            LoggerService.error(
                `Failed to load i18n config: ${error.message}`,
                'I18nLoader'
            )
        }
    }

    /**
     * Resolve a short language code to its BCP 47 locale directory name.
     * Falls back to the input itself if no mapping exists (forward-compatible).
     * @param {string} lang - Short language code (e.g., "pl")
     * @returns {string} Locale directory name (e.g., "pl_PL")
     * @private
     */
    #resolveLocale(lang) {
        return LOCALE_MAP[lang] || lang
    }

    /**
     * Load the YAML bundle file for the determined language from the locale
     * subdirectory (e.g., etc/i18n/pl_PL/ai.yaml).
     * @async
     * @private
     */
    async #loadBundle() {
        const locale   = this.#resolveLocale(this.#language)
        const filePath = path.join(I18N_ROOT, locale, 'ai.yaml')

        try {
            if (!fs.existsSync(filePath)) {
                LoggerService.warn(
                    `AI i18n bundle not found: ${filePath} -- falling back to '${DEFAULT_LANGUAGE}'`,
                    'I18nLoader'
                )
                this.#language = DEFAULT_LANGUAGE
                const fallbackPath = path.join(I18N_ROOT, this.#resolveLocale(DEFAULT_LANGUAGE), 'ai.yaml')
                const doc = yamlParseDocument(fs.readFileSync(fallbackPath, 'utf8'))
                this.#bundle = doc.contents?.toJSON()
                return
            }

            const doc = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            this.#bundle = doc.contents?.toJSON() || {}
        } catch (error) {
            LoggerService.error(
                `Failed to load AI i18n bundle for '${this.#language}': ${error.message}`,
                'I18nLoader'
            )
            this.#bundle = {}
        }
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const I18nLoaderInstance = Object.freeze(new SI18nLoader())
export default I18nLoaderInstance
