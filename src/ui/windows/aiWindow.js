/**
 * AI Chat Window -- Window 3.
 *
 * Passive display of conversation history with the AI assistant.
 * Extends BaseWindow for consistent buffering and rendering.
 * Styled after classic BitchX/IRC clients.
 *
 * Dependencies: receives `term` and `layout` via constructor.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from '../../service/configService.js'
import EventBus from '../../service/eventBus.js'
import AiAssistant from '../../ai/aiAssistant.js'
import I18nLoader from '../../service/i18nLoader.js'
import { tsPrefix } from '../../lib/terminal.js'
import AnsiColors from '../../enum/ansiColors.js'
import BaseWindow from './baseWindow.js'
import ChatMessageOrigin from '../../enum/aiChatMessageOrigin.js'

/**
 * AI Chat Window displayed in the terminal UI.
 * Shows conversation history with the AI assistant in IRC-style formatting
 * and supports submitting chat messages via the input component.
 */
class AiWindow extends BaseWindow {
    // AI window treats input as chat messages (no log, no slash-command auto-prefix)
    static inputMode = 'chat'

    #welcomeShown = false
    #interactionUnsub = null
    #systemMessageUnsub = null
    #periodicResponseUnsub = null
    #channelShortcut
    #channelName

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new AiWindow instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     * @param {number} channelShortcut - Numeric shortcut from channel config
     * @param {string} channelName - IRC-style channel name (e.g., "#automaton")
     */
    constructor(term, layout, channelShortcut = 3, channelName = '#automaton') {
        super('AI Assistant', term, layout, channelShortcut)
        this.#channelShortcut = channelShortcut
        this.#channelName = channelName
        this.#subscribeToInteractions()
        this.#subscribeToSystemMessages()
        this.#subscribeToPeriodicResponses()
    }

    // -- Public API -------------------------------------------------------

    /**
     * Override show() to emit a welcome message on first display.
     */
    show() {
        super.show()
        if (!this.#welcomeShown) {
            this.#welcomeShown = true
            // Only show welcome/join sequence if no pre-existing content
            // (e.g., from tts-weatherman firing while another window was active).
            // Otherwise the welcome would appear after real conversation content.
            if (this.isEmpty) {
                this.#showWelcome()
            }
        }
    }

    /**
     * Send a message to the AI and print the exchange in IRC style.
     * Emits activity so the status bar can track it.
     *
     * @param {string} text - User's message to send to the AI
     */
    async submitMessage(text) {
        const trimmed = (text || '').trim()
        if (!trimmed) return

        // Print user message using structured buffering so it re-wraps on resize
        const userPrefix = `${tsPrefix()} ${AnsiColors.bold}${AnsiColors.cyan}<you>${AnsiColors.reset} `
        this.printMessage(trimmed, userPrefix)

        try {
            // Show typing indicator before waiting for response
            this.print(`${tsPrefix()} ${AnsiColors.italic}${AnsiColors.white}* AI is thinking...${AnsiColors.reset}`)

            const response = await AiAssistant.processMessage(trimmed)

            // Emit activity for the status bar (AI response arrived)
            EventBus.emit('window:activity', this.#channelShortcut)

            // Print AI response using structured buffering
            const aiPrefix = `${tsPrefix()} ${AnsiColors.bold}${AnsiColors.magenta}<AI>${AnsiColors.reset} `
            this.printMessage(response, aiPrefix)
        } catch (err) {
            this.print(`${tsPrefix()} ${AnsiColors.bold}${AnsiColors.red}<AI>${AnsiColors.reset} ${AnsiColors.red}[ERROR: ${err.message}]${AnsiColors.reset}`)
        }
    }

    /**
     * Destroy this window: unsubscribe from events, hide, and clear buffer.
     */
    destroy() {
        if (this.#interactionUnsub) {
            this.#interactionUnsub()
            this.#interactionUnsub = null
        }
        if (this.#systemMessageUnsub) {
            this.#systemMessageUnsub()
            this.#systemMessageUnsub = null
        }
        if (this.#periodicResponseUnsub) {
            this.#periodicResponseUnsub()
            this.#periodicResponseUnsub = null
        }
        this.hide()
        this.clear()
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Subscribe to AI device interaction events and render IRC-style /me messages.
     * @private
     */
    #subscribeToInteractions() {
        this.#interactionUnsub = EventBus.subscribe('ai:deviceInteraction', ({ device, action, tool, ok = true }) => {
            // Distinguish native tool_calls from parsed JSON intents
            const verb = (tool === 'json_intent') ? 'intended' : 'performed'
            const suffix = (tool === 'json_intent') ? ' (corrected)' : ''
            let messageText
            if (!ok) {
                // Failed attempt (e.g., unknown device name) -- keep it visible in chat instead of
                // letting the error vanish into logs only. Wording mirrors the history renderer.
                const target = (action && String(action).toUpperCase() !== 'STATE')
                    ? `${String(action).toLowerCase()} ${device}`
                    : `interact with ${device}`
                messageText = `* AI could not ${target}${suffix}`
            } else if (action == null || String(action).toUpperCase() === 'STATE') {
                // Align with history renderer wording: "checked state of <device>"
                messageText = `* AI checked state of ${device}`
            } else {
                messageText = `* AI ${verb} ${action} on ${device}${suffix}`
            }
            this.print(`${tsPrefix()} ${AnsiColors.italic}${AnsiColors.white}${messageText}${AnsiColors.reset}`)
            EventBus.emit('window:activity', this.#channelShortcut)
        })
    }

