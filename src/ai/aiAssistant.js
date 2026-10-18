/**
 * AI Assistant -- Main Orchestrator (Optimized for Prompt Caching).
 * Manages conversation state, tool execution loops.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from '../service/configService.js'
import CacheService  from '../service/cacheService.js'
import LoggerService from '../service/loggerService.js'
import EventBus      from '../service/eventBus.js'
import StateService  from '../service/stateService.js'
import DeviceContainer from '../device/container/deviceContainer.js'
import OpenAiProvider from './providers/openaiProvider.js'
import ToolBuilder    from './toolBuilder.js'
import I18nLoader     from '../service/i18nLoader.js'
import ChatMessageOrigin from '../enum/aiChatMessageOrigin.js'
import { stripMarkdown, interpolateTokens } from '../lib/string.js'
import temporal from '../lib/date.js'

//  Type Definitions.

/** A single message in the AI conversation history.
 * @typedef {Object} ConversationMessage
 * @property {'system'|'user'|'assistant'|'tool'} role - Message role
 * @property {string} [content] - Text content (optional for assistant messages with tool_calls)
 * @property {Array<Object>} [tool_calls] - Tool call requests from the assistant
 * @property {string} [tool_call_id] - ID of the tool call this message responds to
 * @property {number} [_ts] - Internal epoch-millisecond timestamp (stripped before API calls) */


/** Redis key for persisting conversation history. */
const CONVERSATION_KEY = 'ai:conversation:default'

/** Default TTL (in seconds) for cached conversation data. */
const DEFAULT_CONVERSATION_TTL_SEC = 900

/** Maximum number of messages to keep in conversation history. */
const DEFAULT_MAX_TURNS = 20

/** Safety limit for tool-call iterations per user message. */
const MAX_TOOL_ITERATIONS = 10

/** Name the assistant reports when `ai.name` is unset or blank. Kept deliberately */
const DEFAULT_ASSISTANT_NAME = 'AI'

//  SAiAssistant (singleton)

/** Central orchestrator for AI-powered device control. */
class SAiAssistant {

    instance

    /** @type {OpenAiProvider|null} */ #provider = null
    /** @type {Array<ConversationMessage>} */ #messages = []
    /** @type {string} */ #systemPrompt = ''
    /** @type {number} */ #conversationTtlSec = DEFAULT_CONVERSATION_TTL_SEC
    /** @type {number} */ #maxTurns = DEFAULT_MAX_TURNS
    /** @type {boolean} */ #initialized = false

    /** FIFO chain of in-flight turns -- processMessage() appends each turn here so
     * @type {Promise<unknown>} */
    #queue = Promise.resolve()

    /** Number of turns currently holding the FIFO lock; drives the ai.busy shared state. */
    #busyCount = 0

    /** Epoch ms when the current busy streak began (null while idle); kept on deactivation so observers can report elapsed time. */
    #busySince = null


    /** Synchronous singleton constructor.
     * @returns {this} */
    constructor() {
        if (!SAiAssistant.instance) SAiAssistant.instance = this
        return SAiAssistant.instance
    }

    //  -- Lifecycle --------------------------------------------------------

    /** Load configuration, initialize the LLM provider, restore
     * @async */
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

