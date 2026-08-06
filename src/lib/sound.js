/**
 * Sound utilities for playing system audio alerts.
 *
 * Uses the `beep` CLI program (from the `beep` package) to produce
 * an audible tone through the PC speaker. Requires `beep` to be
 * installed on the target machine and executed with appropriate
 * privileges (typically root/CAP_SYS_TTY_CONFIG).
 *
 * The module exports a frozen singleton carrying:
 * - **Beep predicates**: `beep()`, `doubleBeep()`
 * - **Music themes**: `mario()`, `marioGameOver()`
 *
 * @module lib/sound
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno, AI Refiner
 * @license AGPL-3.0-only
 */
'use strict'

import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default beep frequency in Hertz.
 * @type {number}
 */
const DEFAULT_FREQUENCY_HZ = 1_200

/**
 * Default beep duration in milliseconds.
 * @type {number}
 */
const DEFAULT_DURATION_MS = 200

/**
 * Number of repetitions for doubleBeep.
 * @type {number}
 */
const DOUBLE_BEEP_REPEATS = 2

/**
 * First 7 notes of the Super Mario Bros opening theme.
 * Aligned to a strict 150ms eighth-note grid with proper staccato gaps.
 * @type {Array}
 */
const MARIO_NOTES = [
    [659, 100], [0, 50],   // E5
    [659, 100], [0, 200],  // E5 + pause
    [659, 100], [0, 200],  // E5 + pause
    [523, 100], [0, 50],   // C5
    [659, 200], [0, 100],  // E5
    [784, 200], [0, 400],  // G5 + pause
    [392, 200]             // G4
]

/**
 * Super Mario Bros Death / Lose a Life theme (the first part of the Game Over sequence).
 * Corrected to 6 notes on a strict triplet grid (~154ms total per step) to match the original video speed.
 * Pattern: B4, F5, [dramatic triplet pause], F5, E5, D5, C5 (long sustained syncopation).
 * @type {Array}
 */
const MARIO_GAME_OVER_NOTES = [
    [494, 110], [0, 44],   // B4 (triplet 1)
    [698, 110], [0, 198],  // F5 (triplet 2) + hanging silence (triplet 3)
    [698, 110], [0, 44],   // F5 (triplet 4)
    [659, 110], [0, 44],   // E5 (triplet 5)
    [587, 110], [0, 44],   // D5 (triplet 6)
    [523, 750]             // C5 - long syncopated note (exactly 2nd-3rd second of video)
]

// ---------------------------------------------------------------------------
// Sound Class
// ---------------------------------------------------------------------------

/**
 * Provides sound utility methods for playing system audio alerts.
 *
 * Methods are backed by the `beep` CLI program and support both
 * callback-based and fire-and-forget calling conventions.
 */
class Sound {

    // -- Private helpers ----------------------------------------------------

