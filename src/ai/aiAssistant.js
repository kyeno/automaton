/**
 * AI Assistant -- Main Orchestrator (Optimized for Prompt Caching).
 *
 * Manages conversation state, tool execution loops, and persistence of
 * chat history via CacheService. Emits device-interaction events through
 * EventBus so the UI can display real-time action messages.
 *
 * Language bundles are loaded via I18nLoader from etc/ai/i18n/{lang}.yaml,
 * making all AI-facing messages internationalizable.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from '../service/configService.js'
import CacheService  from '../service/cacheService.js'
import LoggerService from '../service/loggerService.js'
import EventBus      from '../service/eventBus.js'
import DeviceContainer from '../device/container/deviceContainer.js'
import OpenAiProvider from './providers/openaiProvider.js'
import ToolBuilder    from './toolBuilder.js'
import I18nLoader     from '../service/i18nLoader.js'
import ChatMessageOrigin from '../enum/aiChatMessageOrigin.js'
import { stripMarkdown } from '../lib/string.js'
import temporal from '../lib/date.js'

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/**
 * A single message in the AI conversation history.
 * Carries role, content, optional tool-call metadata, and an internal timestamp.
 *
 * @typedef {Object} ConversationMessage
 * @property {'system'|'user'|'assistant'|'tool'} role - Message role
 * @property {string} [content] - Text content (optional for assistant messages with tool_calls)
 * @property {Array<Object>} [tool_calls] - Tool call requests from the assistant
 * @property {string} [tool_call_id] - ID of the tool call this message responds to
 * @property {number} [_ts] - Internal epoch-millisecond timestamp (stripped before API calls)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis key for persisting conversation history. */
const CONVERSATION_KEY = 'ai:conversation:default'

/** Default TTL (in seconds) for cached conversation data. */
const DEFAULT_CONVERSATION_TTL_SEC = 900

/** Maximum number of messages to keep in conversation history. */
const DEFAULT_MAX_TURNS = 20

/** Safety limit for tool-call iterations per user message. */
const MAX_TOOL_ITERATIONS = 10

// ---------------------------------------------------------------------------
// SAiAssistant (singleton)
// ---------------------------------------------------------------------------

/**
 * Central orchestrator for AI-powered device control.
 *
 * Coordinates the LLM provider, manages conversation state, executes
 * tool calls returned by the model, and persists/restores chat history.
 */
class SAiAssistant {

    instance

    /** @type {OpenAiProvider|null} */ #provider = null
    /** @type {Array<ConversationMessage>} */ #messages = []
    /** @type {string} */ #systemPrompt = ''
    /** @type {number} */ #conversationTtlSec = DEFAULT_CONVERSATION_TTL_SEC
    /** @type {number} */ #maxTurns = DEFAULT_MAX_TURNS
    /** @type {boolean} */ #initialized = false

    // -- Singleton --------------------------------------------------------

    /**
     * Synchronous singleton constructor.
     * @returns {this}
     */
    constructor() {
        if (!SAiAssistant.instance) SAiAssistant.instance = this
        return SAiAssistant.instance
    }

    // -- Lifecycle --------------------------------------------------------

    /**
     * Load configuration, initialize the LLM provider, restore
     * conversation history, and mark the assistant as ready.
     * @async
     */
    async init() {
        this.#loadConfig()

        try {
            this.#provider = new OpenAiProvider()
            this.#provider.init()
        } catch (error) {
            LoggerService.warn(
                `AI provider not initialized (${error.message}) - AI features disabled`,
                'AiAssistant'
            )
            this.#provider = null
            this.#initialized = true
            return
        }

        // Initialize structures with static system prompt + live device definitions
        this.#messages = [
            { role: 'system', content: this.getEffectiveSystemPrompt() }
        ]