        //  Initialize structures with static system prompt + live device definitions.
        this.#messages = [
            { role: 'system', content: this.getEffectiveSystemPrompt() }
        ]

        await this.#restoreConversation()
        this.#initialized = true
    }

    //  -- Public API -------------------------------------------------------

    /** Check whether the AI assistant is fully initialized and usable.
     * @returns {boolean} */
    isAvailable() {
        return this.#initialized && this.#provider !== null
    }

    /** Whether init() has completed at all (with or without a working provider) -- gate
     * @returns {boolean} */
    isReady() {
        return this.#initialized
    }

    /** Reset the conversation to a fresh system-prompt state and drop any cached history.
     * @async
     * @returns {Promise<{reset:boolean, dropped:number}>} How much live state was cleared */
    async resetConversation() {
        if (!this.#initialized) return { reset: false, dropped: 0 }

        const hadProvider = this.#provider !== null
        const dropped = Math.max(0, this.#messages.length - 1)

        //  Re-read ai.* now that ConfigService holds the freshly reloaded values.
        this.#loadConfig()
        if (hadProvider) this.#reinitProvider()   // picks up new model / max_tokens / temperature

        this.clearConversation()                  // fresh system prompt + cache key drop

        LoggerService.info(
            `AI conversation reset (${dropped} message(s) cleared from context)`,
            'AiAssistant'
        )
        return { reset: true, dropped }
    }

    /** Construct and validate a fresh LLM provider against current config. Mirrors the
     * @private */
    #reinitProvider() {
        try {
            this.#provider = new OpenAiProvider()
            this.#provider.init()
        } catch (error) {
            LoggerService.warn(
                `AI provider not initialized (${error.message}) - AI features disabled`,
                'AiAssistant'
            )
            this.#provider = null
        }
    }

    /** Check whether an AI provider can be constructed, regardless of init state.
     * @returns {boolean} */
    isConfigured() {
        const apiUrl = process.env.AI_API_URL
        if (!apiUrl || !String(apiUrl).trim()) return false
        return Boolean(ConfigService.get('ai.model'))
    }

     /** Process a user message through the LLM, handling tool-call loops.
      * @param {string} userInput - The user's input message.
      * @param {Object} [options] - Optional processing options.
      * @param {'user'|'system'} [options.origin='user'] - Message authorship origin (for UI rendering).
      * @param {Record<string, unknown>} [options.tts] - Extra TTS server parameters forwarded verbatim into the 'tts:speak' event payload for this reply (e.g., intro/outro jingle framing); omitted when absent or not an object.
      * @returns {Promise<string>} The assistant's textual reply. */
    processMessage(userInput, options = {}) {
        if (!this.isAvailable()) {
            return Promise.resolve('[AI is currently unavailable - check provider configuration.]')
        }

        const run = () => {
            this.#setAiBusy(true)
            return this.#runTurnIsolated(userInput, options).finally(() => this.#setAiBusy(false))
        }
        const next = this.#queue.then(run, run)
        this.#queue = next.catch(() => {})   // keep the internal chain alive regardless of outcome
        return next
    }

    /** Update the shared `ai.busy` state while turns hold the FIFO lock.
     * @param {boolean} active - true when a turn starts holding the lock, false when it releases it
     * @private */
    #setAiBusy(active) {
        if (active) {
            if (this.#busyCount === 0) this.#busySince = Date.now()
            this.#busyCount += 1
            StateService.set('ai.busy', { active: true, since: this.#busySince })
        } else {
            this.#busyCount = Math.max(0, this.#busyCount - 1)
            if (this.#busyCount === 0) {
                StateService.set('ai.busy', { active: false, since: this.#busySince })
                this.#busySince = null
            }
        }
    }

    /** Whether system-origin turns include accumulated chat history in their LLM request.
     * @returns {boolean} true only when the flag is explicitly enabled */
    systemCallsIncludeChatHistory() {
        return ConfigService.get('ai.include_chat_history_in_system_calls', false) === true
    }

    /** Run one turn with system-origin isolation: user-origin turns execute directly.
     * @private
     * @param {string} userInput - The user's input message.
     * @param {Object} [options] - Optional processing options (see processMessage()).
     * @returns {Promise<string>} The assistant's textual reply. */
    async #runTurnIsolated(userInput, options = {}) {
        const origin = options.origin || 'user'
        if (origin !== ChatMessageOrigin.SYSTEM) {
            return await this.#executeTurn(userInput, options)
        }

        //  Standalone mode (default): the model sees only the freshly built system prompt.
        if (!this.systemCallsIncludeChatHistory()) {
            const savedMessages = this.#messages
            this.#messages = [{ role: 'system', content: this.getEffectiveSystemPrompt() }]
            try {
                return await this.#executeTurn(userInput, options)
            } finally {
                this.#messages = savedMessages
            }
        }

        //  Context-aware mode: full history visible to the turn; snapshot where the shared.
        const restoreAt = this.#messages.length
        try {
            return await this.#executeTurn(userInput, options)
        } finally {
            this.#messages.length = restoreAt
        }
    }

    /** Execute one full AI turn against the shared conversation -- the actual.
     * @private
     * @param {string} userInput - The user's input message.
     * @param {Object} [options] - Optional processing options (see processMessage()).
     * @returns {Promise<string>} The assistant's textual reply. */
    async #executeTurn(userInput, options = {}) {
        const origin = options.origin || 'user'
        const isSystemOrigin = origin === ChatMessageOrigin.SYSTEM

        //  Optional per-reply TTS passthrough params -- spread into every 'tts:speak' emission.
        const ttsOptions = (options.tts && typeof options.tts === 'object') ? options.tts : {}
        this.#messages.push({ role: 'user', content: userInput, _ts: Date.now(), _origin: origin })
        let iteration = 0

        while (iteration < MAX_TOOL_ITERATIONS) {
            iteration++

            //  Returns the optimized, tiny static array (100% cache friendly)
            const tools = ToolBuilder.build()

            //  Strip internal fields (_ts) before sending to AI provider.
            const apiMessages = this.stripInternalFields(this.#messages)
            const assistantMsg = await this.#provider.chat(apiMessages, tools)
            this.#messages.push({ ...assistantMsg, _ts: Date.now(), _origin: origin })

            if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
                //  Check if the model returned JSON instead of proper tool_calls -- catch models.
                const jsonIntents = ToolBuilder.parseJsonIntent(assistantMsg.content)

                if (jsonIntents && jsonIntents.length > 0) {
                    LoggerService.warn(
                        `Model caught red-handed! Malformed tool calling detected (${jsonIntents.length} intent(s)) - returned JSON text instead of native tool_calls. Parsing anyway.`,
                        'AiAssistant'
                    )

                    //  Reconstruct a structurally valid OpenAI exchange from the pseudo-calls: attach.
                    const synthCalls = jsonIntents.map((intent, i) => ({
                        id: `synth_tool_${iteration}_${i}`,
                        type: 'function',
                        function: {
                            name: (intent.action != null || typeof intent.position === 'number') ? 'set_device_state' : 'get_device_state',
                            arguments: JSON.stringify({
                                device_name: intent.device,
                                ...(intent.action != null ? { action: String(intent.action).toUpperCase() } : {}),
                                ...(typeof intent.position === 'number' ? { position: intent.position } : {})
                            })
                        }
                    }))
                    this.#messages[this.#messages.length - 1].tool_calls = synthCalls

                    //  Execute all parsed intents; results feed back into the conversation so the AI can respond naturally.
                    for (let i = 0; i < jsonIntents.length; i++) {
                        const result = await ToolBuilder.executeIntent(jsonIntents[i])
                        this.#messages.push({
                            role: 'tool',
                            tool_call_id: synthCalls[i].id,
                            content: String(result),
                            _ts: Date.now(),
                            _origin: origin
                        })
                    }

                    //  Continue loop so the AI can process the tool results and give natural response.
                    continue
                }

                //  Skip persistence for system-originated messages so periodic ticks.
                if (!isSystemOrigin) {
                    this.#trimConversation()
                    await this.#persistConversation()
                }
                let response = assistantMsg.content || ''

                //  Conditionally strip markdown formatting and emoji from AI response.
                response = this.#maybeStripFormatting(response)

                //  Emit TTS event so the decoupled TtsService can speak the response;
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
        //  Skip persistence for system-originated messages (same rationale as above)
        if (!isSystemOrigin) {
            this.#trimConversation()
            await this.#persistConversation()
        }
        fallback = this.#maybeStripFormatting(fallback)
        EventBus.emit('tts:speak', { text: fallback, ...ttsOptions })
        return fallback
    }

    /** Clear the conversation history and reset to a fresh system prompt. */
    clearConversation() {
        this.#messages = [
            { role: 'system', content: this.getEffectiveSystemPrompt() }
        ]
        CacheService.delete(CONVERSATION_KEY).catch(() => {})
        LoggerService.info('Conversation cleared', 'AiAssistant')
    }

    /** Return the number of non-system messages in the current conversation.
     * @returns {number} */
    getMessageCount() {
        return this.#messages.length - 1
    }

    /** Return the non-system messages array for UI display purposes.
     * @returns {Array<Object>} Array of message objects */
    getConversationHistory() {
        return this.#messages.filter(m => m.role !== 'system')
    }

    /** Return the full messages array including the system prompt.
     * @returns {Array<Object>} Full message array including system message */
    getMessages() {
        return this.#messages
    }

    /** Inject a test user message into the conversation (for diagnostic scripts).
     * @param {string} content - The user message text to inject. */
    injectUserMessage(content) {
        this.#messages.push({ role: 'user', content, _ts: Date.now() })
    }

    //  -- Public API: System Prompt ----------------------------------------

    /** The assistant's own configured name (`ai.name`), the single source of truth
     * @returns {string} The assistant name to display and to speak as. */
    getAssistantName() {
        const raw = ConfigService.get('ai.name')
        const name = (typeof raw === 'string') ? raw.trim() : ''
        return name !== '' ? name : DEFAULT_ASSISTANT_NAME
    }

    /** Return the effective system prompt (base prompt + device list).
     * @returns {string} The full effective system prompt. */
    getEffectiveSystemPrompt() {
        const devices = DeviceContainer.getAll()
        const roles = this.#loadDeviceRoles()

        const devicesHeader = I18nLoader.t('sections.devices_header', '=== DEVICES ===')
        const deviceInstruction = I18nLoader.t('sections.device_instruction', '')

        //  Build flat device list: mechanisms + sensors only.
        const allDevices = []

        for (const name of Object.keys(devices)) {
            if (name === 'bridge') continue

            const prefix = devices[name]?.getLogPrefix?.() || 'Mechanism'

            //  Skip pure remotes unless they have an i18n annotation (dual-purpose devices)
            if (prefix === 'Remote' && !roles.has(name)) continue

            const role = roles.get(name) || ''
            const tag = role ? ` [${role}]` : ''
            allDevices.push(`- "${name}"${tag}`)
        }

        const basePrompt = interpolateTokens(this.#systemPrompt, { name: this.getAssistantName() })

        return `${basePrompt}\n\n${devicesHeader}\n${deviceInstruction}\n${allDevices.join('\n')}`
    }

    //  -- Private Helpers --------------------------------------------------

    /** Load device role annotations from the active i18n bundle.
     * @returns {Map<string, string>}
     * @private */
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

    /** Load AI configuration from YAML file.
     * @private */
    #loadConfig() {
        try {
            this.#conversationTtlSec = this.#resolveConversationTtl()
            this.#maxTurns = ConfigService.get('ai.max_conversation_turns', DEFAULT_MAX_TURNS)
            LoggerService.debug('Loaded AI config from ConfigService', 'AiAssistant')
        } catch (error) {
            LoggerService.warn(`Failed to load AI config (${error.message}), using defaults`, 'AiAssistant')
        }

        //  System prompt from i18n bundle.
        const i18nPrompt = I18nLoader.t('system_prompt')
        if (i18nPrompt && typeof i18nPrompt === 'string' && i18nPrompt.trim()) {
            this.#systemPrompt = i18nPrompt.trim()
        }
    }

    /** Resolve conversation history TTL in whole seconds from main config.
     * @private
     * @returns {number} TTL in whole seconds (> 0) */
    #resolveConversationTtl() {
        const raw = ConfigService.get('ai.conversation_ttl')
        if (raw == null) return DEFAULT_CONVERSATION_TTL_SEC
        const ms = temporal.parseDurationMs(raw)
        const sec = ms !== null && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : null
        if (sec == null || !(sec > 0)) {
            LoggerService.warn(
                `Invalid conversation_ttl ${JSON.stringify(raw)} (expected e.g. "15m" or plain milliseconds); using default ${DEFAULT_CONVERSATION_TTL_SEC}s`,
                'AiAssistant'
            )
            return DEFAULT_CONVERSATION_TTL_SEC
        }
        return sec
    }

    /** Strip internal fields (_ts, etc.) from messages before sending to AI provider.
     * @param {Array<Object>} msgs - Full message array with internal metadata
     * @returns {Array<Object>} Cleaned messages safe for LLM API */
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

    /** Conditionally strip markdown formatting and emoji from an AI response.
     * @param {string} text - The raw AI response text.
     * @returns {string} Cleaned text if strip_ai_formatting is true, otherwise unchanged.
     * @private */
    #maybeStripFormatting(text) {
        const shouldStrip = ConfigService.get('ai.strip_ai_formatting', false)
        return shouldStrip ? stripMarkdown(text) : text
    }

    /** Trim the conversation history to stay within {@link #maxTurns}.
     * @private */
    #trimConversation() {
        if (this.#messages.length <= this.#maxTurns + 1) return
        const keep = this.#maxTurns
        const trimmed = [this.#messages[0], ...this.#messages.slice(-keep)]
        this.#messages = trimmed
    }

    /** Persist non-system messages to CacheService with TTL.
     * @private */
    async #persistConversation() {
        if (!CacheService.isConnected()) return
        try {
            //  Exclude system-role messages AND system-origin conversation turns.
            const chatMessages = this.#messages.filter(
                m => m.role !== 'system' && m._origin !== ChatMessageOrigin.SYSTEM
            )
            await CacheService.set(CONVERSATION_KEY, chatMessages, this.#conversationTtlSec)
        } catch (error) {
            LoggerService.debug(`Failed to persist conversation: ${error.message}`, 'AiAssistant')
        }
    }

    /** Restore conversation history from CacheService on startup.
     * @private */
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

//  Singleton instance -- frozen to prevent mutation of the public API surface.
const AiAssistantInstance = new SAiAssistant()
Object.freeze(AiAssistantInstance)
export default AiAssistantInstance