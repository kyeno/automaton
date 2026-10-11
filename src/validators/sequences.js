/**
 * Validator schema for etc/sequence/sequences.yaml (sequence definitions).
 * Loaded automatically by ConfigBase when section name is "sequences". Shallow on
 * purpose: deeper per-entry semantics (exactly one of devices/on, duplicate slugs,
 * duration parsing) are validated in SequenceContainer.init() with warn+skip.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

export default {
    sequences: {
        type: 'array',
        required: false,
        items: {
            properties: {
                name:     { type: 'string', required: true },
                delay_ms: { type: ['number', 'string'] },
                devices:  { type: 'array' },
                on:       { type: 'array' },
                off:      { type: 'array' },
                loop: {
                    type: 'object',
                    properties: {
                        enabled:      { type: 'boolean' },
                        cycle:        { enum: ['once', 'continuous'] },
                        off_delay_ms: { type: ['number', 'string'] },
                        on_delay_ms:  { type: ['number', 'string'] }
                    }
                }
            }
        }
    }
}