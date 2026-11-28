/**
 * Configurable playback of local sound assets through argv pipelines (no shell).
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

const DEFAULT_PLAYERS = new Map([
    ['mp3', [
        ['mpg123', '-q', '-s', '-r', '44100', '--stereo', '-e', 's16', '{file}'],
        ['aplay', '-q', '-D', 'default', '-t', 'raw', '-f', 'S16_LE', '-r', '44100', '-c', '2', '-']
    ]],
    ['wav', [['aplay', '-q', '-D', 'default', '{file}']]]
])
const DEFAULT_TIMEOUT_MS = 60_000

/** Validate a pipeline before starting any children.
 * @param {unknown} stages - Array of command vectors
 * @returns {boolean} Whether the pipeline is valid */
export function isSoundPipeline(stages) {
    return Array.isArray(stages) && stages.length > 0 && stages.every((argv, index) =>
        Array.isArray(argv) && argv.length > 0 && typeof argv[0] === 'string' && argv[0].trim() !== '' &&
        argv[0] !== '{file}' && argv.every(arg => typeof arg === 'string' && !arg.includes('\0')) &&
        (index === 0 ? argv.slice(1).filter(arg => arg === '{file}').length === 1 : !argv.includes('{file}')))
}

/** Play an asset on this host without using or serializing the TCP TTS path.
 * @param {string} filename - Asset basename under sounds.directory
 * @returns {Promise<void>} Resolves when all playback processes finish; rejects on failure */
export async function playSound(filename) {
    if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('\0')) {
        throw new Error('Sound must be a filename in the configured sounds directory')
    }
    const config = ConfigService.get('sounds', {})
    const extension = path.extname(filename).slice(1).toLowerCase()
    const overrides = config.players ?? {}
    const stages = Object.hasOwn(overrides, extension) ? overrides[extension] : DEFAULT_PLAYERS.get(extension)
    if (!isSoundPipeline(stages)) throw new Error(`No valid sound player configured for .${extension}`)
    const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new Error('sounds.timeout_ms must be a positive timer duration in milliseconds')
    }

    const directory = await realpath(path.resolve(PROJECT_ROOT, config.directory ?? 'share/sounds'))
    const file = await realpath(path.join(directory, filename))
    if (path.dirname(file) !== directory || !(await stat(file)).isFile()) throw new Error('Sound must be a regular file inside the sounds directory')

    const children = []
    const tasks = []
    const controller = new AbortController()
    const timeoutError = new Error(`Sound playback timed out after ${timeoutMs} ms`)
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
    try {
        for (const [index, [command, ...args]] of stages.entries()) {
            const child = spawn(command, args.map(arg => arg === '{file}' ? file : arg), {
                stdio: [index === 0 ? 'ignore' : 'pipe', index === stages.length - 1 ? 'ignore' : 'pipe', 'ignore'],
                signal: controller.signal,
                killSignal: 'SIGKILL'
            })
            children.push(child)
            tasks.push(new Promise((resolve, reject) => {
                child.once('error', reject)
                child.once('close', (code, signal) => {
                    if (code === 0) resolve()
                    else reject(new Error(`${command} playback stage exited with ${signal ?? code}`))
                })
            }))
            if (index > 0) tasks.push(pipeline(children[index - 1].stdout, child.stdin))
        }
        await Promise.all(tasks)
    } catch (error) {
        controller.abort()
        await Promise.allSettled(tasks)
        throw controller.signal.reason === timeoutError ? timeoutError : error
    } finally {
        clearTimeout(timer)
    }
}
