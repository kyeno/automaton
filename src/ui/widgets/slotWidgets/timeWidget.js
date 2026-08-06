/**
 * Time Slot Widget.
 *
 * Renders the current local time respecting the global time_format setting
 * from i18n.yaml (12h vs 24h). Delegates to the shared formatTime() helper.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { formatTime } from '../../../lib/terminal.js'

/**
 * Render current time for the status bar.
 * @param {Object} [widget] - Widget config with optional render_seconds flag
 * @returns {string} Formatted time text (e.g., "02:25am" or "14:05")
 */
export default function renderTime(widget) {
    // render_seconds defaults to true (show seconds) when not specified
    const includeSeconds = widget?.render_seconds !== false
    return formatTime(new Date(), includeSeconds)
}
