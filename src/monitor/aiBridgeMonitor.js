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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default MQTT topic base for the AI bridge channel (kept OUTSIDE zigbee2mqtt/* on purpose). */
const DEFAULT_TOPIC_BASE = 'automaton/ai'

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
        this.#publishMessageFrame({ role: 'user', content: text })

        let reply
        try {
            // origin defaults to 'user' == exactly the UI path (default pipeline + persistence).
            reply = await AiAssistant.processMessage(text)
        } catch (error) {
            LoggerService.error(`AI bridge turn failed for "${this.#truncate(text)}": ${error.message}`, 'AiBridgeMonitor')
            return
        }

        if (typeof reply === 'string' && reply.trim()) {
            this.#publishMessageFrame({ role: 'assistant', content: reply })
        } else {
            LoggerService.debug('AI bridge got an empty reply -- no assistant frame published', 'AiBridgeMonitor')
        }
    }

    /**
     * Extract a usable prompt string from a raw payload. Accepts plain strings and JSON
     * objects with `.text` / `.prompt` / `.message` field aliases; anything else yields ''.
     * @param {string} raw - Raw MQTT payload
     * @returns {string} Trimmed prompt text, or '' when nothing usable was found
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
        return String(candidate).trim()
    }

    // -- Outbound frames ------------------------------------------------------

    /**
     * Publish one transcript frame to the message topic: `{ role, content, ts }`.
     * @param {{role:'user'|'assistant', content:string}} frame - Frame body without timestamp
     * @private
     */
    #publishMessageFrame(frame) {
        MqttService.publish(`${this.#topicBase}/message`, JSON.stringify({ ...frame, ts: Date.now() }))
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