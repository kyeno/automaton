/**
 * Single-slot timed action manager with race protection.
 * Encapsulates the pattern several automations / interactions share: exactly one.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

//  TimedAction class.

/** Single-slot timed action manager. */
export default class TimedAction {
    /** Active timeout handle, or null when no timer occupies the slot. */
    #handle = null

    /** Callback awaiting its scheduled delay; cleared by stop()/cleanup once released. */
    #pendingAction = null

    /** Create a TimedAction instance.
     * @param {string} [name] - Human-readable label used in warning messages */
    constructor(name = 'TimedAction') {
        this.name = name
    }

    //  -- Public API ---------------------------------------------------------

    /** Schedule `action` to run after `durationMs`.
     * @param {number} durationMs - Delay before the callback fires (ms)
     * @param {Function} action - Already-bound method reference; invoked exactly once
     * @returns {boolean} true when the slot was free and the timer started; false when */
    start(durationMs, action) {
        //  Race guard for concurrent external requests: while a timer occupies the slot, a new.
        if (this.#handle !== null) {
            return false
        }
        //  Hold the pending callback until the scheduled delay elapses; #onTimerEnd releases it.
        this.#pendingAction = action
        //  Normal bound-method reference -- never an inline arrow function, which would capture.
        this.#handle = setTimeout(this.#onTimerEnd.bind(this), durationMs)
        return true
    }

    /** Runs when the scheduled delay elapses. Invokes the caller-supplied `action` inside a
     * @private */
    #onTimerEnd() {
        const createdAt = this.#handle
        try {
            this.#pendingAction()
        } finally {
            //  Only clear the slot if the callback left whatever we scheduled here. If it replaced.
            if (this.#handle === createdAt) {
                clearTimeout(this.#handle)
                this.#handle = null
            }
        }
    }

    /** Cancel the active timer, if any. No-op when nothing is scheduled.
     * @returns {boolean} true when a timer was cancelled; false when none was active */
    stop() {
        if (this.#handle !== null) {
            clearTimeout(this.#handle)
            this.#handle = null
            //  Release any held callback -- it will never fire now.
            this.#pendingAction = null
            return true
        }
        return false
    }

    /** Whether a timer currently occupies this slot.
     * @returns {boolean} true while a timer is scheduled */
    isActive() {
        return this.#handle !== null
    }

    /** Release the slot on shutdown / cleanup. Equivalent to {@link stop}. */
    cleanup() {
        this.stop()
    }
}