/** Replace only the speaker subprocess; test callbacks and argument handling without hardware. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'

export function mockBeep() {
    const original = childProcess.spawn
    const calls = []
    const outcomes = []
    childProcess.spawn = (command, args, options) => {
        if (command !== 'beep') return original(command, args, options)
        calls.push({ args, options })
        const process = new EventEmitter()
        const outcome = outcomes.shift() ?? 0
        setImmediate(() => {
            if (outcome instanceof Error) process.emit('error', outcome)
            process.emit('close', outcome instanceof Error ? -1 : outcome)
        })
        return process
    }
    syncBuiltinESMExports()
    return {
        calls, outcomes,
        restore: () => { childProcess.spawn = original; syncBuiltinESMExports() },
    }
}
