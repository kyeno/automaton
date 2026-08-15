/**
 * OpenAI-compatible API provider.
 *
 * Thin HTTP wrapper around any OpenAI-compatible chat completions endpoint
 * (OpenAI, Ollama, llama.cpp, LM Studio, etc.). Supports tool calling and
 * streaming responses.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from '../../service/configService.js'
import LoggerService from '../../service/loggerService.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default number of retries for transient HTTP errors.
 * @type {number}
 */
const DEFAULT_MAX_RETRIES = 3

/**
 * Base retry delay in milliseconds (exponential backoff).
 * @type {number}
 */
const DEFAULT_RETRY_DELAY_MS = 1000

/**
 * Maximum delay between retries.
 * @type {number}
 */
const MAX_RETRY_DELAY_MS = 10_000

/**
 * Default HTTP fetch timeout in milliseconds.
 * Local LLM inference can take significant time depending on context size,
 * model complexity, and hardware. 120s is a safe default that covers most cases.
 * @type {number}
 */
const DEFAULT_FETCH_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// OpenAiProvider
// ---------------------------------------------------------------------------

/**
 * Client for OpenAI-compatible chat completion APIs with tool calling support.
 */
class OpenAiProvider {

    /** @type {string} */ #apiUrl
    /** @type {string} */ #model
    /** @type {string|null} */ #apiKey
    /** @type {number} */ #maxTokens
    /** @type {number} */ #temperature
    /** @type {number} */ #maxRetries
    /** @type {number} */ #retryDelayMs
    /** @type {boolean} */ #initialized = false
    /** @type {AbortController|null} */ #abortController = null
    /** @type {NodeJS.Timeout|null} */ #timeoutHandle = null

    // -- Constructor --------------------------------------------------------

