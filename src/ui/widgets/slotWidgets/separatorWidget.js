/**
 * Separator Slot Widget.
 *
 * Renders a static character as visual separation between status bar slots.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/**
 * @param {object} config -- Slot configuration from etc/automaton.yaml
 * @returns {string} Rendered separator text
 */
export default function renderSeparator(config = {}) {
    const char = config.char || '|'
    return `${char} `
}