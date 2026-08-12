#!/usr/bin/env node
/**
 * Numeric utilities.
 *
 * Provides a simple rounding function that strips trailing decimals beyond
 * one decimal place (e.g., 23.0 → 23, 23.456 → 23.5). Useful for sensor
 * values displayed to users or spoken via TTS, where extra precision is
 * noisy and unnecessary.
 *
 * @module lib/math
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Round a number to at most `precision` decimal places, returning an integer
 * when the result has no fractional part.
 *
 * Examples:
 *   round(23.0, 1)    → 23
 *   round(23.456, 1)  → 23.5
 *   round(98.7, 1)    → 98.7
 *   round(100, 1)     → 100
 *
 * @param {number} value - The number to round
 * @param {number} [precision=1] - Maximum decimal places (default: 1)
 * @returns {number} Rounded value (integer if fractional part is zero)
 */
export function round(value, precision = 1) {
    const factor = Math.pow(10, precision)
    const rounded = Math.round(value * factor) / factor
    // Return plain integer when there's no fractional remainder
    return Number.isInteger(rounded) ? rounded : rounded
}
