/**
 * Validator schema for etc/automaton.yaml (main configuration).
 * Loaded automatically by ConfigBase when section name is "main".
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

export default {
    //  Automation section -- global device/interaction behavior (durations)
    automation: {
        type: 'object',
        required: false,
        properties: {
            human_interaction_cooldown_ms: { type: ['number', 'string'] },
            echo_window_instant_ms:      { type: ['number', 'string'] },
            echo_window_travel_ms:       { type: ['number', 'string'] },
            motion_stall_timeout_ms:     { type: ['number', 'string'] },
            settle_absorb_window_ms:     { type: ['number', 'string'] },
            travel_echo_grace_ms:        { type: ['number', 'string'] },
            failed_command_backoff_ms:   { type: ['number', 'string'] }
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
            fetch_timeout_ms:      { type: ['number', 'string'], required: false },
            conversation_ttl_sec:  { type: ['number', 'string'], required: false },
            max_conversation_turns:{ type: 'number', required: false },
            strip_ai_formatting:   { type: 'boolean', required: false },
            include_chat_history_in_system_calls: { type: 'boolean', required: false }
        }
    },

    //  AI bridge section -- dedicated MQTT channel feeding external prompts into the AI engine.
    ai_bridge: {
        type: 'object',
        required: false,
        properties: {
            enabled:        { type: 'boolean' },
            topic_base:     { type: 'string' },
            forward_events: { type: 'boolean' }
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
            //  Per-kind notification switches, keyed by kind name (dynamic keys, map).
            notify:         { type: 'object' },
            cooldown_ms:    { type: ['number', 'string'] },
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
            device_offline_cooldown_ms: { type: ['number', 'string'] },
            device_offline_ignore:      { type: 'array' },
            zigbee_offline_tts:         { type: 'boolean' },
            zigbee_offline_cooldown_ms: { type: ['number', 'string'] },
            zigbee_offline_ignore:      { type: 'array' },
            zigbee_offline_tts_profile: { type: 'string' },
            zigbee_offline_tts_options: { type: 'object' },
            //  Mission-critical network hosts going offline.
            network_offline_tts:              { type: 'boolean' },
            network_offline_cooldown_ms:      { type: ['number', 'string'] },
            network_offline_ignore:           { type: 'array' },
            network_offline_tts_profile:      { type: 'string' },
            network_offline_tts_options:      { type: 'object' },
            network_offline_announce_boot:    { type: 'boolean' },
            network_offline_announce_recovery:{ type: 'boolean' },
            //  Per-device overrides keyed by device name -- dynamic keys, validated as a map.
            network_offline_devices:          { type: 'object' }
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