/**
 * Shared announcement pipeline -- build one text, hand it to every output channel.
 *
 * Every spoken automation needs the same thing: an i18n sentence filled with runtime
 * tokens, optionally rewritten by the model, then echoed to the chat window, spoken by
 * TTS, mirrored onto the MQTT AI bridge and (for notifications) mailed out. Each of
 * those legs used to be written out per automation, so adding a channel meant touching
 * every one of them. This module owns the rules once: the text is generated a single
 * time and every channel receives that same text, so what a user reads is what the
 * speaker said and what the mail says.
 *
 * @module lib/announcementPipeline
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import LoggerService from '../service/loggerService.js'
import EventBus from '../service/eventBus.js'
import AiAssistant from '../ai/aiAssistant.js'
import AiBridgeMonitor from '../monitor/aiBridgeMonitor.js'
import EmailService from '../service/emailService.js'
import ChatMessageOrigin from '../enum/aiChatMessageOrigin.js'
import TtsProfiles from './ttsProfiles.js'
import { interpolateTokens } from './string.js'


/** Channel carrying the exact text handed to the model (rendered as <system>). */
const SYSTEM_MESSAGE_CHANNEL = 'ai:systemMessage'

/** Channel carrying a model-generated announcement reply (rendered as <AI>). */
const PERIODIC_RESPONSE_CHANNEL = 'ai:periodicResponse'

/** Fallback logger tag when a caller supplies none. */
const DEFAULT_LABEL = 'AnnouncementPipeline'

//  SAnnouncementPipeline (module-level singleton)

/** Frozen singleton owning the generate-once / fan-out-everywhere announcement rules. */
class SAnnouncementPipeline {

    //  -- Public API --------------------------------------------------------

    /** Build one announcement and deliver it to every channel that is listening.
     *
     * The text is produced once. When `useAi` is on and the model is up, the bucket's
     * `ai` instruction is sent to it and the model's own reply becomes the announcement
     * (the assistant's own pipeline speaks it). Otherwise the bucket's plain `tts` line
     * is the announcement and gets spoken directly. `speak: false` generates the text
     * without voicing it -- the leg a notification uses while the speaker is asleep.
     * @param {Object} [options] - Announcement request
     * @param {Record<string, unknown>|null} [options.bundle=null] - Loaded i18n bundle root
     * @param {string} [options.section=''] - Dotted bundle key of the bucket, e.g. 'gardener.stuck'
     * @param {Record<string, string>} [options.tokens={}] - Values filling the {% token %} placeholders
     * @param {string} [options.label='AnnouncementPipeline'] - Logger tag used for warnings
     * @param {boolean} [options.useAi=false] - Route the announcement through the model
     * @param {boolean} [options.speak=true] - false generates the text without voicing it
     * @param {boolean} [options.emitUi=true] - Echo the text into the terminal AI window
     * @param {boolean} [options.emitBridge=true] - Mirror the text onto the MQTT AI bridge
     * @param {{kind: string, tokens?: Record<string, string>, meta?: Object}|null} [options.email=null] - Email fan-out request
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} [options.ttsOptions={}] - Framing for the spoken leg
     * @param {(message: string) => void} [options.onWarn=null] - Warning sink; defaults to LoggerService.warn
     * @param {(message: string, level?: string) => void} [options.log=null] - Caller log sink
     * @returns {Promise<{text: string, via: string|null, spoken: boolean, emailed: boolean, ui: boolean, bridge: boolean}>} Outcome of the fan-out
     * @async */
    async announce(options = {}) {
        const {
            bundle = null,
            section = '',
            tokens = {},
            label = DEFAULT_LABEL,
            useAi = false,
            speak = true,
            emitUi = true,
            emitBridge = true,
            email = null,
            ttsOptions = {},
            onWarn = null,
            log = null,
        } = options

        const outcome = { text: '', via: null, spoken: false, emailed: false, ui: false, bridge: false }
        const warn = (message) => (onWarn ? onWarn(message) : LoggerService.warn(message, label))
        const report = (message, level = 'debug') => { if (typeof log === 'function') log(message, level) }

        const node = this.resolveSection(bundle, section)
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            warn(`Announcement bucket "${section}" not found in the active bundle -- nothing to announce`)
            return outcome
        }

