/**
 * Shared TTS framing options (jingles) resolver.
 *
 * One owner of how intro/outro wave filenames and intro spacing get resolved for a
 * spoken utterance, so every speaker -- the TTS automations (weatherman, greeter,
 * gardener), the spoken alert monitors and the UI speak window -- shapes its voice
 * through the same rules instead of a private copy of them.
 *
 * Two config shapes are understood, both optional and both read from the speaker's
 * own config (an automation YAML file, an `alerts:` family, a `ui:` key):
 *
 *   tts_profile: 'alarm'      -- name of a framing set in the active locale's
 *                                etc/i18n/<locale>/tts.yaml `profiles:` registry
 *   tts_options:              -- explicit framing block; wins over the profile
 *       intro: 'a.wav'
 *       outro: 'b.wav'
 *       intro_spacing: -2.5
 *
 * Malformed entries are dropped with a warning instead of failing the utterance, and
 * an absent or fully-empty shape yields {} -- so emissions keep their plain { text }
 * payload when nothing is configured. The resolved object is spread into the
 * 'tts:speak' payload, where TtsService merges it over the locale template defaults
 * (runtime wins). Profiles never carry output_endpoint: the audio sink stays
 * runtime > locale template > TTS_TCP_ENDPOINT. See doc/installation/tts-integration.md.
 *
 * @module lib/ttsProfiles
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../service/eventBus.js'
import LoggerService from '../service/loggerService.js'
import TtsService from '../service/ttsService.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Logger tag used when no caller-specific warning sink is supplied. */
const LOG_TAG = 'TtsProfiles'

/** Wave-filename framing keys forwarded verbatim into the TTS server request. */
const WAVE_KEYS = ['intro', 'outro']

/** Spacing key: seconds between intro end and speech start (negative overlaps). */
const SPACING_KEY = 'intro_spacing'

// ---------------------------------------------------------------------------
// STtsProfiles (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * Frozen singleton owning the framing-options rules: validation, profile lookup and
 * the single emit helper every speaker uses to put an utterance on the wire.
 * Stateless apart from a warning-dedupe set (a missing profile is reported once per
 * name, not once per utterance). ES module caching guarantees single instantiation.
 */
class STtsProfiles {

    /** Profile names already warned about -- keeps a typo from spamming every utterance. */
    #warnedProfiles = new Set()

    /**
     * Validate a raw framing block into the concrete request fields the TTS server
     * understands. Wave keys must be non-empty strings (trimmed); spacing must be a
     * finite number (negative allowed). Anything else is dropped with a warning, so a
     * half-filled template never breaks speech. Exposed (no # prefix) so unit tests
     * can pin validation behaviour against synthetic blocks.
     * @param {unknown} raw - Framing block to validate; non-objects yield {}
     * @param {string} [label='tts_options'] - Config path used in drop warnings
     * @param {(message: string) => void} [onWarn=null] - Warning sink; defaults to LoggerService.warn
     * @returns {{intro?: string, outro?: string, intro_spacing?: number}} Validated options (possibly empty)
     */
    validate(raw, label = 'tts_options', onWarn = null) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
        const warn = (message) => (onWarn ? onWarn(message) : LoggerService.warn(message, LOG_TAG))
        const result = {}

        for (const key of WAVE_KEYS) {
            const value = raw[key]
            if (value == null) continue
            if (typeof value === 'string' && value.trim()) {
                result[key] = value.trim()
            } else {
                warn(`${label}.${key} must be a non-empty wave filename -- ignoring`)
            }
        }

        const spacing = raw[SPACING_KEY]
        if (spacing != null) {
            if (typeof spacing === 'number' && Number.isFinite(spacing)) {
                result[SPACING_KEY] = spacing
            } else {
                warn(`${label}.${SPACING_KEY} must be a finite number of seconds (negative allowed) -- ignoring`)
            }
        }

        return result
    }


    /**
     * Resolve the framing options for one speaker from its own config object: the
     * named profile (from the active locale's `profiles:` registry) forms the base
     * and an explicit `tts_options` block overrides it key by key. An unknown
     * profile name warns once per name and contributes nothing.
     * @param {Record<string, unknown>|null} source - Config object carrying `tts_profile` and/or `tts_options`
     * @param {(message: string) => void} [onWarn=null] - Warning sink; defaults to LoggerService.warn
     * @returns {{intro?: string, outro?: string, intro_spacing?: number}} Ready-to-spread options (possibly empty)
     */
    resolve(source, onWarn = null) {
        const warn = (message) => (onWarn ? onWarn(message) : LoggerService.warn(message, LOG_TAG))
        const profileName = typeof source?.tts_profile === 'string' ? source.tts_profile.trim() : ''

        let resolved = {}
        if (profileName) {
            const profile = TtsService.getProfile(profileName)
            if (profile === null) {
                // Dedupe case-insensitively -- the registry lookup itself is
                // case-insensitive, so 'Alarm' and 'alarm' are the same typo.
                const warnedKey = profileName.toLowerCase()
                if (!this.#warnedProfiles.has(warnedKey)) {
                    this.#warnedProfiles.add(warnedKey)
                    warn(`tts_profile "${profileName}" is not defined in the active locale's tts.yaml profiles -- ignoring`)
                }
            } else {
                resolved = this.validate(profile, `profiles.${profileName}`, onWarn)
            }
        }

        return { ...resolved, ...this.validate(source?.tts_options, 'tts_options', onWarn) }
    }

    /**
     * Put one utterance on the shared TTS channel with its resolved framing fields.
     * The single emit point for every speaker: an empty options object keeps the
     * payload byte-identical to the plain { text } shape.
     * @param {string} text - Text to speak
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} [options={}] - Framing fields spread into the payload
     * @returns {void}
     */
    speak(text, options = {}) {
        EventBus.emit('tts:speak', { text, ...options })
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const TtsProfiles = Object.freeze(new STtsProfiles())
export default TtsProfiles

