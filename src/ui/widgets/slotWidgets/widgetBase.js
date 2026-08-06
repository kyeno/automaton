/**
 * Widget Base -- shared subscription lifecycle for slot widgets.
 *
 * Provides a factory that creates an isolated subscription manager per widget
 * module. Each manager tracks unsubscribe functions and supports clean teardown.
 *
 * @module ui/widgets/slotWidgets/widgetBase
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../../../service/eventBus.js'
import StateService from '../../../service/stateService.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new subscription manager instance.
 * Call once per widget module to get a dedicated registry.
 *
 * @returns {{onEvent, onState, addUnsubscribe, remove, destroy}} Subscription manager
 */
export function createSubscriptionManager() {
    const subs = new Set()

    /**
     * Subscribe to an EventBus channel. The callback is invoked with no arguments
     * (per EventBus.publish semantics) or with forwarded args (per EventBus.emit).
     *
     * @param {string} channel - Event channel name
     * @param {Function} callback - Called when the event fires
     */
    function onEvent(channel, callback) {
        const unsub = EventBus.subscribe(channel, callback)
        subs.add(unsub)
    }

    /**
     * Subscribe to a StateService key change. Callback receives (newValue, oldValue).
     *
     * @param {string} key - StateService key to watch
     * @param {Function} callback - Called as (newValue, oldValue) when key changes
     */
    function onState(key, callback) {
        const unsub = StateService.on(key, callback)
        subs.add(unsub)
    }

    /**
     * Register an arbitrary unsubscribe function returned by EventBus.subscribe
     * or StateService.on for manual tracking.
     *
     * @param {Function} fn - Unsubscribe function
     */
    function addUnsubscribe(fn) {
        if (typeof fn === 'function') subs.add(fn)
    }

    /**
     * Remove a specific subscription from this manager.
     * @param {Function} fn - The unsubscribe function to remove
     */
    function remove(fn) {
        subs.delete(fn)
    }

    /**
     * Tear down all subscriptions tracked by this manager.
     */
    function destroy() {
        for (const unsub of subs) {
            try { unsub() } catch (_e) { /* ignore cleanup errors */ }
        }
        subs.clear()
    }

    return Object.freeze({
        onEvent,
        onState,
        addUnsubscribe,
        remove,
        destroy,
    })
}

export default createSubscriptionManager