        await this.#restoreConversation()
        this.#initialized = true
    }

    // -- Public API -------------------------------------------------------

    /**
     * Check whether the AI assistant is fully initialized and usable.
     * @returns {boolean}
     */
    isAvailable() {
        return this.#initialized && this.#provider !== null
    }

    /**
     * Check whether an AI provider can be constructed, regardless of init state.
     * Mirrors OpenAiProvider requirements (API URL + model name); safe to call before
     * init(). Used by bootstrap and the UI to skip work entirely when unconfigured.
     * @returns {boolean}
     */
    isConfigured() {
        const apiUrl = process.env.AI_API_URL
        if (!apiUrl || !String(apiUrl).trim()) return false
        return Boolean(ConfigService.get('model'))
    }

     /**
      * Process a user message through the LLM, handling tool-call loops.
      *
      * Sends the conversation to the provider, executes any requested tools
      * up to {@link MAX_TOOL_ITERATIONS}, then persists state and returns
      * the final text response.
      *
      * @param {string} userInput - The user's input message.
      * @param {Object} [options] - Optional processing options.
      * @param {'user'|'system'} [options.origin='user'] - Message authorship origin (for UI rendering).
      * @param {Record<string, unknown>} [options.tts] - Extra TTS server parameters forwarded verbatim into the 'tts:speak' event payload for this reply (e.g., intro/outro jingle framing); omitted when absent or not an object.
      * @returns {Promise<string>} The assistant's textual reply.
      */
    async processMessage(userInput, options = {}) {
        if (!this.isAvailable()) {
            return '[AI is currently unavailable - check provider configuration.]'
        }

        const origin = options.origin || 'user'
        const isSystemOrigin = origin === ChatMessageOrigin.SYSTEM

        // Optional per-reply TTS passthrough params -- spread into every 'tts:speak' emission
        // below so callers can shape how their utterance sounds without touching the decoupled
        // TtsService directly. Non-object values degrade to no extras at all.
        const ttsOptions = (options.tts && typeof options.tts === 'object') ? options.tts : {}
        this.#messages.push({ role: 'user', content: userInput, _ts: Date.now(), _origin: origin })
        let iteration = 0

        while (iteration < MAX_TOOL_ITERATIONS) {
            iteration++

            // Returns the optimized, tiny static array (100% cache friendly)
            const tools = ToolBuilder.build()

            // Strip internal fields (_ts) before sending to AI provider
            const apiMessages = this.stripInternalFields(this.#messages)
            const assistantMsg = await this.#provider.chat(apiMessages, tools)
            this.#messages.push({ ...assistantMsg, _ts: Date.now(), _origin: origin })

            if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
                // Check if the model returned JSON instead of proper tool_calls -- catch models
                // that don't support native function calling but output structured JSON in text.
                // parseJsonIntent now returns an array of intents to handle multi-device responses.
                const jsonIntents = ToolBuilder.parseJsonIntent(assistantMsg.content)

                if (jsonIntents && jsonIntents.length > 0) {
                    LoggerService.warn(
                        `Model caught red-handed! Malformed tool calling detected (${jsonIntents.length} intent(s)) - returned JSON text instead of native tool_calls. Parsing anyway.`,
                        'AiAssistant'
                    )

                    // Execute all parsed intents and collect results
                    const results = []
                    for (const intent of jsonIntents) {
                        const result = await ToolBuilder.executeIntent(intent)
                        results.push(String(result))
                    }

                    // Record combined tool results in conversation so the AI sees them
                    this.#messages.push({
                        role: 'tool',
                        content: results.join('\n'),
                        _ts: Date.now(),
                        _origin: origin
                    })

                    // Continue loop so the AI can process the tool results and give natural response
                    continue
                }

                // Skip persistence for system-originated messages so periodic ticks
                // do not extend the conversation TTL or pollute cached history
                if (!isSystemOrigin) {
                    this.#trimConversation()
                    await this.#persistConversation()
                }
                let response = assistantMsg.content || ''

                // Conditionally strip markdown formatting and emoji from AI response
                response = this.#maybeStripFormatting(response)

                // Emit TTS event so the decoupled TtsService can speak the response;
                // caller-supplied TTS params travel along in the same payload.
                if (response) {
                    EventBus.emit('tts:speak', { text: response, ...ttsOptions })
                }

                return response
            }

            for (const toolCall of assistantMsg.tool_calls) {
                const result = await ToolBuilder.execute(toolCall)
                this.#messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: String(result),
                    _ts: Date.now(),
                    _origin: origin
                })
            }
        }

        let fallback = "I'm sorry, I encountered an issue while processing your request. Please try again."
        this.#messages.push({ role: 'assistant', content: fallback, _ts: Date.now(), _origin: origin })
        // Skip persistence for system-originated messages (same rationale as above)
        if (!isSystemOrigin) {
            this.#trimConversation()
            await this.#persistConversation()
        }
        fallback = this.#maybeStripFormatting(fallback)
        EventBus.emit('tts:speak', { text: fallback, ...ttsOptions })
        return fallback
    }

    /**
     * Clear the conversation history and reset to a fresh system prompt.
     */
    clearConversation() {
        this.#messages = [
            { role: 'system', content: this.getEffectiveSystemPrompt() }
        ]
        CacheService.delete(CONVERSATION_KEY).catch(() => {})
        LoggerService.info('Conversation cleared', 'AiAssistant')
    }

    /**
     * Return the number of non-system messages in the current conversation.
     * @returns {number}
     */
    getMessageCount() {
        return this.#messages.length - 1
    }

    /**
     * Return the non-system messages array for UI display purposes.
     * Messages include role ('user', 'assistant', 'tool') and content.
     * @returns {Array<Object>} Array of message objects
     */
    getConversationHistory() {
        return this.#messages.filter(m => m.role !== 'system')
    }

    /**
     * Return the full messages array including the system prompt.
     * Used by diagnostic/test tools to inspect the exact payload sent to the LLM.
     * @returns {Array<Object>} Full message array including system message
     */
    getMessages() {
        return this.#messages
    }

    /**
     * Inject a test user message into the conversation (for diagnostic scripts).
     * Does NOT trigger tool execution or persistence -- just appends the message.
     * @param {string} content - The user message text to inject.
     */
    injectUserMessage(content) {
        this.#messages.push({ role: 'user', content, _ts: Date.now() })
    }

    // -- Public API: System Prompt ----------------------------------------

    /**
     * Return the effective system prompt (base prompt + device list).
     * @returns {string} The full effective system prompt.
     */
    getEffectiveSystemPrompt() {
        const devices = DeviceContainer.getAll()
        const roles = this.#loadDeviceRoles()

        const devicesHeader = I18nLoader.t('sections.devices_header', '=== DEVICES ===')
        const deviceInstruction = I18nLoader.t('sections.device_instruction', '')

        // Build flat device list: mechanisms + sensors only.
        // Pure remotes are skipped (AI rarely interacts with them directly),
        // except for dual-purpose devices explicitly annotated in i18n.
        const allDevices = []

        for (const name of Object.keys(devices)) {
            if (name === 'bridge') continue

            const prefix = devices[name]?.getLogPrefix?.() || 'Mechanism'

            // Skip pure remotes unless they have an i18n annotation (dual-purpose devices)
            if (prefix === 'Remote' && !roles.has(name)) continue

            const role = roles.get(name) || ''
            const tag = role ? ` [${role}]` : ''
            allDevices.push(`- "${name}"${tag}`)
        }

        return `${this.#systemPrompt}\n\n${devicesHeader}\n${deviceInstruction}\n${allDevices.join('\n')}`
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Load device role annotations from the active i18n bundle.
     * Returns a flat map of deviceName -> role description string.
     *
     * @returns {Map<string, string>}
     * @private
     */
    #loadDeviceRoles() {
        const roles = new Map()
        try {
            const devices = I18nLoader.t('devices')
            if (!devices || typeof devices !== 'object') return roles

            for (const category of ['mechanism', 'sensor']) {
                const entries = devices?.[category]
                if (!entries || typeof entries !== 'object') continue
                for (const [devName, roleDesc] of Object.entries(entries)) {
                    roles.set(devName, String(roleDesc))
                }
            }
        } catch (error) {
            LoggerService.debug(`Failed to load device roles: ${error.message}`, 'AiAssistant')
        }
        return roles
    }

    /**
     * Load AI configuration from YAML file.
     * The system_prompt is loaded from the i18n bundle.
     * @private
     */
    #loadConfig() {
        try {
            this.#conversationTtlSec = this.#resolveConversationTtl()
            this.#maxTurns = ConfigService.get('max_conversation_turns', DEFAULT_MAX_TURNS)
            LoggerService.debug('Loaded AI config from ConfigService', 'AiAssistant')
        } catch (error) {
            LoggerService.warn(`Failed to load AI config (${error.message}), using defaults`, 'AiAssistant')
        }

        // System prompt from i18n bundle
        const i18nPrompt = I18nLoader.t('system_prompt')
        if (i18nPrompt && typeof i18nPrompt === 'string' && i18nPrompt.trim()) {
            this.#systemPrompt = i18nPrompt.trim()
        }
    }

    /**
     * Resolve conversation history TTL in whole seconds from main config.
     * Accepts legacy plain seconds or a human-readable duration ("15m", "900s")
     * parsed via temporal.humanToMs(); missing values silently fall back to
     * DEFAULT_CONVERSATION_TTL_SEC, present-but-invalid ones warn first (fail-open).
     * @private
     * @returns {number} TTL in whole seconds (> 0)
     */
    #resolveConversationTtl() {
        const raw = ConfigService.get('conversation_ttl_sec')
        if (raw == null) return DEFAULT_CONVERSATION_TTL_SEC
        let sec = null
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            sec = Math.round(raw)
        } else if (typeof raw === 'string') {
            const ms = temporal.humanToMs(raw)
            if (ms != null) sec = Math.round(ms / 1000)
        }
        if (sec == null || !(sec > 0)) {
            LoggerService.warn(
                `Invalid conversation_ttl_sec ${JSON.stringify(raw)} (expected e.g. "15m" or plain seconds); using default ${DEFAULT_CONVERSATION_TTL_SEC}s`,
                'AiAssistant'
            )
            return DEFAULT_CONVERSATION_TTL_SEC
        }
        return sec
    }

    /**
     * Strip internal fields (_ts, etc.) from messages before sending to AI provider.
     * Only keeps standard API fields: role, content, tool_calls, tool_call_id.
     *
     * @param {Array<Object>} msgs - Full message array with internal metadata
     * @returns {Array<Object>} Cleaned messages safe for LLM API
     */
    stripInternalFields(msgs) {
        return msgs.map(m => {
            const clean = {}
            if (m.role) clean.role = m.role
            if (m.content !== undefined) clean.content = m.content
            if (m.tool_calls) clean.tool_calls = m.tool_calls
            if (m.tool_call_id) clean.tool_call_id = m.tool_call_id
            return clean
        })
    }

    /**
     * Conditionally strip markdown formatting and emoji from an AI response.
     * No-ops when the feature is disabled via configuration.
     *
     * @param {string} text - The raw AI response text.
     * @returns {string} Cleaned text if strip_ai_formatting is true, otherwise unchanged.
     * @private
     */
    #maybeStripFormatting(text) {
        const shouldStrip = ConfigService.get('strip_ai_formatting', false)
        return shouldStrip ? stripMarkdown(text) : text
    }

    /**
     * Trim the conversation history to stay within {@link #maxTurns}.
     * Preserves the system prompt at index 0.
     * @private
     */
    #trimConversation() {
        if (this.#messages.length <= this.#maxTurns + 1) return
        const keep = this.#maxTurns
        const trimmed = [this.#messages[0], ...this.#messages.slice(-keep)]
        this.#messages = trimmed
    }

    /**
     * Persist non-system messages to CacheService with TTL.
     * Silently skips if cache is unavailable.
     * @private
     */
    async #persistConversation() {
        if (!CacheService.isConnected()) return
        try {
            // Exclude system-role messages AND system-origin conversation turns
            // so periodic ticks never pollute cached history
            const chatMessages = this.#messages.filter(
                m => m.role !== 'system' && m._origin !== ChatMessageOrigin.SYSTEM
            )
            await CacheService.set(CONVERSATION_KEY, chatMessages, this.#conversationTtlSec)
        } catch (error) {
            LoggerService.debug(`Failed to persist conversation: ${error.message}`, 'AiAssistant')
        }
    }

    /**
     * Restore conversation history from CacheService on startup.
     * Handles both native array and legacy JSON-string formats.
     * @private
     */
    async #restoreConversation() {
        if (!CacheService.isConnected()) return
        try {
            const data = await CacheService.get(CONVERSATION_KEY)
            if (data && Array.isArray(data)) {
                this.#messages = [
                    { role: 'system', content: this.getEffectiveSystemPrompt() },
                    ...data
                ]
                LoggerService.info(`Restored ${data.length} message(s) from conversation history`, 'AiAssistant')
                return
            }

            if (typeof data === 'string') {
                const parsed = JSON.parse(data)
                if (Array.isArray(parsed)) {
                    this.#messages = [
                        { role: 'system', content: this.getEffectiveSystemPrompt() },
                        ...parsed
                    ]
                    LoggerService.info(`Restored ${parsed.length} message(s) from conversation history`, 'AiAssistant')
                }
            }
        } catch (error) {
            LoggerService.debug(`No conversation to restore: ${error.message}`, 'AiAssistant')
        }
    }
}

// Singleton instance -- frozen to prevent mutation of the public API surface.
const AiAssistantInstance = new SAiAssistant()
Object.freeze(AiAssistantInstance)
export default AiAssistantInstance