/**
 * Validator schema for etc/automaton.yaml (main configuration).
 *
 * Loaded automatically by ConfigBase when section name is "main".
 * Schema format: each key defines expected type, required flag, enum values,
 * nested properties, or array item schemas.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

export default {
    // Top-level duration settings -- legacy plain number or human-readable string ("25m")
    human_interaction_cooldown_ms: { type: ['number', 'string'], required: false },

    // i18n section
    ai_language: { type: 'string', enum: ['pl', 'en'], required: true },
    time_format: { type: 'string', enum: ['12h', '24h'], required: true },

    // AI section
    model: { type: 'string', required: true },
    max_tokens: { type: 'number', required: true },
    temperature: { type: 'number', required: true },
    conversation_ttl_sec: { type: ['number', 'string'], required: false },
    max_conversation_turns: { type: 'number', required: false },
    stupid_ai_engine: { type: 'boolean', required: false },

    // Paths section (optional - provides config file paths and directory paths)
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

    // Logger section
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

    // UI section
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