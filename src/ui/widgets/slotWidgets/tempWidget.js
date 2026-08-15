/**
 * Temperature Slot Widget.
 *
 * Reads the current temperature value from a Zigbee sensor device's cache
 * and renders it according to the configured format string. Also manages
 * event-driven subscriptions so the status bar re-renders when device data changes.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../../../service/eventBus.js'
import DeviceContainer from '../../../device/container/deviceContainer.js'
import { createSubscriptionManager } from './widgetBase.js'
import { round } from '../../../lib/math.js'

const mgr = createSubscriptionManager()

// -- Render -----------------------------------------------------------------

/**
 * Render a temperature reading for the status bar.
 * Uses synchronous last-state access via the device instance.
 * @param {object} config -- { device: string, format: string, label?: string }
 * @returns {{label: string, value: string}} Object with separate label and value parts for independent styling
 */
export default function renderTemp(config = {}) {
    const { device, format } = config
    if (!device) return ''

    const dev = DeviceContainer.findByName(device)
    if (!dev) return ''

    // getStateLast() returns the most recent MQTT payload synchronously.
    const cached = dev.getStateLast()
    if (!cached || cached.temperature === undefined || cached.temperature == null) return ''

    const value = cached.temperature

    // Smart formatting: round to 1 decimal; drop trailing ".0" for whole values
    let displayValue
    if (typeof value === 'number') {
        const rounded = round(value, 1)
        displayValue = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    } else {
        displayValue = String(value)
    }

    // Return structured object so statusBar can style label vs value independently
    const formattedValue = format ? format.replace('{value}', displayValue) : displayValue
    return {
        label: config.label ? `${config.label}: ` : '',
        value: formattedValue,
    }
}

// -- Subscriptions ----------------------------------------------------------

/**
 * Subscribe to Zigbee device events and devices:ready for all configured temp widgets.
 * Call from StatusBar.init() with the list of temp widget configs and a refresh callback.
 *
 * @param {Array<object>} widgetConfigs - Array of temp widget configs from automaton.yaml
 * @param {Function} refreshCallback - Called when any subscribed event fires
 */
export function subscribe(widgetConfigs, refreshCallback) {
    mgr.destroy() // clear stale subscriptions

    for (const cfg of widgetConfigs) {
        if (!cfg.device) continue
        mgr.addUnsubscribe(EventBus.subscribe(`zigbee:${cfg.device}`, refreshCallback))
    }

    // Also react to initial device load
    mgr.addUnsubscribe(EventBus.subscribe('devices:ready', refreshCallback))
}

/**
 * Tear down all temp widget subscriptions.
 */
export function unsubscribe() {
    mgr.destroy()
}