    /**
     * Spawn a single beep and return a promise that resolves when done.
     *
     * @param {number} frequency - Frequency in Hz.
     * @param {number} duration  - Duration in milliseconds.
     * @return {Promise<void>}
     * @private
     */
    #beep(frequency, duration) {
        return new Promise((resolve) => {
            const args = ['-f', String(frequency), '-l', String(duration)]
            const proc = spawn('beep', args, { stdio: 'ignore' })

            proc.on('error', () => resolve())
            proc.on('close', () => resolve())
        })
    }

    /**
     * Pause for a given number of milliseconds.
     *
     * @param {number} ms - Milliseconds to wait.
     * @return {Promise<void>}
     * @private
     */
    #pause(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /**
     * Play a sequence of [frequency, duration] pairs asynchronously.
     * A frequency of 0 is treated as a pause.
     *
     * @param {Array.<number[]>} notes - Array of [freq, dur] pairs.
     * @param {function} [callback] - Optional callback invoked when sequence completes.
     * @returns {Promise<void>}
     * @private
     */
    async #playSequence(notes, callback) {
        let hadError = false

        for (const [freq, dur] of notes) {
            if (freq === 0) {
                await this.#pause(dur)
            } else {
                try {
                    await this.#beep(freq, dur)
                } catch {
                    hadError = true
                }
            }
        }

        if (callback) {
            callback(hadError ? 'one or more beeps failed' : undefined)
        }
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Plays an audible beep using the `beep` CLI program.
     * Arrow function ensures stable `this` binding when extracted from the frozen singleton.
     *
     * @param {object} [options] - Optional configuration.
     * @param {number} [options.frequency=1200] - Frequency in Hz.
     * @param {number} [options.duration=200] - Duration in milliseconds.
     * @param {function} [options.callback] - Callback invoked on error or completion.
     */
    beep = (options) => {
        const { frequency = DEFAULT_FREQUENCY_HZ, duration = DEFAULT_DURATION_MS, callback } = options || {}

        const args = []
        if (frequency != null) args.push('-f', String(frequency))
        if (duration != null) args.push('-l', String(duration))

        const proc = spawn('beep', args, { stdio: 'ignore' })
        let called = false

        proc.on('error', (err) => {
            if (!called) {
                called = true
                callback && callback(err.message)
            }
        })

        proc.on('close', (code) => {
            if (!called) {
                called = true
                if (code !== 0) {
                    callback && callback(`beep exited with code ${code}`)
                } else {
                    callback && callback()
                }
            }
        })
    }

    /**
     * Plays two consecutive beeps using the `beep` CLI built-in repeat flag.
     * Arrow function ensures stable `this` binding when extracted from the frozen singleton.
     *
     * @param {object} [options] - Optional configuration.
     * @param {number} [options.frequency=1200] - Frequency in Hz.
     * @param {number} [options.duration=200] - Duration in milliseconds.
     * @param {function} [options.callback] - Callback invoked on error or completion.
     */
    doubleBeep = (options) => {
        const { frequency = DEFAULT_FREQUENCY_HZ, duration = DEFAULT_DURATION_MS, callback } = options || {}

        const args = []
        if (frequency != null) args.push('-f', String(frequency))
        if (duration != null) args.push('-l', String(duration))
        args.push('-r', String(DOUBLE_BEEP_REPEATS))

        const proc = spawn('beep', args, { stdio: 'ignore' })
        let called = false

        proc.on('error', (err) => {
            if (!called) {
                called = true
                callback && callback(err.message)
            }
        })

        proc.on('close', (code) => {
            if (!called) {
                called = true
                if (code !== 0) {
                    callback && callback(`beep exited with code ${code}`)
                } else {
                    callback && callback()
                }
            }
        })
    }

    /**
     * Plays the Super Mario Bros overworld theme intro.
     * Fire-and-forget: returns immediately, errors are suppressed.
     * Arrow function ensures stable `this` binding when extracted from the frozen singleton.
     *
     * @param {object} [options] - Optional configuration.
     * @param {function} [options.callback] - Callback invoked when melody completes.
     */
    mario = (options) => {
        this.#playSequence(MARIO_NOTES, options?.callback).catch(() => {
            // Suppress unhandled rejection
        })
    }

    /**
     * Plays the Super Mario Bros Lose a Life / Game Over theme.
     * Fire-and-forget: returns immediately, errors are suppressed.
     * Arrow function ensures stable `this` binding when extracted from the frozen singleton.
     *
     * @param {object} [options] - Optional configuration.
     * @param {function} [options.callback] - Callback invoked when melody completes.
     */
    marioGameOver = (options) => {
        this.#playSequence(MARIO_GAME_OVER_NOTES, options?.callback).catch(() => {
            // Suppress unhandled rejection
        })
    }
}

// ---------------------------------------------------------------------------
// Export frozen singleton
// ---------------------------------------------------------------------------

/**
 * Frozen singleton instance providing sound utility methods.
 *
 * All beep and music methods use the `beep` CLI program internally;
 * callback argument is optional for fire-and-forget usage.
 */
export default Object.freeze(new Sound())