/**
 * AnsiColors -- common ANSI SGR color codes for terminal output.
 *
 * Single source of truth for every colored string rendered by the UI or
 * printed to stderr. Frozen so values cannot be mutated at runtime, and free
 * of any dependencies so it can be used even from early-boot crash handlers
 * before services are initialized.
 *
 * @module enum/ansiColors
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

/**
 * Common ANSI SGR color codes for terminal output.
 *
 * @readonly
 * @enum {string}
 */
const AnsiColors = Object.freeze({
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    italic:  '\x1b[3m',
    cyan:    '\x1b[36m',
    green:   '\x1b[32m',
    magenta: '\x1b[35m',
    yellow:  '\x1b[33m',
    red:     '\x1b[31m',
    grey:    '\x1b[90m',
    white:   '\x1b[97m',
})

export default AnsiColors