/**
 * Runtime State Service.
 *
 * Central key/value store for system-wide runtime state. Components query
 * and react to state changes without importing each other directly,
 * breaking circular dependencies.
 *
 * Current keys:
 *   - ui.active                        (boolean) -- UI is running and accepting input
 *   - cli.noUi                         (boolean) -- CLI --no-ui flag was passed
 *   - cli.noTrace                      (boolean) -- CLI --no-trace flag was passed
 *   - cli.noAi                         (boolean) -- CLI --no-ai flag was passed
 *   - cli.noTts                        (boolean) -- CLI --no-tts flag was passed
 *   - lifecycle.initializedServices    (Set<string>) -- names of successfully initialized services
 *   - lifecycle.shuttingDown           (boolean) -- true once graceful shutdown has started
 *   - lifecycle.lastError              (Error|null) -- last uncaught exception or rejection reason
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import LoggerService from './loggerService.js'

// ---------------------------------------------------------------------------
// StateService (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * Thread-safe (single-threaded Node) state registry with change listeners.
 * ES module caching guarantees single instantiation.
 */
class SStateService {

    /** @type {Map<string, any>} */
    #state = new Map()

    /** @type {Map<string, Set<Function>>} */
    #listeners = new Map()

    // -- Public API -------------------------------------------------------

    /**
     * Read the current value for a key.
     * @param {string} key
     * @returns {any}
     */
    get(key) {
        return this.#state.get(key)
    }

    /**
     * Set a key and notify listeners only when the value actually changes.
     * @param {string} key
     * @param {any} value
     */
    set(key, value) {
        const old = this.#state.get(key)
        if (old === value) return
        this.#state.set(key, value)
        this.#emit(key, value, old)
    }

    /**
     * Subscribe to changes on a specific key.
     * @param {string} key
     * @param {Function} callback  -- called as (newValue, oldValue)
     * @returns {Function} Unsubscribe function
     */
    on(key, callback) {
        if (!this.#listeners.has(key)) {
            this.#listeners.set(key, new Set())
        }
        this.#listeners.get(key).add(callback)

        return () => {
            const subs = this.#listeners.get(key)
            if (subs) {
                subs.delete(callback)
                if (subs.size === 0) this.#listeners.delete(key)
            }
        }
    }

    /**
     * Dump all state (useful for debugging / status windows).
     * @returns {Record<string, any>}
     */
    dump() {
        const obj = {}
        for (const [k, v] of this.#state) obj[k] = v
        return obj
    }

    // -- Internal ---------------------------------------------------------

    #emit(key, newValue, oldValue) {
        const callbacks = this.#listeners.get(key)
        if (!callbacks) return
        for (const cb of callbacks) {
            try { cb(newValue, oldValue) }
            catch (e) {
                // Route through the logger so UI mode keeps raw stderr writes away
                // from the TUI layout; fall back to plain stderr pre-init.
                try {
                    LoggerService.warn(
                        `[StateService] Listener error on "${key}": ${e?.message ?? String(e)}`,
                        'StateService'
                    )
                } catch {
                    console.error(`[StateService] Listener error on "${key}":`, e.message)
                }
            }
        }
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const StateService = Object.freeze(new SStateService())
export default StateService