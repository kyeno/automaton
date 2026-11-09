/**
 * Validator schema for etc/automaton.yaml (main configuration).
 * Loaded automatically by ConfigBase when section name is "main".
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { ACK_TIMEOUT_MAX_MS, ACK_TIMEOUT_MIN_MS, ENV_NAME_RE, TARGET_ID_RE, TARGET_KEYS } from '../host/hostProtocol.js'
import temporal from '../lib/date.js'

export default {
    //  Automation section -- global device/interaction behavior (durations)
    automation: {
        type: 'object',
        required: false,
        properties: {
            human_interaction_cooldown: { type: ['number', 'string'] },
            echo_window_instant:        { type: ['number', 'string'] },
            echo_window_travel:         { type: ['number', 'string'] },
            motion_stall_timeout:       { type: ['number', 'string'] },
            settle_absorb_window:       { type: ['number', 'string'] },
            travel_echo_grace:          { type: ['number', 'string'] },
            failed_command_backoff:     { type: ['number', 'string'] }
        }
    },

    //  Locale / localization section.
    locale: {
        type: 'object',
        required: true,
        properties: {
            language:    { type: 'string', required: true },
            time_format: { type: 'string', enum: ['12h', '24h'], required: true },
            //  Geolocation -- observer coordinates driving sun-based rule shorthands ("sundawn"/"sundusk").
            geo_latitude:  { type: 'number', required: false },
            geo_longitude: { type: 'number', required: false }
        }
    },

    daylight: {
        type: 'object',
        properties: {
            recording_enabled: { type: 'boolean' },
            announcements_enabled: { type: 'boolean' },
            sensors: { type: 'array', items: { type: 'object', properties: {
                id: { type: 'string', required: true },
                device: { type: 'string', required: true },
                property: { type: 'string', required: true },
                installation: { type: 'string', required: true },
                azimuth_degrees: { type: 'number' },
                tilt_degrees: { type: 'number' },
                max_lux: { type: 'number' },
                max_age_seconds: { type: 'number' }
            } } }
        }
    },

    sensor_history: {
        type: 'object',
        properties: {
            enabled: { type: 'boolean' },
            properties: { type: 'array', items: { type: 'string' } },
            retention: { type: ['number', 'string'] }
        }
    },

    //  AI section -- provider + conversation settings.
    ai: {
        type: 'object',
        required: true,
        properties: {
            model:                 { type: 'string', required: true },
            name:                  { type: 'string', required: false },
            max_tokens:            { type: 'number', required: true },
            temperature:           { type: 'number', required: true },
            fetch_timeout:      { type: ['number', 'string'], required: false },
            conversation_ttl:  { type: ['number', 'string'], required: false },
            max_conversation_turns:{ type: 'number', required: false },
            strip_ai_formatting:   { type: 'boolean', required: false },
            include_chat_history_in_system_calls: { type: 'boolean', required: false },
            bridge: {
                type: 'object',
                required: false,
                properties: {
                    enabled:        { type: 'boolean' },
                    topic_base:     { type: 'string' },
                    forward_events: { type: 'boolean' }
                }
            }
        }
    },

    //  House owners section -- the people the automaton speaks and writes to. Entries are
    //  objects; the mail service addresses every notification mail to each address listed.
    house_owners: {
        type: 'array',
        required: false,
        items: {
            type: 'object',
            properties: {
                name:  { type: 'string', required: true },
                email: { type: 'string', required: true }
            }
        }
    },

    //  Email section -- SMTP notification channel. Host/port/credentials are secrets and
    //  live in .env (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS); only the
    //  behavioral settings below belong here.
    email: {
        type: 'object',
        required: false,
        properties: {
            enabled:        { type: 'boolean' },
            from:           { type: 'string' },
            from_name:      { type: 'string' },
            //  Per-kind notification switches, keyed by kind name (dynamic keys, map).
            notify:         { type: 'object' },
            cooldown:    { type: ['number', 'string'] },
            subject_prefix: { type: 'string' }
        }
    },

    //  Alerts section -- spoken notifications for notable system events.
    alerts: {
        type: 'object',
        required: false,
        properties: {
            frozen_sensors: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean' },
                    devices: { type: 'object' },
                    unchanged_for: { type: ['number', 'string'] },
                    reminder_interval: { type: ['number', 'string'] },
                    silence_between: { type: ['string', 'null'] },
                    speak: { type: 'boolean' },
                    use_ai: { type: 'boolean' },
                    tts_profile: { type: 'string' },
                    tts_options: { type: 'object' }
                }
            },
            //  Zigbee devices leaving the mesh.
            device_offline_tts:         { type: 'boolean' },
            device_offline_cooldown: { type: ['number', 'string'] },
            device_offline_ignore:      { type: 'array' },
            zigbee_offline_tts:         { type: 'boolean' },
            zigbee_offline_cooldown: { type: ['number', 'string'] },
            zigbee_offline_ignore:      { type: 'array' },
            zigbee_offline_tts_profile: { type: 'string' },
            zigbee_offline_tts_options: { type: 'object' },
            //  Mission-critical network hosts going offline.
            network_offline_tts:              { type: 'boolean' },
            network_offline_cooldown:      { type: ['number', 'string'] },
            network_offline_ignore:           { type: 'array' },
            network_offline_tts_profile:      { type: 'string' },
            network_offline_tts_options:      { type: 'object' },
            network_offline_announce_boot:    { type: 'boolean' },
            network_offline_announce_recovery:{ type: 'boolean' },
            //  Per-device overrides keyed by device name -- dynamic keys, validated as a map.
            network_offline_devices:          { type: 'object' }
        }
    },

    //  Host commands section -- signed shutdown requests toward host machines whose chat
    //  client opted in. Secrets never live in this file: every target names an environment
    //  variable (secret_env) that holds the shared HMAC key. Deep checks live in
    //  validateConfig below; see doc/services/host-commands.md.
    host_commands: {
        type: 'object',
        required: false,
        properties: {
            enabled:    { type: 'boolean' },
            topic_base: { type: 'string' },
            //  Target slug -> { secret_env, ack_timeout }. Dynamic keys, map-validated.
            targets:    { type: 'object' }
        }
    },

    //  Paths section (optional - provides config file paths and directory paths)
    paths: {
        type: 'object',
        required: false,
        properties: {
            configs: {
                type: 'object',
                required: false,
                properties: {
                    network: { type: 'string' },
                    ir: { type: 'string' },
                    sequence: { type: 'string' },
                    virtual: { type: 'string' },
                    interaction: { type: 'string' }
                }
            },
            directories: {
                type: 'object',
                required: false,
                properties: {
                    automation: { type: 'string' },
                    interaction: { type: 'string' }
                }
            }
        }
    },

    //  Logger section.
    logger: {
        type: 'object',
        required: true,
        properties: {
            file: {
                type: 'object',
                required: false,
                properties: {
                    max_size: { type: 'number' },
                    max_files: { type: 'number' },
                    tailable: { type: 'boolean' }
                }
            },
            console: {
                type: 'object',
                required: false,
                properties: {
                    console_warn_levels: { type: 'array' },
                    stderr_levels: { type: 'array' }
                }
            },
            path: {
                type: 'object',
                required: false,
                properties: {
                    debug: { type: 'string' },
                    warn: { type: 'string' }
                }
            }
        }
    },

    // UI section -- terminal interface (status bar, layout, buffer limit, windows)
    ui: {
        type: 'object',
        required: true,
        properties: {
            //  Jingle framing profile for text typed into the UI TTS window.
            tts_profile: { type: 'string' },
            status_bar: {
                type: 'object',
                required: true,
                properties: {
                    lines: { type: 'array', required: true }
                }
            },
            layout: {
                type: 'object',
                required: false,
                properties: {
                    min_width: { type: 'number' }
                }
            },
            window_settings: {
                type: 'object',
                required: false,
                properties: {
                    max_buffer_lines: { type: 'number' }
                }
            },
            windows: {
                type: 'array',
                required: true,
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', required: true },
                        channel: { type: 'string', required: true },
                        title: { type: 'string', required: true },
                        shortcut: { type: 'number', required: true },
                        readonly: { type: 'boolean' }
                    }
                }
            }
        }
    }
}

/**
 * Semantic checks for the host_commands section -- the ConfigBase custom-validator hook.
 *
 * The structural schema above only sees `targets` as a map; everything that keeps the
 * shutdown contract safe (slug shape, env-var naming, topic-tree boundaries, unknown keys
 * that could smuggle a command) is verified here.
 *
 * @param {Object} config - Full main configuration
 * @returns {string[]} Human-readable errors; empty when the section is usable */
