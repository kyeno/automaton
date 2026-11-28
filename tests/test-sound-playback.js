/**
 * Exercise local sound pipelines without audio hardware or decoder binaries.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import ConfigService from '../src/service/configService.js'
import { playSound } from '../src/lib/sound.js'
import { hasSound } from '../src/lib/soundPlayback.js'

const directory = await mkdtemp(path.join(os.tmpdir(), 'automaton-sound-'))
const filename = 'a space; $literal.MP3'
const output = path.join(directory, 'output')
const copy = 'process.stdin.pipe(require("node:fs").createWriteStream(process.argv[1]))'
const read = 'require("node:fs").createReadStream(process.argv[1]).pipe(process.stdout)'
const command = (script, ...args) => [process.execPath, '-e', script, ...args]
const config = { directory, timeout_ms: 5_000, players: {
    mp3: [command(read, '{file}'), command(copy, output)],
    wav: [command('require("node:fs").copyFileSync(process.argv[1], process.argv[2])', '{file}', output)]
} }

mock.method(Object.getPrototypeOf(ConfigService), 'get', key => {
    assert.equal(key, 'sounds')
    return config
})
try {
    await writeFile(path.join(directory, filename), 'decoder input')
    await playSound(filename)
    assert.equal(await readFile(output, 'utf8'), 'decoder input')
    await writeFile(path.join(directory, 'sound.wav'), 'direct playback')
    await playSound('sound.wav')
    assert.equal(await readFile(output, 'utf8'), 'direct playback')

    await assert.rejects(playSound('../sound.wav'), /filename/)
    await assert.rejects(playSound('sound.unknown'), /No valid sound player/)
    await symlink(process.execPath, path.join(directory, 'escape.wav'))
    await assert.rejects(playSound('escape.wav'), /inside the sounds directory/)
    config.players.mp3 = [command(read, '{file}'), ['{file}']]
    await assert.rejects(playSound(filename), /No valid sound player/)
    config.players.mp3 = [command(read, '{file}'), [path.join(directory, 'not-a-player')]]
    await assert.rejects(playSound(filename), /ENOENT/)
    config.players.mp3 = [command('process.exit(7)', '{file}'), command(copy, output)]
    await assert.rejects(playSound(filename), /exited with 7/)
    config.players.mp3 = [command('setInterval(() => {}, 1000)', '{file}'), command(copy, output)]
    config.timeout_ms = 100
    await assert.rejects(playSound(filename), /timed out after 100 ms/)

    assert.equal(await hasSound('not-installed.wav'), false)
    assert.equal(await hasSound('sound.wav'), true)
    const started = path.join(directory, 'started')
    config.timeout_ms = 5_000
    config.players.wav = [command('require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)', '{file}', started)]
    const controller = new AbortController()
    const done = assert.rejects(playSound('sound.wav', { signal: controller.signal }), { name: 'AbortError' })
    try {
        for (let i = 0; i < 100 && !await stat(started).catch(() => null); i++) await delay(10)
        const pid = Number(await readFile(started, 'utf8'))
        controller.abort()
        await done
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
        await assert.rejects(playSound('sound.wav', { signal: controller.signal }), { name: 'AbortError' })
    } finally {
        controller.abort()
        await done
    }
} finally {
    mock.restoreAll()
    await rm(directory, { recursive: true, force: true })
}
