/**
 * Pub/sub event bus for inter-component communication.
 *
 * Decouples producers (device state changes, network presence transitions)
 * from consumers (automations, interactions). Events carry no payload --
 * subscribers read fresh state from CacheService or DeviceContainer themselves,
 * avoiding stale data propagation.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

// ---------------------------------------------------------------------------
// EventBus (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * Pub/sub event bus for inter-component communication.
 *
 * Channels map to a set of callback functions. Publishers trigger all
 * registered callbacks on a channel; subscribers return an unsubscribe
 * function for clean teardown. Individual subscriber errors are caught
 * so one bad callback never silences the rest.
 * ES module caching guarantees single instantiation.
 */
class SEventBus {

    /**
     * Channel -> Set of callback functions.
     * @type {Map<string, Set<Function>>}
     */
    #subscribers = new Map()

    // -- Public API -------------------------------------------------------

    /**
     * Publish an event on a channel. No payload is passed;
     * subscribers react by reading fresh state themselves.
     *
     * @param {string} channel - The event channel name (e.g., "zigbee:Outdoor Luminance")
     */
    publish(channel) {
        const callbacks = this.#subscribers.get(channel)
        if (!callbacks) {
            return
        }

        for (const callback of callbacks) {
            try {
                callback()
            } catch (error) {
                // Prevent one bad subscriber from breaking others
                console.error(`[EventBus] Error in subscriber for "${channel}":`, error.message)
            }
        }
    }

    /**
     * Emit an event on a channel WITH a payload. Unlike publish(),
     * this forwards arguments to subscribers so consumers can react
     * to dynamic data (e.g., window activity IDs).
     *
     * @param {string} channel - The event channel name
     * @param {...any} args - Arguments to pass to each subscriber
     */
    emit(channel, ...args) {
        const callbacks = this.#subscribers.get(channel);
        if (!callbacks) return;

        for (const callback of callbacks) {
            try {
                callback(...args);
            } catch (error) {
                console.error(`[EventBus] Error in subscriber for "${channel}":`, error.message);
            }
        }
    }

    /**
     * Check whether any subscribers exist for a channel.
     * Used to guard UI-specific emits during --no-ui service runs.
     *
     * @param {string} channel - The event channel name
     * @returns {boolean} true if at least one subscriber is registered
     */
    hasSubscribers(channel) {
        const callbacks = this.#subscribers.get(channel)
        return callbacks && callbacks.size > 0
    }

    /**
     * Subscribe to a channel. Returns an unsubscribe function.
     *
     * @param {string} channel - The event channel name
     * @param {Function} callback - The callback to invoke when the channel publishes
     * @returns {Function} Unsubscribe function
     */
    subscribe(channel, callback) {
        if (!this.#subscribers.has(channel)) {
            this.#subscribers.set(channel, new Set())
        }
        this.#subscribers.get(channel).add(callback)

        return () => {
            const subs = this.#subscribers.get(channel)
            if (subs) {
                subs.delete(callback)
                if (subs.size === 0) {
                    this.#subscribers.delete(channel)
                }
            }
        }
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const EventBus = Object.freeze(new SEventBus())
export default EventBus