/** Sound subprocess contract tests, independent of beep installation and speaker privileges. */
import assert from 'node:assert/strict'
import sound from '../src/lib/sound.js'
import { mockBeep } from './helpers/mock-beep.js'

const mock = mockBeep()
const call = (fn, options = {}) => new Promise(resolve => fn({ ...options, callback: resolve }))
try {
    assert.equal(Object.isFrozen(sound), true)
    for (const name of ['beep', 'doubleBeep', 'mario', 'marioGameOver']) assert.equal(typeof sound[name], 'function')
    assert.equal(await call(sound.beep), undefined)
    assert.deepEqual(mock.calls.at(-1).args, ['-f', '1200', '-l', '200'])
    assert.equal(await call(sound.beep, { frequency: 800, duration: 150 }), undefined)
    assert.deepEqual(mock.calls.at(-1).args, ['-f', '800', '-l', '150'])
    assert.deepEqual(mock.calls.at(-1).options, { stdio: 'ignore' })
    assert.equal(await call(sound.doubleBeep), undefined)
    assert.deepEqual(mock.calls.at(-1).args, ['-f', '1200', '-l', '200', '-r', '2'])
    assert.equal(await call(sound.doubleBeep, { frequency: 600, duration: 100 }), undefined)
    assert.deepEqual(mock.calls.at(-1).args, ['-f', '600', '-l', '100', '-r', '2'])
    assert.equal(await call(sound.beep, { frequency: null, duration: null }), undefined)
    assert.deepEqual(mock.calls.at(-1).args, [])
    for (const fn of [sound.beep, sound.doubleBeep]) {
        mock.outcomes.push(1)
        assert.match(await call(fn), /exited with code 1/)
        let callbacks = 0
        mock.outcomes.push(new Error('speaker unavailable'))
        await new Promise(resolve => fn({ callback: error => {
            callbacks++
            assert.equal(error, 'speaker unavailable')
            resolve()
        } }))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(callbacks, 1, 'error followed by close reports the failure only once')
        assert.doesNotThrow(() => fn())
        await new Promise(resolve => setImmediate(resolve))
    }
    console.log('Sound argument, completion, failure and callback checks passed without hardware.')
} finally { mock.restore() }
