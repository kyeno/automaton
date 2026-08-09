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
import { Colors } from '../../lib/terminal.js'
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
        const userPrefix = `${tsPrefix()} ${Colors.bold}${Colors.cyan}<you>${Colors.reset} `
        this.printMessage(trimmed, userPrefix)

        try {
            // Show typing indicator before waiting for response
            this.print(`${tsPrefix()} ${Colors.italic}${Colors.white}* AI is thinking...${Colors.reset}`)

            const response = await AiAssistant.processMessage(trimmed)

            // Emit activity for the status bar (AI response arrived)
            EventBus.emit('window:activity', this.#channelShortcut)

            // Print AI response using structured buffering
            const aiPrefix = `${tsPrefix()} ${Colors.bold}${Colors.magenta}<AI>${Colors.reset} `
            this.printMessage(response, aiPrefix)
        } catch (err) {
            this.print(`${tsPrefix()} ${Colors.bold}\x1b[31m<AI>${Colors.reset} \x1b[31m[ERROR: ${err.message}]${Colors.reset}`)
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
        this.#interactionUnsub = EventBus.subscribe('ai:deviceInteraction', ({ device, action, tool }) => {
            // Distinguish native tool_calls from parsed JSON intents
            const verb = (tool === 'json_intent') ? 'intended' : 'performed'
            const suffix = (tool === 'json_intent') ? ' (corrected)' : ''
            this.print(`${tsPrefix()} ${Colors.italic}${Colors.white}* AI ${verb} ${action} on ${device}${suffix}${Colors.reset}`)
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
            const sysPrefix = `${tsPrefix()} ${Colors.bold}\x1b[33m<system>${Colors.reset} `
            this.printMessage(text, sysPrefix)
            EventBus.emit('window:activity', this.#channelShortcut)
        })
    }

    /**
     * Subscribe to AI periodic responses and render them with <AI> prefix.
     * @private
     */
    #subscribeToPeriodicResponses() {
        this.#periodicResponseUnsub = EventBus.subscribe('ai:periodicResponse', ({ text }) => {
            const aiPrefix = `${tsPrefix()} ${Colors.bold}${Colors.magenta}<AI>${Colors.reset} `
            this.printMessage(text, aiPrefix)
            EventBus.emit('window:activity', this.#channelShortcut)
        })
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
        this.print(`${Colors.dim}-:-${Colors.reset} ${Colors.bold}${Colors.magenta}AI${Colors.reset} ${Colors.dim}[${Colors.bold}${Colors.cyan}${model}${Colors.reset}${Colors.dim}@${displayHost}]${Colors.reset} has joined ${this.#channelName}`)

        // Action: * AI is now online.
        this.print(`${tsPrefix()} ${Colors.italic}${Colors.white}* AI is now online.${Colors.reset}`)

        // Load conversation history from AiAssistant (restored from Redis on startup)
        const history = AiAssistant.getConversationHistory()

        if (history && history.length > 0) {
            this.#renderHistory(history)
        } else {
            // No history -- show default greeting from i18n bundle
            const greeting = I18nLoader.t('ui.default_greeting', 'Hello! How can I help you today?')
            this.printMessage(greeting, `${tsPrefix()} ${Colors.bold}${Colors.magenta}<AI>${Colors.reset} `)
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
                    this.printMessage(msg.content, `${ts} ${Colors.bold}\x1b[33m<system>${Colors.reset} `)
                } else {
                    this.printMessage(msg.content, `${ts} ${Colors.bold}${Colors.cyan}<you>${Colors.reset} `)
                }

            } else if (msg.role === 'assistant') {
                // Assistant message -- skip if it has tool_calls but no text content
                if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                    this.printMessage(msg.content, `${ts} ${Colors.bold}${Colors.magenta}<AI>${Colors.reset} `)
                }

            } else if (msg.role === 'tool') {
                // Tool result -- parse JSON and render as /me action line.
                // Cannot reliably distinguish json_intent from native tool calls in
                // restored history (both produce pretty-printed JSON with newlines),
                // so always show "performed" without "(corrected)" suffix.
                try {
                    const data = JSON.parse(msg.content)
                    const device = data.device || 'unknown'
                    let actionDesc = ''

                    if (data.action) {
                        actionDesc = `performed ${data.action} on ${device}`
                    } else if (data.state !== undefined) {
                        actionDesc = 'checked state of ' + device
                    } else {
                        actionDesc = `interacted with ${device}`
                    }

                    this.print(`${ts} ${Colors.italic}${Colors.white}* AI ${actionDesc}${Colors.reset}`)
                } catch {
                    // Not valid JSON -- just show a generic tool message
                    this.print(`${ts} ${Colors.italic}${Colors.white}* AI performed an action${Colors.reset}`)
                }
            }
        }
    }
}

export default AiWindow