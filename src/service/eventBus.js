/**
 * Pub/sub event bus for inter-component communication.
 * Decouples producers (device state changes, network presence transitions)
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import LoggerService from './loggerService.js'

//  EventBus (module-level singleton)

/** Pub/sub event bus for inter-component communication. */
class SEventBus {

    /** Channel -> Set of callback functions.
     * @type {Map<string, Set<Function>>} */
    #subscribers = new Map()

    //  -- Public API -------------------------------------------------------

    /** Publish an event on a channel. No payload is passed;
     * @param {string} channel - The event channel name (e.g., "zigbee:Outdoor Luminance") */
    publish(channel) {
        const callbacks = this.#subscribers.get(channel)
        if (!callbacks) {
            return
        }

        for (const callback of callbacks) {
            try {
                callback()
            } catch (error) {
                //  Prevent one bad subscriber from breaking others.
                this.#reportSubscriberError(channel, error)
            }
        }
    }

    /** Report a failing subscriber without letting its exception.
     * @param {string} channel - Event channel whose subscriber threw
     * @param {*} error - The caught error value
     * @private */
    #reportSubscriberError(channel, error) {
        const detail = error?.message ?? String(error)
        try {
            LoggerService.warn(`[EventBus] Error in subscriber for "${channel}": ${detail}`, 'EventBus')
        } catch {
            console.error(`[EventBus] Error in subscriber for "${channel}":`, error.message)
        }
    }

    /** Emit an event on a channel WITH a payload.
     * @param {string} channel - The event channel name
     * @param {...any} args - Arguments to pass to each subscriber */
    emit(channel, ...args) {
        const callbacks = this.#subscribers.get(channel);
        if (!callbacks) return;

        for (const callback of callbacks) {
            try {
                callback(...args);
            } catch (error) {
                this.#reportSubscriberError(channel, error);
            }
        }
    }

    /** Check whether any subscribers exist for a channel.
     * @param {string} channel - The event channel name
     * @returns {boolean} true if at least one subscriber is registered */
    hasSubscribers(channel) {
        const callbacks = this.#subscribers.get(channel)
        return callbacks && callbacks.size > 0
    }

    /** Subscribe to a channel. Returns an unsubscribe function.
     * @param {string} channel - The event channel name
     * @param {Function} callback - The callback to invoke when the channel publishes
     * @returns {Function} Unsubscribe function */
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

//  Module-level singleton -- ES module caching guarantees single instantiation.
const EventBus = Object.freeze(new SEventBus())
export default EventBus