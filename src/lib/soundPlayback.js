/**
 * Configurable playback of local sound files without a shell.
 * @module lib/soundPlayback
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import ConfigService from '../service/configService.js'
import PROJECT_ROOT from './projectRoot.js'


// --- Constants ----------------------------------------------------------

/** Default playback pipelines by file extension.
 * @type {Map<string, string[][]>} */
const DEFAULT_PLAYERS = new Map([
    ['mp3', [
        ['mpg123', '-q', '-s', '-r', '44100', '--stereo', '-e', 's16', '{file}'],
        ['aplay', '-q', '-D', 'default', '-t', 'raw', '-f', 'S16_LE', '-r', '44100', '-c', '2', '-']
    ]],
    ['wav', [['aplay', '-q', '-D', 'default', '{file}']]]
])

/** Default playback deadline in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Largest delay accepted by Node timers in milliseconds. */
const MAX_TIMEOUT_MS = 2_147_483_647

const DEFAULT_DIRECTORY = 'share/sounds'
const FILE_ARGUMENT = '{file}'

/** Validate a pipeline before starting any children.
 * @param {unknown} stages - Array of command vectors
 * @returns {boolean} Whether the pipeline is valid */
export function isSoundPipeline(stages) {
    if (!Array.isArray(stages) || stages.length === 0) return false

    for (const [index, argv] of stages.entries()) {
        if (!Array.isArray(argv) || argv.length === 0) return false
        if (!argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))) return false

        const [command, ...args] = argv
        if (!command?.trim() || command === FILE_ARGUMENT) return false

        const fileArguments = args.filter(arg => arg === FILE_ARGUMENT).length
        if (fileArguments !== (index === 0 ? 1 : 0)) return false
    }

    return true
}

// --- Class Definition ---------------------------------------------------

/** Plays local MP3 and WAV files independently of the TCP TTS path.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
class SSoundPlayback {

    /** Play an asset using the configured commands for its file extension.
     * @param {string} filename - Asset basename under sounds.directory
     * @param {{signal?: AbortSignal}} [options] - Optional caller cancellation
     * @returns {Promise<void>} Resolves when playback finishes; rejects on failure */
    async playSound(filename, { signal } = {}) {
        signal?.throwIfAborted()
        const config = ConfigService.get('sounds', {})
        const stages = this.#selectStages(filename, config.players ?? {})
        const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
            throw new Error('sounds.timeout_ms must be a positive timer duration in milliseconds')
        }

        const file = await this.#resolveFile(filename, config.directory ?? DEFAULT_DIRECTORY)
        signal?.throwIfAborted()
        await this.#runPipeline(stages, file, timeoutMs, signal)
    }

    /** Check an asset without spawning a playback process.
     * @param {string} filename - Asset basename
     * @returns {Promise<boolean>} Whether a playable file is installed */
    async hasSound(filename) {
        try {
            const config = ConfigService.get('sounds', {})
            await this.#resolveFile(filename, config.directory ?? DEFAULT_DIRECTORY)
            this.#selectStages(filename, config.players ?? {})
            return true
        } catch {
            return false
        }
    }

    // --- Private helpers ------------------------------------------------

    /** Select and validate a configured or default pipeline.
     * @private
     * @param {string} filename - Local asset basename
     * @param {Object} players - File-extension player overrides
     * @returns {string[][]} Pipeline command vectors */
    #selectStages(filename, players) {
        const extension = path.extname(filename).slice(1).toLowerCase()
        const stages = Object.hasOwn(players, extension) ? players[extension] : DEFAULT_PLAYERS.get(extension)
        if (!isSoundPipeline(stages)) throw new Error(`No valid sound player configured for .${extension}`)
        return stages
    }

    /** Resolve the asset and reject symlinks that leave the sound directory.
     * @private
     * @param {string} filename - Local asset basename
     * @param {string} directory - Configured sound directory
     * @returns {Promise<string>} Absolute asset path */
    async #resolveFile(filename, directory) {
        if (typeof filename !== 'string' || !filename || filename.includes('\0') || filename !== path.basename(filename)) {
            throw new Error('Sound must be a filename in the configured sounds directory')
        }
        const root = await realpath(path.resolve(PROJECT_ROOT, directory))
        const file = await realpath(path.join(root, filename))
        if (path.dirname(file) !== root || !(await stat(file)).isFile()) {
            throw new Error('Sound must be a regular file inside the sounds directory')
        }
        return file
    }

    /** Connect consecutive stages and stop the entire pipeline on failure.
     * @private
     * @param {string[][]} stages - Pipeline command vectors
     * @param {string} file - Absolute asset path
     * @param {number} timeoutMs - Maximum playback duration
     * @param {AbortSignal} [signal] - Optional caller cancellation */
    async #runPipeline(stages, file, timeoutMs, signal) {
        const tasks = []
        const controller = new AbortController()
        const timeoutError = new Error(`Sound playback timed out after ${timeoutMs} ms`)
        const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
        const abort = () => controller.abort(signal.reason)
        signal?.addEventListener('abort', abort, { once: true })

        try {
            signal?.throwIfAborted()
            let upstream = null
            for (const [index, [command, ...args]] of stages.entries()) {
                const stdin = upstream ? 'pipe' : 'ignore'
                const stdout = index < stages.length - 1 ? 'pipe' : 'ignore'
                const child = spawn(command, args.map(arg => arg === FILE_ARGUMENT ? file : arg), {
                    stdio: [stdin, stdout, 'ignore'],
                    signal: controller.signal,
                    killSignal: 'SIGKILL'
                })

                tasks.push(this.#waitForStage(child, command))
                if (upstream) tasks.push(pipeline(upstream, child.stdin))
                upstream = child.stdout
            }

            await Promise.all(tasks)
        } catch (error) {
            const failure = controller.signal.aborted ? controller.signal.reason : error
            controller.abort()
            await Promise.allSettled(tasks)
            throw failure
        } finally {
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
        }
    }

    /** Resolve only if the child exits successfully.
     * @private
     * @param {import('node:child_process').ChildProcess} child - Spawned stage
     * @param {string} command - Stage executable for diagnostics */
    #waitForStage(child, command) {
        return new Promise((resolve, reject) => {
            let failure
            child.once('error', error => { failure = error })
            child.once('close', (code, signal) => {
                if (failure) reject(failure)
                else if (code === 0) resolve()
                else reject(new Error(`${command} playback stage exited with ${signal ?? code}`))
            })
        })
    }
}

// --- Singleton Export ---------------------------------------------------

const SoundPlayback = Object.freeze(new SSoundPlayback())

/** Play a local sound file through the configured playback pipeline.
 * @param {string} filename - Asset basename under sounds.directory
 * @param {{signal?: AbortSignal}} [options] - Optional caller cancellation
 * @returns {Promise<void>} Resolves after playback; rejects on failure */
export function playSound(filename, options) {
    return SoundPlayback.playSound(filename, options)
}

/** Check for an installed local asset without playing it.
 * @param {string} filename - Asset basename
 * @returns {Promise<boolean>} Whether a playable file is installed */
export function hasSound(filename) {
    return SoundPlayback.hasSound(filename)
}
