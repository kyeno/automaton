/**
 * AI Bridge Monitor -- dedicated MQTT channel feeding external prompts into the AI engine.
 *
 * Subscribes to `<topic_base>/request` (default `automaton/ai/request`) and routes every
 * inbound prompt straight into {@link AiAssistant.processMessage()} as a **user**-origin
 * message through the default pipeline -- byte-for-byte identical to typing in the
 * terminal UI. Outbound frames are published to `<topic_base>/message` (ordered transcript:
 * one `{role:'user'}` echo followed by one `{role:'assistant'}` reply per turn) and, when
 * `forward_events` is enabled, tool/device interactions mirror the internal
 * `ai:deviceInteraction` EventBus event onto `<topic_base>/event`.
 *
 * The transcript is mirrored on the shared EventBus channels in BOTH directions, each frame
 * carrying a `source` provenance tag:
 *   - bridge turn  -> `ai:userMessage` / `ai:assistantMessage` with `{source:'mqtt'}`, which
 *     the AI window renders as `<remote>` / `<AI>` lines;
 *   - UI turn      -> `{source:'ui'}` events published back onto `<topic_base>/message`, so
 *     every MQTT subscriber's live copy covers the whole shared conversation, not just the
 *     prompts that subscriber typed itself.
 * Events carrying our own `source:'mqtt'` tag are never re-published, so the mirror cannot
 * feed its own echoes back.
 *
 * The request subscription opts out of semantic deduplication (`{dedupe:false}`) because
 * chat input is non-idempotent: two distinct prompts share an empty semantic signature
 * and must never be dropped as duplicates. We only subscribe to `request` and only publish
 * to `message` + `event`, so no feedback loop with our own output topics is possible.
 *
 * Topic contract & payload schemas: _debug/ai-bridge-mqtt-channel.md.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from '../service/configService.js'
import LoggerService from '../service/loggerService.js'
import MqttService from '../service/mqttService.js'
import EventBus from '../service/eventBus.js'
import AiAssistant from '../ai/aiAssistant.js'
import { sanitizeText } from '../lib/string.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default MQTT topic base for the AI bridge channel (kept OUTSIDE zigbee2mqtt/* on purpose). */
const DEFAULT_TOPIC_BASE = 'automaton/ai'

/** Provenance tag on every transcript frame/event this monitor originates (prompts from MQTT). */
const BRIDGE_SOURCE = 'mqtt'

/** Provenance tag of turns typed in the terminal UI; those are mirrored onto the message topic. */
const UI_SOURCE = 'ui'

// ---------------------------------------------------------------------------
// SAiBridgeMonitor (singleton)
// ---------------------------------------------------------------------------

/**
 * Singleton monitor bridging external MQTT clients into the shared AI conversation.
 * ES module caching guarantees single instantiation.
 */
class SAiBridgeMonitor {

    /** Unsubscribe function returned by MqttService.subscribe(), or null when not listening. */
    #unsubRequest = null

    /** Unsubscribe functions for EventBus channels, cleared on stop(). */
    #eventUnsubs = []

    /** Resolved topic base (set during init()). */
    #topicBase = DEFAULT_TOPIC_BASE

    /** Whether to forward device-interaction events over MQTT (set during init()). */
    #forwardEvents = true

    // -- Lifecycle ----------------------------------------------------------

