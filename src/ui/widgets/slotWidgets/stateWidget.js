/**
 * State Slot Widget.
 *
 * Generic boolean-state reader from StateService with configurable icons
 * for true/false values and an optional label. Returns structured data
 * so the caller can style icon and label independently. Also manages
 * event-driven subscriptions so the status bar re-renders when tracked
 * state keys change.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import StateService from '../../../service/stateService.js'
import { createSubscriptionManager } from './widgetBase.js'

const mgr = createSubscriptionManager()

// -- Render -----------------------------------------------------------------

/**
 * Render a boolean state indicator for the status bar.
 *
 * @param {object} config -- { key: string, iconTrue?: string, iconFalse?: string, label?: string }
 * @returns {{ icon: string, label: string }} Structured result for independent styling
 */
export default function renderState(config = {}) {
    const { key, iconTrue, iconFalse, label } = config
    if (!key) return { icon: '', label: '' }

    const value = StateService.get(key)
    const isTrue = value === true

    const icon = isTrue
        ? (iconTrue || '●')
        : (iconFalse || '○')

    return { icon, label: label || '' }
}

// -- Subscriptions ----------------------------------------------------------

/**
 * Subscribe to StateService key changes for all configured state widgets.
 * Deduplicates by key so multiple widgets watching the same key only produce
 * one listener. Call from StatusBar.init().
 *
 * @param {Array<object>} widgetConfigs - Array of state widget configs
 * @param {Function} refreshCallback - Called when any tracked key changes
 */
export function subscribe(widgetConfigs, refreshCallback) {
    mgr.destroy() // clear stale subscriptions

    const seenKeys = new Set()
    for (const cfg of widgetConfigs) {
        if (!cfg.key || seenKeys.has(cfg.key)) continue
        seenKeys.add(cfg.key)
        mgr.onState(cfg.key, refreshCallback)
    }
}

/**
 * Tear down all state widget subscriptions.
 */
export function unsubscribe() {
    mgr.destroy()
}