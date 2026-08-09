/**
 * TTS WeatherMan Automation.
 * Rule-based weather announcer that builds a speech message from a base sentence
 * and condition-matched additions, then routes through AI → TTS pipeline (or
 * direct TTS if AI unavailable). Supports {{ DeviceName.property }} string
 * interpolation for live sensor data in i18n strings.
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
import { fileURLToPath } from 'node:url'
import { parseDocument as yamlParseDocument } from 'yaml'

import RuleBasedAutomationBase from '../../src/automation/base/ruleBasedAutomationBase.js'
import DeviceContainer from '../../src/device/container/deviceContainer.js'
import EventBus from '../../src/service/eventBus.js'
import I18nLoader from '../../src/service/i18nLoader.js'
import AiAssistant from '../../src/ai/aiAssistant.js'
import ChatMessageOrigin from '../../src/enum/aiChatMessageOrigin.js'
import { PROJECT_ROOT } from '../../src/lib/projectRoot.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to this automation's YAML config file. */
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-weatherman.yaml')

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Fallback text when a device or property is not found during interpolation. */
const INTERPOLATION_MISSING = 'N/A'

/** Regex to match {{ DeviceName.property }} placeholders in i18n strings. */
const INTERPOLATION_REGEX = /\{\{\s*([\w\s]+?)\.([\w]+)\s*\}\}/g

