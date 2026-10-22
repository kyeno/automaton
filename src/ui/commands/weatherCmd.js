/**
 * One-word human sky labels and daylight archive diagnostics.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import CommandBase from './base/commandBase.js'
import DaylightService from '../../service/daylightService.js'
import DatabaseService from '../../service/databaseService.js'
import PROJECT_ROOT from '../../lib/projectRoot.js'

/** Frictionless sky observation command, auto-discovered by the UI. */
class WeatherCmd extends CommandBase {
    static name = 'weather'
    static description = 'Label the sky: sunny, cloudy, overcast; undo, status, export'
    static takesArgs = true

    /** Offer everyday labels before advanced operations.
     * @param {string[]} tokens - Completed argument tokens.
     * @returns {string[]} Candidates. */
    completeNextToken(tokens) {
        return tokens.length ? [] : ['sunny', 'cloudy', 'overcast', 'unsure', 'undo', 'status', 'export', 'help']
    }

    /** Save labels or inspect/export calibration evidence.
     * @param {string} args - One label or diagnostic operation.
     * @returns {Promise<void>} */
    async execute(args) {
        const word = args.trim().toLowerCase()
        const label = { sunny: 'sunny', clear: 'sunny', cloudy: 'cloudy', 'partly-cloudy': 'cloudy', overcast: 'overcast', clouded: 'overcast', unsure: 'unsure' }[word]
        if (label) this.ctx.print(DaylightService.observe(label))
        else if (word === 'undo') this.ctx.print(DaylightService.undo())
        else if (word === 'status') this.ctx.print(DaylightService.status())
        else if (word === 'export') {
            const directory = path.join(PROJECT_ROOT, 'var', 'export')
            fs.mkdirSync(directory, { recursive: true })
            const file = path.join(directory, `daylight-${randomUUID()}.jsonl`)
            const handle = fs.openSync(file, 'wx', 0o600)
            let complete = false
            try {
                fs.writeSync(handle, JSON.stringify({ format: 'automaton-daylight', version: 1, exportedAt: Date.now() }) + '\n')
                let cursor = 0
                while (true) {
                    const events = DatabaseService.daylightEvents(cursor)
                    if (events === null) throw new Error('daylight archive unavailable')
                    if (!events.length) break
                    for (const event of events) fs.writeSync(handle, JSON.stringify(event) + '\n')
                    cursor = events.at(-1).id
                }
                complete = true
            } catch (error) {
                this.ctx.print(`Export failed: ${error.message}`)
            } finally {
                fs.closeSync(handle)
                if (!complete) fs.unlinkSync(file)
            }
            if (complete) this.ctx.print(`Exported: ${file}\nIncludes coordinates, device identifiers, raw reports and label/undo audit history.`)
        } else this.ctx.print('/weather sunny (mostly clear), cloudy (mixed clouds), overcast (continuous cloud), unsure. Look at the sky, then enter one label. /weather undo removes the latest label; status and export inspect the archive.')
    }
}

export default WeatherCmd