export function validateConfig(config) {
    const section = config?.host_commands
    if (section === undefined || section === null) return []
    if (typeof section !== 'object' || Array.isArray(section)) return ['host_commands: must be an object']

    const errors = []

    if (section.enabled !== undefined && section.enabled !== null && typeof section.enabled !== 'boolean') {
        errors.push('host_commands.enabled: must be true or false')
    }

    const base = section.topic_base
    if (base !== undefined && base !== null) {
        const value = String(base).trim()
        if (!value) {
            errors.push('host_commands.topic_base: must not be empty')
        } else if (value.includes('#') || value.includes('+')) {
            errors.push('host_commands.topic_base: wildcards are not allowed')
        } else if (value === 'zigbee2mqtt' || value.startsWith('zigbee2mqtt/')) {
            errors.push('host_commands.topic_base: must not live under the Zigbee2MQTT prefix')
        } else if (value === 'automaton/ai' || value.startsWith('automaton/ai/')) {
            errors.push('host_commands.topic_base: automaton/ai is reserved for chat input')
        } else if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
            errors.push('host_commands.topic_base: must not contain empty topic levels')
        }
    }

    const targets = section.targets
    if (targets === undefined || targets === null) {
        if (section.enabled === true) errors.push('host_commands.targets: required when host_commands.enabled is true')
        return errors
    }
    if (typeof targets !== 'object' || Array.isArray(targets)) {
        return [...errors, 'host_commands.targets: must be a map of target slug to settings']
    }

    for (const [key, entry] of Object.entries(targets)) {
        const path = `host_commands.targets.${key}`
        if (!TARGET_ID_RE.test(String(key).trim().toLowerCase())) {
            errors.push(`${path}: target id must be a lowercase slug matching ${TARGET_ID_RE.source}`)
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${path}: must be an object with secret_env and optional ack_timeout`)
            continue
        }
        for (const key2 of Object.keys(entry)) {
            if (!TARGET_KEYS.has(key2)) {
                errors.push(`${path}.${key2}: unsupported key (only secret_env and ack_timeout are allowed)`)
            }
        }
        const secretEnv = entry.secret_env
        if (typeof secretEnv !== 'string' || !ENV_NAME_RE.test(secretEnv.trim())) {
            errors.push(`${path}.secret_env: must name an environment variable (letters, digits, underscores)`)
        }
        if (entry.ack_timeout !== undefined && entry.ack_timeout !== null) {
            const parsed = temporal.parseDurationMs(entry.ack_timeout)
            if (parsed === null) {
                errors.push(`${path}.ack_timeout: not a duration`)
            } else if (parsed <= 0) {
                errors.push(`${path}.ack_timeout: must be positive`)
            } else if (parsed < ACK_TIMEOUT_MIN_MS || parsed > ACK_TIMEOUT_MAX_MS) {
                errors.push(`${path}.ack_timeout: must be between ${ACK_TIMEOUT_MIN_MS}ms and ${ACK_TIMEOUT_MAX_MS}ms`)
            }
        }
    }

    return errors
}