/** Regex to match {% keyword %} special-function placeholders in i18n strings. */
const TIME_INTERPOLATION_REGEX = /\{%\s*(\w+)\s*%\}/g

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export default class TtsWeatherManAutomation extends RuleBasedAutomationBase {

    /** @type {Record<string, unknown>|null} Cached weatherman i18n bundle */
    #bundle = null

    constructor() {
        super({ name: 'TtsWeatherManAutomation', configPath: CONFIG_PATH })
    }

    async init() {
        await super.init()
        this.#bundle = this.#loadWeathermanBundle()
    }

    // -- Public API (override template method) ------------------------------

    /**
     * Custom execute that builds a speech message and sends it to TTS.
     * Overrides the parent's device-targeting flow entirely since this
     * automation has no device targets — only TTS output.
     *
     * @param {{trigger?: string}|null} [triggerData]
     */
    async execute(triggerData = null) {
        const triggerSource = triggerData?.trigger ?? 'unknown'
        this.log(`Triggered by: ${triggerSource}`, 'info')

        // Suppress execution during configured silent period (before any work begins)
        if (this.isInSilentPeriod()) {
            this.log(
                `Suppressed during silent period (${triggerSource})`,
                'debug'
            )
            return
        }

        // Reload bundle fresh each run (interpolation is runtime, not cached)
        this.#bundle = this.#loadWeathermanBundle()
        if (!this.#bundle) {
            this.log('No weatherman i18n bundle loaded, skipping', 'warn')
            return
        }

        // Build context for condition evaluation (reuses parent logic)
        let context
        try {
            context = await this.buildContext()
        } catch (error) {
            this.log(`Context build failed: ${error.message}`, 'warn')
            return
        }

        // Start with base sentence + interpolate sensor data
        const baseKey = this.config.sentence_base
        let baseText = this.#resolveI18n(baseKey, '')
        if (!baseText) {
            this.log(`Base sentence key "${baseKey}" not found in bundle`, 'warn')
            return
        }
        let message = this.#interpolate(baseText, context)

        // Evaluate rules and append matching sentences
        const rules = this.config.rules ?? []
        for (const rule of rules) {
            try {
                const match = await this.conditionsMatch(rule.conditions, context)
                if (match && rule.sentence) {
                    const ruleText = this.#resolveI18n(rule.sentence, '')
                    if (ruleText) {
                        const interpolated = this.#interpolate(ruleText, context)
                        message += ' ' + interpolated
                        this.log(`Rule matched: "${rule.name}" → appended sentence`, 'debug')
                    }
                }
            } catch (error) {
                this.log(`Error evaluating rule "${rule.name}": ${error.message}`, 'error')
            }
        }

        // Route output through AI→TTS or direct TTS
        await this.#speak(message)
    }

    /**
     * No device targets for this automation — returns empty Map so parent
     * execute() short-circuits gracefully. We override execute() entirely
     * but keep this for compatibility.
     * @returns {Map<string, never>}
     */
    loadDevices() {
        return new Map()
    }

    /**
     * Not used by ttsWeatherman (no device commands). Required abstract method.
     * @returns {null}
     */
    resolveCommand(_device, _targetKey, _matchingRules) {
        return null
    }

    // -- Private Helpers ----------------------------------------------------

    /**
     * Load the weatherman i18n bundle from etc/i18n/{locale}/weatherman.yaml.
     * Falls back to pl_PL if not found.
     * @returns {Record<string, unknown>|null}
     */
    #loadWeathermanBundle() {
        const locale = I18nLoader.getLanguage()
        const LOCALE_MAP = { pl: 'pl_PL', en: 'en_US' }
        const localeDir = LOCALE_MAP[locale] || 'pl_PL'
        const filePath = path.join(I18N_ROOT, localeDir, 'weatherman.yaml')

        try {
            if (!fs.existsSync(filePath)) {
                this.log(`Weatherman i18n file not found: ${filePath}`, 'warn')
                return null
            }
            const doc = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            const data = doc.contents?.toJSON()
            if (!data || typeof data !== 'object') {
                this.log(`Invalid weatherman i18n format in ${filePath}`, 'error')
                return null
            }
            return data
        } catch (error) {
            this.log(`Failed to load weatherman bundle: ${error.message}`, 'error')
            return null
        }
    }

    /**
     * Resolve a dotted i18n key against the loaded weatherman bundle.
     * Example: 'weatherman.hot_warning' → bundle['hot_warning']
     * The first segment ('weatherman') is stripped as the namespace prefix.
     * @param {string} key - Dot-separated key (e.g., "weatherman.base")
     * @param {*} fallback - Default value if key not found
     * @returns {*|null}
     */
    #resolveI18n(key, fallback) {
        if (!this.#bundle || !key) return fallback
        // Strip the namespace prefix (first segment before dot)
        const parts = key.split('.')
        if (parts.length < 2) return this.#bundle[key] ?? fallback
        // Skip first part (namespace), resolve rest
        let current = this.#bundle
        for (let i = 1; i < parts.length; i++) {
            if (current == null || typeof current !== 'object') return fallback
            current = current[parts[i]]
        }
        return current !== undefined ? current : fallback
    }

    /**
     * Replace {{ DeviceName.property }} placeholders with live sensor data,
     * and {% keyword %} placeholders with locale-aware values (e.g., {% time %}).
     * If device or property not found, replaces with INTERPOLATION_MISSING.
     * @param {string} text - Template string with placeholders
     * @param {Object} [_context] - Unused context param (kept for signature compat)
     * @returns {string} Text with all placeholders resolved
     */
    #interpolate(text, _context) {
        // First resolve special-function placeholders like {% time %}.
        let result = text.replace(TIME_INTERPOLATION_REGEX, (_match, keyword) => {
            switch (keyword) {
                case 'time': return I18nLoader.formatTime()
                default:     return `{% ${keyword} %}`   // unknown → pass through unchanged
            }
        })

        // Then resolve device-property placeholders
        return result.replace(INTERPOLATION_REGEX, (_match, deviceName, property) => {
            try {
                const trimmedName = deviceName.trim()
                const trimmedProp = property.trim()
                const device = DeviceContainer.findByName(trimmedName)
                if (!device) {
                    this.log(`Interpolation: device "${trimmedName}" not found`, 'debug')
                    return INTERPOLATION_MISSING
                }
                const state = device.getStateLast()
                if (!state || state[trimmedProp] === undefined || state[trimmedProp] === null) {
                    this.log(`Interpolation: property "${trimmedProp}" missing on "${trimmedName}"`, 'debug')
                    return INTERPOLATION_MISSING
                }
                // Format numbers using I18nLoader's locale-aware formatter
                if (typeof state[trimmedProp] === 'number') {
                    return I18nLoader.formatNumber(state[trimmedProp])
                }
                return String(state[trimmedProp])
            } catch (error) {
                this.log(`Interpolation error for "{{ ${deviceName}.${property} }}": ${error.message}`, 'warn')
                return INTERPOLATION_MISSING
            }
        })
    }

    /**
     * Send the built message to TTS, optionally routing through AI first.
     * @param {string} message - Final interpolated speech text
     */
    async #speak(message) {
        const trimmedMessage = message.trim()
        if (!trimmedMessage) {
            this.log('Empty message after building, skipping TTS', 'debug')
            return
        }

        this.log(`Sending weather update (${trimmedMessage.length} chars)`, 'info')

        // Build the full prompt BEFORE any emissions, so Window 3 sees exactly
        // what will be sent to the AI (including creative prefix when applicable).
        let displayText = trimmedMessage
        let aiPrompt = trimmedMessage

        if (AiAssistant.isAvailable()) {
            const aiPrefixKey = this.config.sentence_ai_prefix
            if (aiPrefixKey && this.#bundle) {
                const prefixText = this.#resolveI18n(aiPrefixKey, '')
                if (prefixText) {
                    aiPrompt = prefixText + '\n' + trimmedMessage
                    displayText = aiPrompt   // UI shows the full prompt including prefix
                }
            }
        }

        // Emit system input to UI with the actual text that goes into the LLM.
        // Guard against --no-ui runs where no subscribers exist.
        if (EventBus.hasSubscribers('ai:systemMessage')) {
            EventBus.emit('ai:systemMessage', { text: displayText })
        }

        if (AiAssistant.isAvailable()) {

            try {
                const response = await AiAssistant.processMessage(aiPrompt, {
                    origin: ChatMessageOrigin.SYSTEM
                })

                // Emit the AI's response back to UI for rendering with <AI> prefix.
                // Guard against --no-ui runs where no subscribers exist.
                if (response && EventBus.hasSubscribers('ai:periodicResponse')) {
                    EventBus.emit('ai:periodicResponse', { text: response })
                }

                this.log('Weather update sent via AI→TTS pipeline', 'debug')
            } catch (error) {
                this.log(`AI processing failed: ${error.message}`, 'error')
                // Fallback to direct TTS on AI failure
                EventBus.emit('tts:speak', { text: trimmedMessage })
            }
        } else {
            // Direct TTS when AI unavailable
            EventBus.emit('tts:speak', { text: trimmedMessage })
            this.log('Weather update sent via direct TTS', 'debug')
        }
    }
}