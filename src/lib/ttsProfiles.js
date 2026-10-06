/**
 * Shared TTS framing options (jingles) resolver.
 * One owner of how intro/outro wave filenames and intro spacing get resolved.
 * @module lib/ttsProfiles
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../service/eventBus.js'
import LoggerService from '../service/loggerService.js'
import TtsService from '../service/ttsService.js'


/** Logger tag used when no caller-specific warning sink is supplied. */
const LOG_TAG = 'TtsProfiles'

/** Wave-filename framing keys forwarded verbatim into the TTS server request. */
const WAVE_KEYS = ['intro', 'outro']

/** Spacing key: seconds between intro end and speech start (negative overlaps). */
const SPACING_KEY = 'intro_spacing'

//  STtsProfiles (module-level singleton)

/** Frozen singleton owning the framing-options rules: validation. */
class STtsProfiles {

    /** Profile names already warned about -- keeps a typo from spamming every utterance. */
    #warnedProfiles = new Set()

    /** Validate a raw framing block into the concrete request fields the TTS server.
     * @param {unknown} raw - Framing block to validate; non-objects yield {}
     * @param {string} [label='tts_options'] - Config path used in drop warnings
     * @param {(message: string) => void} [onWarn=null] - Warning sink; defaults to LoggerService.warn
     * @returns {{intro?: string, outro?: string, intro_spacing?: number}} Validated options (possibly empty) */
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


    /** Resolve the framing options for one speaker from its own config object.
     * @param {Record<string, unknown>|null} source - Config object carrying `tts_profile` and/or `tts_options`
     * @param {(message: string) => void} [onWarn=null] - Warning sink; defaults to LoggerService.warn
     * @returns {{intro?: string, outro?: string, intro_spacing?: number}} Ready-to-spread options (possibly empty) */
    resolve(source, onWarn = null) {
        const warn = (message) => (onWarn ? onWarn(message) : LoggerService.warn(message, LOG_TAG))
        const profileName = typeof source?.tts_profile === 'string' ? source.tts_profile.trim() : ''

        let resolved = {}
        if (profileName) {
            const profile = TtsService.getProfile(profileName)
            if (profile === null) {
                //  Dedupe case-insensitively.
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

    /** Put one utterance on the shared TTS channel with its resolved framing fields.
     * @param {string} text - Text to speak
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} [options={}] - Framing fields spread into the payload
     * @returns {void} */
    speak(text, options = {}) {
        EventBus.emit('tts:speak', { text, ...options })
    }
}

//  Module-level singleton -- ES module caching guarantees single instantiation.
const TtsProfiles = Object.freeze(new STtsProfiles())
export default TtsProfiles

