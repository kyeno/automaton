/**
 * Text Slot Widget.
 *
 * Renders a static label with optional connected/disconnected icon state.
 * Used for service status indicators (MQTT, Redis, etc.) in the status bar.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import StateService from '../../../service/stateService.js'

/**
 * Render a labeled text slot with optional connection indicator.
 * @param {object} config -- { label: string, iconConnected?: string, iconDisconnected?: string }
 * @returns {string} Formatted text with optional icon prefix
 */
export default function renderText(config = {}) {
    const { label, iconConnected, iconDisconnected } = config
    if (!label) return ''

    // If no icons configured, just show the label
    if (!iconConnected && !iconDisconnected) {
        return `${label}`
    }

    // Check state key derived from label (e.g., "MQTT" -> "mqtt.connected")
    const stateKey = `${label.toLowerCase()}.connected`
    const connected = StateService.get(stateKey)

    const icon = (connected === true ? iconConnected : iconDisconnected) || ''
    return icon ? ` ${icon}${label} ` : ` ${label}`
}