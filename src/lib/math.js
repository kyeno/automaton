/**
 * Numeric utilities.
 * Provides a simple rounding function that strips trailing decimals beyond.
 * @module lib/math
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

//  Utility functions.

/** Round a number to at most `precision` decimal places, returning an integer.
 * @param {number} value - The number to round
 * @param {number} [precision=1] - Maximum decimal places (default: 1)
 * @returns {number} Rounded value (integer if fractional part is zero) */
export function round(value, precision = 1) {
    const factor = Math.pow(10, precision)
    //  JS numbers carry no trailing zeros.
    return Math.round(value * factor) / factor
}
