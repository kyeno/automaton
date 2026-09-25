/**
 * Single-slot timed action manager with race protection.
 *
 * Encapsulates the pattern several automations / interactions share: exactly one
 * private timer slot, callbacks bound via {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/bind Function.prototype.bind},
 * and a guard so a second request while a timer is running is ignored instead of
 * silently overwriting (or racing) the in-flight one. The timeout handle itself is
 * owned by this class -- callers never touch it directly; they pass an already-bound
 * method reference to {@link start} and call {@link cleanup} on shutdown.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

// ---------------------------------------------------------------------------
// TimedAction class
// ---------------------------------------------------------------------------

/**
 * Single-slot timed action manager.
 *
 * Holds at most one active {@link setTimeout} at a time. Calling {@link start}
 * while a timer is already scheduled returns `false` without scheduling anything,
 * so two racing requests can never occupy the same slot. The callback passed to
 * {@link start} must be pre-bound (`fn.bind(this)`); it runs inside a `try/finally`
 * so the slot is always released even if the callback throws.
 */
export default class TimedAction {
    /** Active timeout handle, or null when no timer occupies the slot. */
    #handle = null

    /** Callback awaiting its scheduled delay; cleared by stop()/cleanup once released. */
    #pendingAction = null

    /**
     * Create a TimedAction instance.
     *
     * @param {string} [name] - Human-readable label used in warning messages
     */
    constructor(name = 'TimedAction') {
        this.name = name
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Schedule `action` to run after `durationMs`.
     *
     * @param {number} durationMs - Delay before the callback fires (ms)
     * @param {Function} action - Already-bound method reference; invoked exactly once
     * @returns {boolean} true when the slot was free and the timer started; false when
     *   a timer was already running and the request was ignored (race protection)
     */
    start(durationMs, action) {
        // Race guard for concurrent external requests: while a timer occupies the slot, a new
        // request returns false without scheduling anything -- so two racing triggers can never
        // arm overlapping countdowns. Self-restarts are different: they happen *inside* the
        // callback after the caller has explicitly released the slot, and those replacements
        // must survive this wrapper's cleanup (see {@link #onTimerEnd}).
        if (this.#handle !== null) {
            return false
        }
        // Hold the pending callback until the scheduled delay elapses; #onTimerEnd releases it.
        // Stored on the instance rather than captured in a closure so the bound method below
        // can invoke it with correct `this` scope.
        this.#pendingAction = action
        // Normal bound-method reference -- never an inline arrow function, which would capture
        // `this` from here rather than from the instance owning the slot.
        this.#handle = setTimeout(this.#onTimerEnd.bind(this), durationMs)
        return true
    }

    /**
     * Runs when the scheduled delay elapses. Invokes the caller-supplied `action` inside a
     * try/finally that releases the slot only if the callback did not replace this timer with
     * a fresh one (the self-restart pattern).
     * @private
     */
    #onTimerEnd() {
        const createdAt = this.#handle
        try {
            this.#pendingAction()
        } finally {
            // Only clear the slot if the callback left whatever we scheduled here. If it replaced
            // this timer with a new one (self-restart pattern), the new handle is owned by the
            // caller and must not be cleared by us.
            if (this.#handle === createdAt) {
                clearTimeout(this.#handle)
                this.#handle = null
            }
        }
    }

    /**
     * Cancel the active timer, if any. No-op when nothing is scheduled.
     *
     * @returns {boolean} true when a timer was cancelled; false when none was active
     */
    stop() {
        if (this.#handle !== null) {
            clearTimeout(this.#handle)
            this.#handle = null
            // Release any held callback -- it will never fire now.
            this.#pendingAction = null
            return true
        }
        return false
    }

    /**
     * Whether a timer currently occupies this slot.
     *
     * @returns {boolean} true while a timer is scheduled
     */
    isActive() {
        return this.#handle !== null
    }

    /**
     * Release the slot on shutdown / cleanup. Equivalent to {@link stop}.
     */
    cleanup() {
        this.stop()
    }
}