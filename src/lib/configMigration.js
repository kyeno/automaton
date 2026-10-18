/**
 * File-loading compatibility for renamed duration keys and ai.bridge.
 * Public schemas and runtime consumers use only canonical names. Payloads are never rewritten.
 * @module lib/configMigration
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/** Former millisecond duration keys in the main automation settings. */
const AUTOMATION_KEYS = ['human_interaction_cooldown', 'echo_window_instant', 'echo_window_travel', 'motion_stall_timeout', 'settle_absorb_window', 'travel_echo_grace', 'failed_command_backoff']

/** Rename known keys on a detached object; an explicit canonical value always wins.
 * @param {unknown} raw - Configuration map.
 * @param {string[]} names - Canonical names formerly suffixed _ms.
 * @returns {unknown} Shallow normalized copy or the original invalid scalar for validation. */
function durations(raw, names) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const out = { ...raw }
    for (const name of names) {
        const legacy = `${name}_ms`
        if (Object.hasOwn(out, legacy)) {
            if (!Object.hasOwn(out, name)) out[name] = out[legacy]
            delete out[legacy]
        }
    }
    return out
}

/** Normalize sequence pacing without descending into device command payloads.
 * @param {object} raw - A single sequence definition.
 * @returns {object} Normalized sequence definition. */
export function normalizeSequenceConfig(raw) {
    const out = durations(raw, ['delay'])
    if (!out || typeof out !== 'object' || Array.isArray(out)) return out
    if (out.loop) out.loop = durations(out.loop, ['off_delay', 'on_delay'])
    for (const key of ['devices', 'on', 'off']) {
        if (Array.isArray(out[key])) out[key] = out[key].map((step) => durations(step, ['delay']))
    }
    return out
}

/** Normalize a YAML section at its loading boundary, leaving unknown user data untouched.
 * @param {unknown} raw - Parsed YAML.
 * @param {string} section - ConfigService section name.
 * @returns {unknown} Canonical configuration snapshot. */
export function normalizeConfig(raw, section) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const out = { ...raw }
    if (section === 'main') {
        out.automation = durations(out.automation, AUTOMATION_KEYS)
        if (out.ai && typeof out.ai === 'object' && !Array.isArray(out.ai)) {
            out.ai = durations(out.ai, ['fetch_timeout'])
            if (Object.hasOwn(out.ai, 'conversation_ttl_sec')) {
                if (!Object.hasOwn(out.ai, 'conversation_ttl')) {
                    const legacy = out.ai.conversation_ttl_sec
                    out.ai.conversation_ttl = typeof legacy === 'number' ? Math.round(legacy) * 1000 : legacy
                }
                delete out.ai.conversation_ttl_sec
            }
            if (Object.hasOwn(out, 'ai_bridge')) {
                // A partial new bridge block may override individual old fields.
                const legacy = out.ai_bridge
                const current = out.ai.bridge
                const legacyIsMap = legacy && typeof legacy === 'object' && !Array.isArray(legacy)
                if (!Object.hasOwn(out.ai, 'bridge')) {
                    out.ai.bridge = legacyIsMap ? { ...legacy } : legacy
                } else if (legacyIsMap && current && typeof current === 'object' && !Array.isArray(current)) {
                    out.ai.bridge = { ...legacy, ...current }
                }
                delete out.ai_bridge
            }
        }
        out.email = durations(out.email, ['cooldown'])
        out.alerts = durations(out.alerts, ['zigbee_offline_cooldown', 'network_offline_cooldown', 'device_offline_cooldown'])
        const devices = out.alerts?.network_offline_devices
        if (devices && typeof devices === 'object' && !Array.isArray(devices)) {
            out.alerts.network_offline_devices = Object.fromEntries(Object.entries(devices).map(([name, options]) => [name, durations(options, ['cooldown'])]))
        }
        // Do not manufacture absent optional sections: validators distinguish absent from undefined.
        for (const key of ['automation', 'email', 'alerts']) if (!Object.hasOwn(raw, key)) delete out[key]
    } else if (section === 'network') {
        if (out.videoPlayers && typeof out.videoPlayers === 'object' && !Array.isArray(out.videoPlayers)) {
            out.videoPlayers = Object.fromEntries(Object.entries(out.videoPlayers).map(([name, config]) => [name, durations(config, ['timeout'])]))
        }
    } else if (section === 'sequences' || section === 'sequence') {
        if (Array.isArray(out.sequences)) out.sequences = out.sequences.map(normalizeSequenceConfig)
    }
    // Automation YAML files also accept their former numeric-only timer field.
    if (Object.hasOwn(out, 'timer_interval_ms')) {
        if (!Object.hasOwn(out, 'timer_interval')) out.timer_interval = out.timer_interval_ms
        delete out.timer_interval_ms
    }
    return out
}