    /**
     * Subscribe to system messages emitted by the AI Periodic Service.
     * Renders them with a distinct <system> prefix (yellow color).
     * @private
     */
    #subscribeToSystemMessages() {
        this.#systemMessageUnsub = EventBus.subscribe('ai:systemMessage', ({ text }) => {
            this.printMessage(text, this.#buildSystemPrefix(tsPrefix()))
            EventBus.emit('window:activity', this.#channelShortcut)
        })
    }

    /**
     * Subscribe to AI periodic responses and render them with <AI> prefix.
     * @private
     */
    #subscribeToPeriodicResponses() {
        this.#periodicResponseUnsub = EventBus.subscribe('ai:periodicResponse', ({ text }) => {
            const aiPrefix = `${tsPrefix()} ${AnsiColors.bold}${AnsiColors.magenta}<AI>${AnsiColors.reset} `
            this.printMessage(text, aiPrefix)
            EventBus.emit('window:activity', this.#channelShortcut)
        })
    }

    /**
     * Build the IRC-style <system> message prefix (bold yellow).
     * Shared by live system messages and restored history rendering so the
     * two paths cannot drift apart visually.
     * @param {string} ts - Timestamp prefix string (from tsPrefix)
     * @returns {string} Formatted prefix ending with a trailing space
     * @private
     */
    #buildSystemPrefix(ts) {
        return `${ts} ${AnsiColors.bold}${AnsiColors.yellow}<system>${AnsiColors.reset} `
    }

    /**
     * Display a BitchX/IRC-style welcome sequence when the window first opens:
     *   -:- AI [gpt-4o@localhost:11434] has joined #automaton
     *   * AI is now online.
     * Then either render cached conversation history or show default greeting.
     * @private
     */
    #showWelcome() {
        // Model name loaded from ConfigService instead of direct YAML read
        const model = ConfigService.get('model', 'unknown')
        let host = process.env['AI_API_URL'] || ''

        // Strip protocol and trailing path segments (/v1, etc.)
        try {
            const url = new URL(host)
            host = url.host
        } catch {
            // Not a valid URL -- keep as-is (might already be just a hostname)
        }

        const displayHost = host || 'unknown'

        // IRC-style join line: "-:- AI [<model>@<host>] has joined <channel>"
        this.print(`${AnsiColors.dim}-:-${AnsiColors.reset} ${AnsiColors.bold}${AnsiColors.magenta}AI${AnsiColors.reset} ${AnsiColors.dim}[${AnsiColors.bold}${AnsiColors.cyan}${model}${AnsiColors.reset}${AnsiColors.dim}@${displayHost}]${AnsiColors.reset} has joined ${this.#channelName}`)

        // Action: * AI is now online.
        this.print(`${tsPrefix()} ${AnsiColors.italic}${AnsiColors.white}* AI is now online.${AnsiColors.reset}`)

        // Load conversation history from AiAssistant (restored from Redis on startup)
        const history = AiAssistant.getConversationHistory()

        if (history && history.length > 0) {
            this.#renderHistory(history)
        } else {
            // No history -- show default greeting from i18n bundle
            const greeting = I18nLoader.t('ui.default_greeting', 'Hello! How can I help you today?')
            this.printMessage(greeting, `${tsPrefix()} ${AnsiColors.bold}${AnsiColors.magenta}<AI>${AnsiColors.reset} `)
        }
    }

    /**
     * Render cached conversation history messages in IRC style.
     *   - user role      -> [HH:mm:ss] <you> message
     *   - assistant role -> [HH:mm:ss] <AI> response  (skip if only tool_calls, no content)
     *   - tool role      -> [HH:mm:ss] * AI performed <action> on <device>  (/me style)
     * Uses stored _ts timestamps when available, falls back to current time.
     * @param {Array<Object>} history
     * @private
     */
    #renderHistory(history) {
        for (const msg of history) {
            const ts = tsPrefix(msg._ts)

            if (msg.role === 'user') {
                // User message: check _origin to determine prefix
                const isSystem = msg._origin === ChatMessageOrigin.SYSTEM
                if (isSystem) {
                    this.printMessage(msg.content, this.#buildSystemPrefix(ts))
                } else {
                    this.printMessage(msg.content, `${ts} ${AnsiColors.bold}${AnsiColors.cyan}<you>${AnsiColors.reset} `)
                }

            } else if (msg.role === 'assistant') {
                // Assistant message -- skip if it has tool_calls but no text content
                if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                    this.printMessage(msg.content, `${ts} ${AnsiColors.bold}${AnsiColors.magenta}<AI>${AnsiColors.reset} `)
                }

            } else if (msg.role === 'tool') {
                // Tool result(s) -- render each as a /me action line. Legacy entries may hold
                // several concatenated JSON documents in one message; parse them individually so
                // every attempt stays visible instead of collapsing into one generic line.
                const results = this.#extractToolResults(msg.content)

                if (results.length === 0) {
                    // Not valid JSON at all -- just show a generic tool message
                    this.print(`${ts} ${AnsiColors.italic}${AnsiColors.white}* AI performed an action${AnsiColors.reset}`)
                    continue
                }

                for (const data of results) {
                    let device = data.device || null
                    // Legacy error payloads carry the attempted name only inside the message text
                    if (!device && data.error) {
                        const m = String(data.error).match(/Device "([^"]+)"/)
                        if (m) device = m[1]
                    }
                    let actionDesc

                    if (data.error) {
                        // Failed attempt (e.g., unknown device name) -- keep it visible instead of
                        // hiding behind "interacted with unknown". Wording mirrors the live handler.
                        actionDesc = !device ? 'could not interact with a device'
                            : (data.action && String(data.action).toUpperCase() !== 'STATE')
                                ? `could not ${String(data.action).toLowerCase()} ${device}`
                                : `could not interact with ${device}`
                    } else if (data.action) {
                        actionDesc = `performed ${data.action} on ${device || 'unknown'}`
                    } else if (data.state !== undefined) {
                        actionDesc = `checked state of ${device || 'unknown'}`
                    } else {
                        actionDesc = `interacted with ${device || 'unknown'}`
                    }

                    this.print(`${ts} ${AnsiColors.italic}${AnsiColors.white}* AI ${actionDesc}${AnsiColors.reset}`)
                }
            }
        }
    }

    /**
     * Parse stored tool-result content into individual result objects. Handles both single JSON
     * documents and legacy entries where several documents were concatenated in one message;
     * unparseable fragments are skipped so partial garbage never blanks an entire line.
     * @param {*} content - Raw tool message content
     * @returns {Array<Object>} Parsed result objects (may be empty when nothing was recoverable)
     * @private
     */
    #extractToolResults(content) {
        const found = []
        const text = typeof content === 'string' ? content : ''

        try {
            const whole = JSON.parse(text)
            if (whole && typeof whole === 'object') found.push(whole)
            return found
        } catch {
            // Fall through to per-block extraction below
        }

        for (const match of text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)) {
            try {
                const parsed = JSON.parse(match[0])
                if (parsed && typeof parsed === 'object') found.push(parsed)
            } catch {
                continue
            }
        }
        return found
    }
}

export default AiWindow