        const plainText = this.#fillTemplate(node.tts, tokens, `${section}.tts`)
        if (!plainText) {
            warn(`No plain sentence for "${section}" in the active bundle -- nothing to announce`)
            return outcome
        }

        const leg = await this.#buildText({ node, plainText, tokens, section, useAi, speak, ttsOptions, emitUi, warn, report })
        outcome.text = leg.text
        outcome.via = leg.via
        outcome.spoken = leg.spoken
        outcome.ui = leg.ui

        if (leg.text && emitBridge === true) {
            outcome.bridge = AiBridgeMonitor.publishAnnouncement(leg.text)
        }

        if (leg.text && email && typeof email === 'object') {
            outcome.emailed = await EmailService.notify({
                kind: email.kind,
                tokens: { ...tokens, ...(email.tokens || {}) },
                message: leg.text,
                meta: email.meta,
            })
        }

        return outcome
    }

    /** Resolve one bucket node out of a bundle root, tolerating both key shapes.
     *  Automation rules name a bucket as '<bundle>.<section>' ('gardener.dry') while a
     *  bundle root holds its sections at the top level ('dry'). The full dotted path is
     *  tried first; when it does not exist the leading segment is dropped, so a caller
     *  may pass either spelling and reach the same node.
     * @param {Record<string, unknown>|null} bundle - Loaded bundle root
     * @param {string} section - Dotted bucket key
     * @returns {Record<string, unknown>|null} Bucket node, or null when unresolvable */
    resolveSection(bundle, section) {
        if (!bundle || typeof bundle !== 'object' || !section) return null

        const parts = String(section).split('.')
        const direct = this.#walk(bundle, parts)
        if (direct && typeof direct === 'object') return direct
        if (parts.length < 2) return null

        const stripped = this.#walk(bundle, parts.slice(1))
        return stripped && typeof stripped === 'object' ? stripped : null
    }

    //  -- Private helpers ---------------------------------------------------

    /** Produce the announcement text and voice it on the leg the config allows.
     * @param {Object} args - Build request
     * @param {Record<string, unknown>} args.node - Resolved bucket node
     * @param {string} args.plainText - Filled plain sentence
     * @param {Record<string, string>} args.tokens - Placeholder values
     * @param {string} args.section - Bucket key, named in warnings
     * @param {boolean} args.useAi - Route through the model
     * @param {boolean} args.speak - Voice the result
     * @param {boolean} args.emitUi - Echo into the AI window
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} args.ttsOptions - Framing
     * @param {(message: string) => void} args.warn - Warning sink
     * @param {(message: string, level?: string) => void} args.report - Log sink
     * @returns {Promise<{text: string, via: string, spoken: boolean, ui: boolean}>} Generated leg
     * @private
     * @async */
    async #buildText({ node, plainText, tokens, section, useAi, speak, ttsOptions, emitUi, warn, report }) {
        let text = plainText
        let via = 'tts'
        let spoken = false
        let ui = false

        if (useAi === true) {
            if (!AiAssistant.isAvailable()) {
                warn('use_ai enabled but the AI assistant is unavailable -- using the plain sentence')
            } else {
                const instruction = this.#fillTemplate(node.ai, tokens, `${section}.ai`)
                if (!instruction) {
                    warn(`No AI instruction for "${section}.ai" -- speaking the plain sentence instead`)
                } else {
                    const reply = await this.#routeThroughAi(instruction, ttsOptions, emitUi, report, speak)
                    if (reply) {
                        text = reply
                        via = 'ai'
                        spoken = speak
                        ui = emitUi
                    }
                }
            }
        }

        if (via === 'tts') {
            if (speak === true) {
                TtsProfiles.speak(text, ttsOptions)
                spoken = true
                report(`Announcement (${section}) sent via direct TTS (${text.length} chars)`)
                if (emitUi) ui = this.#emitTranscript(SYSTEM_MESSAGE_CHANNEL, text)
            } else {
                via = 'text'
                report(`Announcement (${section}) built without speech -- output channel gated`, 'debug')
            }
        }

        return { text, via, spoken, ui }
    }

    /** Send one built announcement through the AI -> TTS pipeline with graceful degradation.
     * @param {string} instruction - Full instruction handed to the model
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} ttsOptions - Framing for the model's own speech
     * @param {boolean} emitUi - Echo the instruction and the reply into the AI window
     * @param {(message: string, level?: string) => void} report - Log sink
     * @param {boolean} speak - Whether the assistant should voice its reply
     * @returns {Promise<string>} The model's reply, or '' when the leg must fall back
     * @private
     * @async */
    async #routeThroughAi(instruction, ttsOptions, emitUi, report, speak) {
        if (emitUi) this.#emitTranscript(SYSTEM_MESSAGE_CHANNEL, instruction)

        let spoken = ''
        try {
            const response = await AiAssistant.processMessage(instruction, {
                origin: ChatMessageOrigin.SYSTEM,
                speak,
                tts: ttsOptions
            })
            spoken = typeof response === 'string' ? response.trim() : ''
        } catch (error) {
            report(`AI processing failed: ${error.message} -- falling back to the plain sentence`, 'warn')
            return ''
        }

        if (!spoken) {
            report('AI reply was empty -- falling back to the plain sentence', 'warn')
            return ''
        }

        if (emitUi) this.#emitTranscript(PERIODIC_RESPONSE_CHANNEL, spoken)
        report(`Announcement sent via AI -> TTS pipeline (${spoken.length} chars)`)
        return spoken
    }

    /** Publish one transcript line on a shared channel, guarded by subscriber presence.
     * @param {string} channel - Transcript channel
     * @param {string} text - Line to render
     * @returns {boolean} true when the line reached a window
     * @private */
    #emitTranscript(channel, text) {
        if (!text || !EventBus.hasSubscribers(channel)) return false
        EventBus.emit(channel, { text })
        return true
    }

    /** Fill {% token %} placeholders, refusing a template that cannot be completed.
     *  Mirrors the speech automations' contract: a leftover placeholder means the bundle
     *  and the runtime data disagree, and a half-filled sentence is worse spoken aloud
     *  than silence, so an empty string is returned and the caller announces nothing.
     * @param {*} template - Raw YAML template line
     * @param {Record<string, string>} tokens - Placeholder values
     * @param {string} label - Bundle key named in the warning
     * @returns {string} Interpolated text, or '' when unresolvable
     * @private */
    #fillTemplate(template, tokens, label) {
        if (typeof template !== 'string' || !template.trim()) return ''

        const filled = interpolateTokens(template, tokens)
        if (filled.includes('{%')) {
            LoggerService.warn(
                `Announcement template "${label}" has an unresolvable placeholder -- check the active i18n bundle`,
                DEFAULT_LABEL
            )
            return ''
        }
        return filled.trim()
    }

    /** Walk a bundle root down a path of key segments.
     * @param {Record<string, unknown>} root - Node to start from
     * @param {string[]} parts - Path segments
     * @returns {*} Resolved value, or undefined when the path breaks
     * @private */
    #walk(root, parts) {
        let current = root
        for (const part of parts) {
            if (current == null || typeof current !== 'object') return undefined
            current = current[part]
        }
        return current
    }
}

//  Module-level singleton -- ES module caching guarantees single instantiation.
const AnnouncementPipeline = Object.freeze(new SAnnouncementPipeline())
export default AnnouncementPipeline


