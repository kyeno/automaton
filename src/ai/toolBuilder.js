/**
 * AI Tool Builder & Executor.
 *
 * Provides a minimal, static set of generic tools to ensure 100% Prompt Cache
 * matching across LLM requests. Exposes two function schemas
 * (`set_device_state`, `get_device_state`) and resolves device names back to
 * live DeviceContainer instances at call time.
 *
 * Also handles all tool execution logic: resolving devices, dispatching
 * commands, reading state, and parsing JSON-based synthetic tool calls
 * from models that don't support native function calling.
 *
 * Tool descriptions are loaded from the active i18n bundle so they match
 * the language configured for AI communication.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceContainer from '../device/container/deviceContainer.js'
import EventBus from '../service/eventBus.js'
import I18nLoader from '../service/i18nLoader.js'
import LoggerService from '../service/loggerService.js'
import { round } from '../lib/math.js'

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/**
 * A tool call object returned by the LLM assistant message.
 * Contains the function name and JSON-encoded arguments string.
 *
 * @typedef {Object} ToolCall
 * @property {string} id - Unique identifier for this tool call
 * @property {string} type - Always "function"
 * @property {Object} function - Function call details
 * @property {string} function.name - Name of the function to call
 * @property {string} function.arguments - JSON-encoded argument string
 */

/**
 * Parsed intent extracted from a model's text-based JSON response.
 * Used when the model doesn't support native function calling but outputs
 * structured JSON in its text content instead.
 *
 * @typedef {Object} Intent
 * @property {string} device - Device name to operate on
 * @property {'ON'|'OFF'|'OPEN'|'CLOSE'|'STOP'} [action] - Optional action
 * @property {number} [position] - Optional position (0-100) for shutters
 */

// ---------------------------------------------------------------------------
// SToolBuilder (singleton)
// ---------------------------------------------------------------------------

/**
 * Builds and caches the static AI function-schema tool definitions,
 * and executes tool calls returned by the LLM.
 */
class SToolBuilder {

    instance
    /** @type {Array<Object>|null} */ #tools = null

    // -- Singleton --------------------------------------------------------

    /**
     * Synchronous singleton constructor.
     * @returns {this}
     */
    constructor() {
        if (!SToolBuilder.instance) SToolBuilder.instance = this
        return SToolBuilder.instance
    }

    // -- Public API: Schema Building --------------------------------------

    /**
     * Build (and cache) the generic tool definitions.
     *
     * Subsequent calls without `force=true` return the cached array,
     * guaranteeing byte-identical payloads for prompt-cache efficiency.
     * Tool descriptions are loaded from the active i18n bundle.
     *
     * @param {boolean} [force=false] - If true, rebuild tools from scratch.
     *   Currently ignored since schemas are fully static.
     * @returns {Array<Object>} Array of OpenAI function-schema tool objects.
     */
    build(force = false) {
        if (!force && this.#tools !== null) {
            return this.#tools
        }

        // Load translations from i18n bundle with English fallbacks
        const setDesc = I18nLoader.t('tools.set_device_state.description',
            'Change the state or position of an executive device (light, socket, switch, roller shutter).')
        const setDeviceNameDesc = I18nLoader.t('tools.set_device_state.parameters.device_name',
            'Exact friendly name of the device, e.g. "Living Room Shutter", "Kitchen Socket".')
        const setActionDesc = I18nLoader.t('tools.set_device_state.parameters.action',
            'Action to perform. For shutters use OPEN/CLOSE/STOP, for lights and sockets use ON/OFF.')
        const setPositionDesc = I18nLoader.t('tools.set_device_state.parameters.position',
            'Optional shutter position in percentage (0=closed, 100=open). Use instead of action for precise setting.')

        const getDesc = I18nLoader.t('tools.get_device_state.description',
            'Check the current state of any device (sensor, remote, or executive device). Returns sensors, batteries, or current binary state.')
        const getDeviceNameDesc = I18nLoader.t('tools.get_device_state.parameters.device_name',
            'Exact friendly name of the device to check.')

        this.#tools = [
            {
                type: 'function',
                function: {
                    name: 'set_device_state',
                    description: setDesc,
                    parameters: {
                        type: 'object',
                        properties: {
                            device_name: {
                                type: 'string',
                                description: setDeviceNameDesc
                            },
                            action: {
                                type: 'string',
                                enum: ['ON', 'OFF', 'OPEN', 'CLOSE', 'STOP', 'STATE'],
                                description: setActionDesc
                            },
                            position: {
                                type: 'integer',
                                minimum: 0,
                                maximum: 100,
                                description: setPositionDesc
                            }
                        },
                        required: ['device_name']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'get_device_state',
                    description: getDesc,
                    parameters: {
                        type: 'object',
                        properties: {
                            device_name: {
                                type: 'string',
                                description: getDeviceNameDesc
                            }
                        },
                        required: ['device_name']
                    }
                }
            }
        ]

        return this.#tools
    }

