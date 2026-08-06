/**
 * AI Periodic Service -- Timer-based periodic messenger for the AI assistant.
 *
 * Sends a localized prompt to the AI at regular intervals, triggering the full
 * processing flow: tool execution → AI response → TTS (if enabled). In the UI,
 * these trigger messages appear with a yellow `<system>` prefix instead of `<you>`.
 *
 * Configuration (etc/automaton.yaml):
 *   ai_periodic_message:
 *     interval_ms: 900000  # 15 minutes (set to 0 to disable)
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from './configService.js'
import EventBus      from './eventBus.js'
import LoggerService from './loggerService.js'
import I18nLoader    from './i18nLoader.js'
import AiAssistant   from '../ai/aiAssistant.js'
import ChatMessageOrigin from '../enum/aiChatMessageOrigin.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timer interval: 15 minutes in milliseconds. */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1_000

/** Log context label used throughout this service. */
const CONTEXT = 'AiPeriodicService'

// ---------------------------------------------------------------------------
// SAiPeriodicService (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * Stateless, timer-driven periodic messenger for the AI assistant.
 *
 * On init, reads `ai_periodic_message.interval_ms` from config. If greater than
 * zero and AI is available, starts a periodic timer that sends localized prompts.
 * ES module caching guarantees single instantiation.
 */
class SAiPeriodicService {

    /** @type {NodeJS.Timeout|null} */ #timer = null
    /** @type {boolean} */             #enabled = false
    /** @type {number} */              #intervalMs = 0

    // -- Lifecycle --------------------------------------------------------

    /**
     * Initialize the AI Periodic Service. Call once during application startup.
     * Reads configuration, logs diagnostic info, and starts the timer if enabled.
     */
    init() {
        const rawInterval = ConfigService.get('ai_periodic_message.interval_ms', DEFAULT_INTERVAL_MS)
        this.#intervalMs = typeof rawInterval === 'number' ? rawInterval : DEFAULT_INTERVAL_MS

        // Diagnostic logging - always visible on startup
        LoggerService.info(
            `AI Periodic Messenger initializing`,
            CONTEXT
        )
        LoggerService.debug(
            `  Timer interval: ${this.#intervalMs > 0 ? `${Math.round(this.#intervalMs / 1000)}s (${Math.round(this.#intervalMs / 60_000)}min)` : 'DISABLED (interval_ms: 0)'}`,
            CONTEXT
        )
        LoggerService.debug(
            `  AI available: ${AiAssistant.isAvailable() ? 'yes' : 'no'}`,
            CONTEXT
        )

        // Verify i18n message is configured
        const testMessage = I18nLoader.t('periodic.message')
        if (testMessage && typeof testMessage === 'string' && testMessage.trim()) {
            LoggerService.debug(
                `  i18n message loaded: "${testMessage.substring(0, 60)}${testMessage.length > 60 ? '...' : ''}"`,
                CONTEXT
            )
        } else {
            LoggerService.warn(
                '  i18n periodic.message not found or empty - timer will skip execution',
                CONTEXT
            )
        }

        if (this.#intervalMs <= 0) {
            this.#enabled = false
            LoggerService.info(
                `AI Periodic Messenger DISABLED (interval_ms set to 0)`,
                CONTEXT
            )
            return
        }

        if (!AiAssistant.isAvailable()) {
            this.#enabled = false
            LoggerService.warn(
                `AI Periodic Messenger DISABLED (AI assistant not available)`,
                CONTEXT
            )
            return
        }

        // Start the periodic timer
        this.#startTimer()
        this.#enabled = true

        LoggerService.info(
            `AI Periodic Messenger ENABLED (every ${Math.round(this.#intervalMs / 1000)}s)`,
            CONTEXT
        )
    }

    // -- Public API -------------------------------------------------------

    /**
     * Check whether the service is active and running.
     * @returns {boolean}
     */
    isEnabled() {
        return this.#enabled
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Start the periodic timer that sends messages to AI on each tick.
     * @private
     */
    #startTimer() {
        const _tick = async () => {
            try {
                await this.#tick()
            } catch (error) {
                LoggerService.error(`Tick error: ${error.message}`, CONTEXT)
            }
        }

        this.#timer = setInterval(_tick, this.#intervalMs)
    }

    /**
     * Execute one timer tick: load i18n message, emit system event for UI,
     * then send through full AI processing pipeline.
     * @private
     */
    async #tick() {
        // Skip if AI became unavailable since init
        if (!AiAssistant.isAvailable()) {
            LoggerService.debug('AI unavailable, skipping periodic message', CONTEXT)
            return
        }

        // Load the localized periodic message from i18n bundle
        const message = I18nLoader.t('periodic.message')
        if (!message || typeof message !== 'string' || !message.trim()) {
            LoggerService.warn('No periodic message configured in i18n bundle, skipping', CONTEXT)
            return
        }

        const trimmedMessage = message.trim()

        LoggerService.info(
            `Sending periodic message to AI`,
            CONTEXT
        )

        // Emit to UI so the message renders as <system> before AI processes it.
        // Guard against --no-ui runs where no subscribers exist.
        if (EventBus.hasSubscribers('ai:systemMessage')) {
            EventBus.emit('ai:systemMessage', { text: trimmedMessage })
        }

        // Send through the full AI processing pipeline with SYSTEM origin:
        // processMessage → tool execution → AI response → TTS (if enabled)
        const response = await AiAssistant.processMessage(trimmedMessage, {
            origin: ChatMessageOrigin.SYSTEM
        })

        // Emit the AI's response back to the UI for rendering with <AI> prefix.
        // Guard against --no-ui runs where no subscribers exist.
        if (response && EventBus.hasSubscribers('ai:periodicResponse')) {
            EventBus.emit('ai:periodicResponse', { text: response })
        }
    }

    /**
     * Stop the timer and clean up resources during shutdown.
     */
    cleanup() {
        if (this.#timer) {
            clearInterval(this.#timer)
            this.#timer = null
            LoggerService.debug('Timer stopped', CONTEXT)
        }
        this.#enabled = false
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const AiPeriodicService = Object.freeze(new SAiPeriodicService())
export default AiPeriodicService