    /**
     * Start listening on the request topic and (optionally) forward device-interaction
     * events to the event topic. No-op with a log line when `ai_bridge.enabled` is
     * explicitly false; prompts arriving while the AI assistant is unavailable are
     * dropped per-request so a later `/config reload` enabling AI needs no restart.
     * @async
     */
    async init() {
        if (ConfigService.get('ai_bridge.enabled') === false) {
            LoggerService.info('AI bridge disabled via ai_bridge.enabled=false', 'AiBridgeMonitor')
            return
        }

        const base = String(ConfigService.get('ai_bridge.topic_base') || DEFAULT_TOPIC_BASE).replace(/\/+$/, '')
        this.#topicBase = base
        this.#forwardEvents = ConfigService.get('ai_bridge.forward_events') !== false

        // Chat input is non-idempotent: opt out of the 300ms semantic-dedup window so
        // repeated/identical prompts are never swallowed as duplicates.
        this.#unsubRequest = MqttService.subscribe(
            `${base}/request`,
            (_topic, raw) => {
                this.#onRequest(raw).catch((error) => {
                    LoggerService.error(`AI bridge request handling failed: ${error.message}`, 'AiBridgeMonitor')
                })
            },
            { dedupe: false }
        )

        if (this.#forwardEvents) {
            this.#eventUnsubs.push(EventBus.subscribe('ai:deviceInteraction', (payload) => {
                this.#publishEventFrame(payload)
            }))
        }

        // Turns typed in the terminal UI belong in the shared transcript too: without this the
        // web clients' "live copy" would be missing every prompt answered from the keyboard.
        // #mirrorUiTurn() ignores our own source:'mqtt' events, so this cannot loop.
        this.#eventUnsubs.push(EventBus.subscribe('ai:userMessage', (payload) => {
            this.#mirrorUiTurn('user', payload)
        }))
        this.#eventUnsubs.push(EventBus.subscribe('ai:assistantMessage', (payload) => {
            this.#mirrorUiTurn('assistant', payload)
        }))

        LoggerService.info(
            `AI bridge listening on ${base}/request (replies -> ${base}/message${this.#forwardEvents ? `, events -> ${base}/event` : ''})`,
            'AiBridgeMonitor'
        )
    }

    /**
     * Stop all subscriptions. Idempotent; called during graceful shutdown before
     * MqttService disconnects.
     */
    stop() {
        if (typeof this.#unsubRequest === 'function') {
            this.#unsubRequest()
            this.#unsubRequest = null
        }
        for (const unsub of this.#eventUnsubs) {
            try { unsub() } catch { /* best-effort teardown */ }
        }
        this.#eventUnsubs = []
        LoggerService.debug('AI bridge stopped', 'AiBridgeMonitor')
    }

    // -- Inbound handling ----------------------------------------------------

    /**
     * Handle one inbound prompt from the request topic.
     *
     * Intake is lenient: a plain string OR JSON with `.text` / `.prompt` / `.message`
     * are all accepted. After trimming, empty prompts are skipped silently. When the AI
     * assistant is unavailable the prompt is dropped with a warning (no fabricated reply).
     *
     * @param {string} raw - Raw MQTT payload string
     * @async
     * @private
     */
    async #onRequest(raw) {
        const text = this.#extractPromptText(raw)
        if (!text) {
            LoggerService.debug('AI bridge received an empty prompt, skipping', 'AiBridgeMonitor')
            return
        }

        if (!AiAssistant.isAvailable()) {
            LoggerService.warn(
                `AI bridge dropping prompt ("${this.#truncate(text)}") -- AI assistant unavailable`,
                'AiBridgeMonitor'
            )
            return
        }

        // Echo the user frame first so web clients see the prompt immediately while the
        // (potentially slow) inference runs; the assistant frame follows when it lands.
        // The same echo goes out on the EventBus so the terminal UI renders the prompt as a
        // <remote> line: publishing over MQTT and typing at the keyboard yield one transcript.
        this.#publishMessageFrame({ role: 'user', content: text, source: BRIDGE_SOURCE })
        this.#emitTranscript('ai:userMessage', { text, source: BRIDGE_SOURCE })

        let reply
        try {
            // origin defaults to 'user' == exactly the UI path (default pipeline + persistence).
            reply = await AiAssistant.processMessage(text)
        } catch (error) {
            LoggerService.error(`AI bridge turn failed for "${this.#truncate(text)}": ${error.message}`, 'AiBridgeMonitor')
            // Mirror the UI submit path: a failed turn shows up in chat as a red <AI> error
            // line instead of vanishing into the logs.
            this.#emitTranscript('ai:assistantMessage', { text: error.message, source: BRIDGE_SOURCE, error: true })
            return
        }

        if (typeof reply === 'string' && reply.trim()) {
            this.#publishMessageFrame({ role: 'assistant', content: reply, source: BRIDGE_SOURCE })
            this.#emitTranscript('ai:assistantMessage', { text: reply, source: BRIDGE_SOURCE })
        } else {
            LoggerService.debug('AI bridge got an empty reply -- no assistant frame published', 'AiBridgeMonitor')
        }
    }

    /**
     * Extract a usable prompt string from a raw payload. Accepts plain strings and JSON
     * objects with `.text` / `.prompt` / `.message` field aliases; anything else yields ''.
     *
     * The extracted text passes through sanitizeText(): a payload arriving on the request
     * topic is fully external, so terminal control sequences, emoji, out-of-alphabet code
     * points and forged line breaks are stripped and the prompt is length-capped before it
     * reaches the LLM, the transcript mirror and the logs.
     * @param {string} raw - Raw MQTT payload
     * @returns {string} Sanitized prompt text, or '' when nothing usable was found
     * @private
     */
    #extractPromptText(raw) {
        const source = String(raw ?? '').trim()
        if (!source) return ''

        let candidate = source
        try {
            const parsed = JSON.parse(source)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                candidate = [parsed.text, parsed.prompt, parsed.message]
                    .find((value) => typeof value === 'string') ?? ''
            } else {
                candidate = ''   // valid JSON but not an object -- not a prompt we understand
            }
        } catch {
            // Not JSON -- treat the whole payload as the prompt verbatim.
        }
        return sanitizeText(String(candidate)).trim()
    }

    // -- Outbound frames ------------------------------------------------------

    /**
     * Publish one transcript frame to the message topic: `{ role, content, source, ts }`.
     * @param {{role:'user'|'assistant', content:string, source:string}} frame - Frame body without timestamp
     * @private
     */
    #publishMessageFrame(frame) {
        MqttService.publish(`${this.#topicBase}/message`, JSON.stringify({ ...frame, ts: Date.now() }))
    }

    /**
     * Publish one transcript line on the shared EventBus channels so the terminal UI's AI
     * window renders it. Guarded by hasSubscribers() exactly like the periodic automations, so
     * a --no-ui run stays silent and no payload is built for a listener that never exists.
     * @param {'ai:userMessage'|'ai:assistantMessage'} channel - Transcript channel
     * @param {{text:string, source:string, error?:boolean}} payload - Transcript payload
     * @private
     */
    #emitTranscript(channel, payload) {
        if (!EventBus.hasSubscribers(channel)) return
        EventBus.emit(channel, payload)
    }

    /**
     * Mirror a turn that originated in the terminal UI onto the message topic so every MQTT
     * subscriber's transcript covers the whole shared conversation. Anything that is not a UI
     * turn -- in particular our own source:'mqtt' echoes -- is ignored, which is what keeps
     * this mirror from feeding itself back. Failed UI turns (error:true) stay in the terminal.
     * @param {'user'|'assistant'} role - Transcript role for the frame
     * @param {{text?: string, source?: string, error?: boolean}} payload - EventBus transcript payload
     * @private
     */
    #mirrorUiTurn(role, payload = {}) {
        if (payload.source !== UI_SOURCE || payload.error === true) return

        const content = String(payload.text ?? '').trim()
        if (!content) return

        this.#publishMessageFrame({ role, content, source: UI_SOURCE })
    }

    /**
     * Mirror an `ai:deviceInteraction` EventBus payload onto the event topic so web
     * clients can render "* AI turned OFF Salon Light" style lines.
     * @param {{device?: string, action?: string, tool?: string, ok?: boolean}} payload - Interaction event payload
     * @private
     */
    #publishEventFrame(payload = {}) {
        if (!this.#forwardEvents) return
        MqttService.publish(`${this.#topicBase}/event`, JSON.stringify({
            type: 'interaction',
            device: payload.device ?? 'unknown',
            action: payload.action ?? null,
            ok: payload.ok !== false,
            tool: payload.tool ?? null,
            ts: Date.now()
        }))
    }

    // -- Helpers ---------------------------------------------------------------

    /**
     * Shorten a prompt for log lines so long transcripts do not flood the logs.
     * @param {string} text - Original text
     * @returns {string} At most 80 characters with an ellipsis marker when truncated
     * @private
     */
    #truncate(text) {
        const limit = 80
        return text.length > limit ? `${text.slice(0, limit)}...` : text
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const AiBridgeMonitor = Object.freeze(new SAiBridgeMonitor())
export default AiBridgeMonitor