    /**
     * Return the number of cached tool definitions.
     * Always 2 in the generic version (`set_device_state`, `get_device_state`).
     * @returns {number}
     */
    getToolCount() {
        return this.#tools?.length ?? 0
    }

    // -- Public API: Tool Execution ---------------------------------------

    /**
     * Resolve a tool call back to its live device instance.
     *
     * Matches `args.device_name` against registered devices using
     * normalized (diacritic-stripped, underscore-joined) names so that
     * LLM-supplied identifiers like `"kitchen_lamp"` match friendly names
     * such as `"Kitchen Lamp"`. Both sides are sanitized identically.
     *
     * @param {Object} args - Parsed arguments from the LLM tool call.
     * @returns {DeviceBase|null} The resolved device, or null.
     */
    resolveDevice(args = {}) {
        const targetName = args.device_name
        if (!targetName) return null

        const targetSanitized = this.#sanitizeToolName(String(targetName))
        const devices = DeviceContainer.getAll()
        for (const [name, device] of Object.entries(devices)) {
            if (this.#sanitizeToolName(name) === targetSanitized) {
                return device
            }
        }
        return null
    }

    /**
     * Execute a single tool call requested by the LLM.
     *
     * Resolves the target device, logs the interaction, emits an event
     * via EventBus for UI consumption, then dispatches to the appropriate
     * handler (state read, position set, or standard command).
     *
     * @param {ToolCall} toolCall - The tool call object from the assistant message.
     * @returns {Promise<string>} JSON-stringified result for the model.
     */
    async execute(toolCall) {
        const funcName = toolCall.function?.name

        let args = {}
        try {
            args = JSON.parse(toolCall.function?.arguments || '{}')
        } catch {
            return JSON.stringify({
                error: `Invalid arguments for "${funcName}": ${toolCall.function?.arguments}`
            })
        }

        // Resolve device via args.device_name
        const device = this.resolveDevice(args)

        if (!device) {
            return JSON.stringify({
                error: `Device "${args.device_name || 'unknown'}" not found in current registry.`
            })
        }

        const deviceName = device.getName()
        const action = args.action?.toUpperCase()

        LoggerService.info(
            `AI tool call: ${funcName}(${JSON.stringify(args)}) -> ${deviceName}`,
            'AiAssistant'
        )

        // Delegate to the shared dispatcher. readState mirrors the original
        // condition so get_device_state always returns state even with an action.
        const readState = funcName === 'get_device_state' || action === 'STATE'
        return this.#dispatchToDevice(device, deviceName, {
            action,
            position: args.position,
            toolLabel: funcName,
            readState,
            rawArgs: args
        })
    }

    /**
     * Attempt to extract JSON tool-call intents from an assistant's text response.
     * Small models often don't support native function calling but output structured
     * JSON in their text instead. This method detects and parses those patterns.
     *
     * Handles multiple formats:
     * - Single JSON object with top-level keys: {"device": "...", "action": "..."}
     * - Nested parameters format: {"name": "set_device_state", "parameters": {"device_name": "..."}}
     * - Multiple space-separated JSON objects (multi-device responses)
     * - Markdown code fences around any of the above
     * @param {string|null} [content] - Assistant message content
     * @returns {Array<Intent>|null} Array of parsed intents, or null if no valid intents found
     */
    parseJsonIntent(content) {
        if (!content || typeof content !== 'string') return null

        // Strip optional markdown code fence: ```json ... ```
        let stripped = content.trim()
        const fencedMatch = stripped.match(/^\s*\`\`\`(?:json)?\s*\n([\s\S]*?)\n\s*\`\`\`\s*$/)
        if (fencedMatch) {
            stripped = fencedMatch[1].trim()
        }

        // Stage 1 -- strict JSON (well-formed output). Preserves original behavior exactly.
        const strictIntents = this.#extractStrictJsonIntents(stripped)
        if (strictIntents.length > 0) return strictIntents

        // Stage 2 -- lenient rescue for small models that emit loose pseudo-call syntax
        // instead of valid JSON (unquoted keys, function-name prefix, "(" args, etc.).
        return this.#extractLenientToolCalls(stripped)
    }

    /**
     * Extract intents from well-formed JSON blocks in the text. Only valid JSON objects are
     * considered here, supporting both flat ({device_name/action}) and wrapped
     * ({name/parameters}) shapes. This is the original, conservative parsing path.
     * @param {string} text - Fence-stripped assistant content
     * @returns {Array<Intent>} Parsed intents (may be empty when nothing is valid JSON)
     * @private
     */
    #extractStrictJsonIntents(text) {
        const jsonMatches = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)]
        if (jsonMatches.length === 0) return []

        const intents = []
        for (const match of jsonMatches) {
            let parsed
            try {
                parsed = JSON.parse(match[0])
            } catch {
                continue
            }

            // Format 1: {"name": "set_device_state", "parameters": {"device_name": "...", "action": "..."}}
            if (parsed.parameters && typeof parsed.parameters === 'object') {
                const p = parsed.parameters
                const devName = p.device_name || p.device
                if (!devName) continue
                intents.push({ device: devName, action: p.action ?? undefined, position: this.#toPosition(p.position) })
                continue
            }

            // Format 2: {"device": "...", "action": "..."} or {"device_name": "..."}
            if (parsed.device || parsed.device_name) {
                intents.push({ device: parsed.device || parsed.device_name, action: parsed.action ?? undefined, position: this.#toPosition(parsed.position) })
                continue
            }
        }

        return intents
    }

    /**
     * Extract intents from loose pseudo-call syntax that small models emit when they do not
     * produce valid JSON or native tool_calls. Two strategies are combined:
     *   1. Tool-name keyed -- each known function name starts a segment; every balanced argument
     *      block ({...} or (...)) inside it is parsed with tolerant key matching.
     *   2. Bare brace fallback -- unquoted object keys inside {...} blocks are quoted so the text
     *      becomes valid JSON, accepting any block that carries a device_name/device field.
     * @param {string} text - Fence-stripped assistant content (strict parsing already failed)
     * @returns {Array<Intent>|null} Parsed intents, or null when none could be recovered
     * @private
     */
    #extractLenientToolCalls(text) {
        const TOOL_NAMES = ['set_device_state', 'get_device_state']

        // Collect every occurrence of a known tool name to split the message into per-call segments.
        const positions = []
        for (const name of TOOL_NAMES) {
            let idx = text.indexOf(name)
            while (idx !== -1) {
                positions.push(idx)
                idx = text.indexOf(name, idx + name.length)
            }
        }
        positions.sort((a, b) => a - b)

        const intents = []
        for (let i = 0; i < positions.length; i++) {
            const segStart = positions[i]
            const segEnd = i + 1 < positions.length ? positions[i + 1] : text.length
            const segment = text.slice(segStart, segEnd)

            const blocks = this.#allBalancedBlocks(segment)
            if (blocks.length === 0) {
                // No delimiters -- treat everything after the function name as loose key/value pairs.
                const args = this.#parseArgPairs(segment)
                if (args && args.device) {
                    intents.push({ device: args.device, action: args.action ?? undefined, position: args.position })
                }
                continue
            }

            for (const inner of blocks) {
                const args = this.#parseArgPairs(inner)
                if (!args || !args.device) continue
                intents.push({ device: args.device, action: args.action ?? undefined, position: args.position })
            }
        }
        if (intents.length > 0) return intents

        // Fallback: bare brace blocks with unquoted keys -> quote keys, then JSON.parse.
        const bareBlocks = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)]
        for (const match of bareBlocks) {
            let parsed
            try {
                parsed = JSON.parse(this.#quoteBareKeys(match[0]))
            } catch {
                continue
            }
            if (!parsed || typeof parsed !== 'object') continue
            const devName = parsed.device_name || parsed.device
            if (!devName) continue
            intents.push({ device: devName, action: parsed.action ?? undefined, position: this.#toPosition(parsed.position) })
        }

        return intents.length > 0 ? intents : null
    }

    /**
     * Execute a parsed JSON intent as a synthetic tool call.
     * Operates on the normalized intent object extracted from text-based JSON
     * responses rather than native function calls.
     *
     * @param {Object} intent - Parsed intent with device/action fields
     * @returns {Promise<string>} JSON-stringified result for the model
     */
    async executeIntent(intent) {
        const device = this.resolveDevice({ device_name: intent.device })

        if (!device) {
            return JSON.stringify({
                error: `Device "${intent.device}" not found in current registry.`
            })
        }

        const deviceName = device.getName()
        const action = intent.action?.toUpperCase()

        LoggerService.info(
            `AI parsed intent (${JSON.stringify(intent)}) -> ${deviceName}`,
            'AiAssistant'
        )

        // No explicit action means "read current state"; delegate to the shared
        // dispatcher for event emission and command handling.
        const readState = !action || action === 'STATE'
        return this.#dispatchToDevice(device, deviceName, {
            action,
            position: intent.position,
            toolLabel: 'json_intent',
            readState
        })
    }

    /**
     * Shared dispatch logic for native tool calls and parsed JSON intents.
     *
     * Both entry points normalize their inputs before delegating here so the
     * behavior stays identical: emits the UI interaction event, then performs
     * exactly one of state read, roller-shutter position set, or standard
     * command send, returning a JSON-stringified result for the model.
     *
     * @param {DeviceBase} device - Resolved live device instance
     * @param {string} deviceName - Device friendly name used in result payloads
     * @param {{action?: string|null, position?: number|undefined, toolLabel: string, readState: boolean, rawArgs?: Object}} opts - Normalized operation parameters
     * @returns {Promise<string>} JSON-stringified result for the model
     * @private
     */
    async #dispatchToDevice(device, deviceName, { action = null, position, toolLabel = 'unknown', readState = false, rawArgs = {} }) {
        const hasPosition = typeof position === 'number'
        // Clamp once -- reused by both the event payload and the command branch
        const clampedPos = hasPosition ? Math.max(0, Math.min(100, round(position))) : null

        // Determine human-readable action for the event payload
        let interactionAction = action ?? 'STATE'
        if (hasPosition) {
            interactionAction = `SET_POSITION=${clampedPos}`
        }

        // Emit device interaction event for UI consumption
        EventBus.emit('ai:deviceInteraction', {
            device: deviceName,
            action: interactionAction,
            tool: toolLabel
        })

        // --- Read state (filtered for AI relevance) ---
        if (readState) {
            const cached = await device.getCachedState()
            const stateLast = cached?.stateLast ?? {}
            return JSON.stringify({
                device: deviceName,
                state: this.#filterStateForAI(stateLast),
                last_updated: cached?.stateLastAt ?? null,
                origin: cached?.stateOrigin ?? 'unknown'
            }, null, 2)
        }

        // --- Position-based command (roller shutter) ---
        if (hasPosition) {
            device.receiveCommand({ position: clampedPos }, true)
            return JSON.stringify({
                device: deviceName,
                action: 'set_position',
                position: clampedPos,
                status: 'sent'
            })
        }

        // --- Standard command (ON/OFF/OPEN/CLOSE/STOP) ---
        if (action) {
            device.receiveCommand(action, true)
            return JSON.stringify({
                device: deviceName,
                action: action,
                status: 'sent'
            })
        }

        return JSON.stringify({
            device: deviceName,
            error: `No action specified in arguments: ${JSON.stringify(rawArgs)}`
        })
    }
    /**
     * Scan text and return the inner content of every top-level balanced argument container
     * ({...} or (...)), skipping past nested delimiters of the same kind. Unbalanced trailing
     * fragments are ignored so partial output never yields garbage.
     * @param {string} str - Text to scan
     * @returns {Array<string>} Inner contents of all complete balanced blocks found
     * @private
     */
    #allBalancedBlocks(str) {
        const results = []
        let i = 0
        while (i < str.length) {
            if (str[i] === '{' || str[i] === '(') {
                const open = str[i]
                const close = open === '{' ? '}' : ')'
                let depth = 0
                for (let j = i; j < str.length; j++) {
                    if (str[j] === open) depth++
                    else if (str[j] === close) {
                        depth--
                        if (depth === 0) {
                            results.push(str.slice(i + 1, j))
                            i = j
                            break
                        }
                    }
                }
                if (depth !== 0) break // unbalanced remainder -- stop scanning
            }
            i++
        }
        return results
    }

    /**
     * Extract device/action/position from a raw argument string regardless of whether keys are
     * quoted and whether ":" or "=" is used as the separator. Values may be double-quoted,
     * single-quoted, or bare tokens. Fields that are absent come back undefined.
     * @param {string} inner - Inner content of an argument block (without outer delimiters)
     * @returns {{device?: string, action?: string, position?: number}|null} Parsed arguments, or null when nothing usable was found
     * @private
     */
    #parseArgPairs(inner) {
        const pick = (key) => {
            const re = new RegExp(
                '(?:^|[,{\\s])' + key + '\\s*[:=]\\s*(?:"([^"]*)"|\'([^\']*)\'|([A-Za-z0-9][A-Za-z0-9_.]*))',
                'i'
            )
            const m = inner.match(re)
            if (!m) return undefined
            const value = m[1] ?? m[2] ?? m[3]
            return value === undefined ? undefined : String(value).trim()
        }

        let device = pick('device_name') || pick('device')
        if (device !== undefined && device.trim() === '') device = undefined
        const actionRaw = pick('action')
        const action = actionRaw !== undefined && actionRaw.trim() !== '' ? actionRaw.trim() : undefined
        const position = this.#toPosition(pick('position'))

        if (!device && !action && position === undefined) return null
        return { device, action, position }
    }

    /**
     * Quote bare (unquoted) object keys that precede a colon so loose pseudo-JSON such as
     * {action:"ON", device_name:"X"} becomes valid JSON {"action":"ON","device_name":"X"}.
     * Already-quoted keys are left untouched because they are not preceded by a delimiter/space.
     * @param {string} s - Raw brace block text
     * @returns {string} Text with bare object keys quoted
     * @private
     */
    #quoteBareKeys(s) {
        return s.replace(/([{,\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    }

    /**
     * Normalize a raw position value into an integer, returning undefined when the value is not
     * a usable number. Accepts numbers and numeric strings; ignores anything else.
     * @param {*} value - Raw position from parsed arguments
     * @returns {number|undefined} Integer position or undefined
     * @private
     */
    #toPosition(value) {
        if (typeof value === 'number' && !isNaN(value)) return Math.trunc(value)
        if (typeof value === 'string') {
            const n = parseInt(value, 10)
            if (!isNaN(n)) return n
        }
        return undefined
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Filter raw Zigbee2MQTT state payload to only include fields relevant
     * for the AI assistant. Strips noise like linkquality, last_seen, firmware
     * update info, etc., keeping only sensor readings and operational state.
     *
     * @param {Object} state - Raw MQTT state payload
     * @returns {Object} Filtered state object
     * @private
     */
    #filterStateForAI(state) {
        const ALLOWED_FIELDS = new Set([
            // Core state
            'state',
            'position',
            // Environmental sensors
            'temperature',
            'humidity',
            'illuminance',
            'pressure',
            // Power/energy monitoring
            'power',
            'energy',
            'current',
            // Battery (percentage, not raw voltage which is redundant)
            'battery',
            // Remote/action devices
            'action',
            // Future-proof: presence, safety sensors
            'presence',
            'occupancy',
            'water_leak',
            'gas',
            'smoke',
            'co2'
        ])

        // Numeric sensor fields that should be locale-formatted (decimal separator etc.)
        const NUMERIC_SENSORS = new Set([
            'temperature',
            'humidity',
            'illuminance',
            'pressure',
            'power',
            'energy',
            'current',
            'battery',
            'co2'
        ])

        // ASCII-only unit suffixes appended after the formatted number.
        // Temperature gets no suffix since LLM already adds "stopnia" correctly in Polish.
        const SENSOR_UNITS = Object.freeze({
            humidity: '%',
            position: '%',
            battery:  '%',
            power:    'W',
            energy:   'kWh',
            illuminance: 'lx',
            pressure:  'hPa',
            co2:       'ppm'
        })

        const filtered = {}
        for (const [key, value] of Object.entries(state)) {
            if (!ALLOWED_FIELDS.has(key)) continue

            // Format numeric sensors with locale-aware decimal separators via i18n.
            // Zigbee2MQTT sometimes sends sensor values as strings ("23.2") instead
            // of numbers (23.2), so coerce with Number() to handle both cases.
            if (NUMERIC_SENSORS.has(key)) {
                const numVal = typeof value === 'number' ? value : Number(value)
                if (!isNaN(numVal)) {
                    let formatted = I18nLoader.formatNumber(round(numVal))
                    const unit = SENSOR_UNITS[key]
                    if (unit && !String(formatted).endsWith(unit)) {
                        formatted += unit
                    }
                    filtered[key] = formatted
                    continue
                }
            }
            filtered[key] = value
        }
        return filtered
    }

    /**
     * Normalize a human-readable device name into an ASCII-safe identifier
     * suitable for comparison with LLM-supplied argument values.
     *
     * Strips diacritics (NFD decomposition), replaces non-alphanumeric chars
     * and whitespace with underscores, collapses duplicates, and lowercases.
     *
     * @param {string} name - The original friendly device name.
     * @returns {string} Normalized identifier.
     * @private
     */
    #sanitizeToolName(name) {
        return name
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]\s*/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .toLowerCase()
    }
}

// Singleton instance -- frozen to prevent mutation of the public API surface.
const ToolBuilder = new SToolBuilder()
Object.freeze(ToolBuilder)
export default ToolBuilder