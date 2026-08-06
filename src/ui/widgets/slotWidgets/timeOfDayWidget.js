/**
 * Time-of-Day Slot Widget.
 *
 * Renders the current time-of-day period (morning, noon, afternoon, evening, night)
 * using the Temporal utility from lib/date.js.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import dateLib from '../../../lib/date.js'

/**
 * Render the current time-of-day period for the status bar.
 * @param {object} config -- Optional configuration (currently unused).
 * @returns {string} The current time period name (e.g., "morning", "noon")
 */
export default function renderTimeOfDay(_config = {}) {
    const period = dateLib.getCurrentTimePeriod()
    return period || ''
}