    /**
     * Create a new provider instance.
     *
     * @param {Object} [config={}] - Provider configuration
     * @param {string} [config.apiUrl] - Base URL for the API (e.g. http://host:port/v1)
     * @param {string} [config.model] - Model name to use
     * @param {string} [config.apiKey] - API key (optional, empty string if not needed)
     * @param {number} [config.maxTokens=2048] - Maximum tokens in response (-1 for unlimited)
     * @param {number} [config.temperature=0.1] - Sampling temperature
     * @param {number} [config.maxRetries=3] - Retry attempts on failure
     * @param {number} [config.retryDelayMs=1000] - Initial retry delay
     */
    constructor(config = {}) {
        // API connection secrets remain in .env
        this.#apiUrl = config.apiUrl || process.env['AI_API_URL'] || ''
        this.#apiKey = config.apiKey || process.env['AI_API_KEY'] || null

        // Provider settings loaded from ConfigService (config param overrides everything)
        const model       = config.model      ?? ConfigService.get('model')
        const maxTokens   = config.maxTokens  ?? ConfigService.get('max_tokens', 2048)
        const temperature = config.temperature ?? ConfigService.get('temperature', 0.1)

        this.#model       = model || ''
        this.#maxTokens   = maxTokens
        this.#temperature = temperature

        this.#maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
        this.#retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    }

    // -- Lifecycle ----------------------------------------------------------

    /**
     * Validate configuration and mark as initialized.
     * @throws {Error} If required configuration is missing
     */
    init() {
        if (!this.#apiUrl) {
            throw new Error('AI_API_URL is required (e.g. http://host:port/v1)')
        }
        if (!this.#model) {
            throw new Error('AI_MODEL is required')
        }

        this.#initialized = true
        LoggerService.info(
            `OpenAiProvider initialized: model=${this.#model}, url=${this.#apiUrl}`,
            'OpenAiProvider'
        )
    }

    /**
     * Check if the provider has been initialized.
     * @returns {boolean}
     */
    isInitialized() {
        return this.#initialized
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Send a chat completion request with optional tool definitions.
     *
     * @param {Array<Object>} messages - Chat messages array (role + content, or role + tool_calls)
     * @param {Array<Object>} [tools] - Optional OpenAI function-format tool definitions
     * @returns {Promise<Object>} The assistant's response message
     * @throws {Error} On persistent API failures
     */
    async chat(messages, tools) {
        this.#assertInitialized()

        const body = {
            model: this.#model,
            messages: messages,
            temperature: this.#temperature
        }

        // max_tokens: -1 means unlimited -- omit from request to let provider use its default
        if (this.#maxTokens !== -1) {
            body.max_tokens = this.#maxTokens
        }

        if (tools && tools.length > 0) {
            body.tools = tools
            body.tool_choice = 'auto'
        }

        LoggerService.debug(
            `Chat request: ${messages.length} messages, ${tools?.length ?? 0} tools`,
            'OpenAiProvider'
        )

        let lastError
        for (let attempt = 1; attempt <= this.#maxRetries; attempt++) {
            try {
                const response = await this.#post('/chat/completions', body)
                return this.#parseResponse(response)
            } catch (error) {
                lastError = error

                // Do not retry on 4xx errors (bad request, auth issues, etc.)
                if (error.status >= 400 && error.status < 500) {
                    LoggerService.error(
                        `API returned ${error.status}: ${error.message} (not retried)`,
                        'OpenAiProvider'
                    )
                    throw error
                }

                if (attempt < this.#maxRetries) {
                    const delay = Math.min(
                        this.#retryDelayMs * Math.pow(2, attempt - 1),
                        MAX_RETRY_DELAY_MS
                    )
                    LoggerService.warn(
                        `API call failed (attempt ${attempt}/${this.#maxRetries}): ${error.message}, retrying in ${delay}ms`,
                        'OpenAiProvider'
                    )
                    await this.#sleep(delay)
                }
            }
        }

        LoggerService.error(
            `All ${this.#maxRetries} connection attempts failed. Last error: ${lastError.message}`,
            'OpenAiProvider'
        )
        throw new Error(`All ${this.#maxRetries} attempts failed. Last error: ${lastError.message}`)
    }

    /**
     * Send a simple chat request without tools and return only the text content.
     * Convenience wrapper around chat().
     *
     * @param {Array<Object>} messages - Chat messages array
     * @returns {Promise<string>} The assistant's text response
     */
    async chatText(messages) {
        const response = await this.chat(messages)
        return response.content || ''
    }

    // -- Private helpers ----------------------------------------------------

    /**
     * Assert that init() was called.
     * @throws {Error} 'OpenAiProvider not initialized -- call init() first'
     * @private
     */
    #assertInitialized() {
        if (!this.#initialized) {
            throw new Error('OpenAiProvider not initialized -- call init() first')
        }
    }

    /**
     * POST a JSON payload to an API endpoint and return the parsed response.
     * Handles authentication headers and extracts error details from non-OK responses.
     *
     * @param {string} path - Endpoint path (e.g. '/chat/completions')
     * @param {Object} body - Request body to serialize as JSON
     * @returns {Promise<Object>} Parsed JSON response
     * @private
     */
    async #post(path, body) {
        const url = `${this.#apiUrl.replace(/\/+$/, '')}${path}`

        const headers = {
            'Content-Type': 'application/json'
        }

        if (this.#apiKey) {
            headers['Authorization'] = `Bearer ${this.#apiKey}`
        }

        this.#startTimeout()

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: this.#abortController.signal
            })

            this.#clearTimeout()
            return await this.#handleResponse(res)
        } catch (error) {
            this.#clearTimeout()
            if (error.name === 'AbortError') {
                const err = new Error(`Fetch timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms`)
                err.status = 408
                throw err
            }
            throw error
        }
    }

    /**
     * Start the AbortController timeout for the current HTTP request.
     * @private
     */
    #startTimeout() {
        this.#abortController = new AbortController()
        this.#timeoutHandle = setTimeout(this.#onTimeout.bind(this), DEFAULT_FETCH_TIMEOUT_MS)
    }

    /**
     * Clear the AbortController timeout after a successful or failed request.
     * @private
     */
    #clearTimeout() {
        if (this.#timeoutHandle) {
            clearTimeout(this.#timeoutHandle)
            this.#timeoutHandle = null
        }
        this.#abortController = null
    }

    /**
     * Callback invoked when the fetch timeout expires.
     * Aborts the in-flight request to prevent indefinite hangs.
     * @private
     */
    #onTimeout() {
        if (this.#abortController) {
            this.#abortController.abort()
        }
    }

    /**
     * Handle the HTTP response: parse errors on non-OK status, return parsed JSON on success.
     *
     * @param {Response} res - The fetch Response object
     * @returns {Promise<Object>} Parsed JSON response body
     * @throws {Error} On non-OK HTTP status
     * @private
     */
    async #handleResponse(res) {
        if (!res.ok) {
            let errorMessage = `HTTP ${res.status}: ${res.statusText}`
            try {
                const errorBody = await res.json()
                errorMessage = errorBody.error?.message || errorBody.error || errorMessage
            } catch {
                try {
                    errorMessage = await res.text()
                } catch {
                    // Use default message
                }
            }
            const err = new Error(errorMessage)
            err.status = res.status
            throw err
        }

        return await res.json()
    }

    /**
     * Parse the API response and extract the assistant message.
     * Extracts text content and any tool_call requests from the first choice.
     *
     * @param {Object} data - Raw JSON response from the API
     * @returns {Object} Message object with role, content, and optional tool_calls
     * @throws {Error} If no choices present in the response
     * @private
     */
    #parseResponse(data) {
        const choice = data.choices?.[0]
        if (!choice) {
            throw new Error('No choices in API response')
        }

        const message = choice.message
        const result = {
            role: message.role || 'assistant',
            content: message.content || null
        }

        if (message.tool_calls && message.tool_calls.length > 0) {
            result.tool_calls = message.tool_calls.map(tc => ({
                id: tc.id,
                type: tc.type || 'function',
                function: tc.function
            }))
        }

        if (result.tool_calls) {
            LoggerService.debug(
                `Assistant requested ${result.tool_calls.length} tool call(s)`,
                'OpenAiProvider'
            )
        }

        return result
    }

    /**
     * Delay execution for a given number of milliseconds.
     * Used for exponential-backoff retries between failed API calls.
     *
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>}
     * @private
     */
    #sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

export default OpenAiProvider