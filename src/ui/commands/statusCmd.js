/**
 * Status Command -- dumps StateService contents to the active window.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

class StatusCmd extends CommandBase {
    static name = 'status'
    static description = 'Show system status dump'
    static takesArgs = false

    async execute(args) {
        const dump = this.ctx.stateService.dump()
        const entries = Object.entries(dump)
            .filter(([k, v]) => v != null && v !== '')
            .map(([k, v]) => `  ${k} = ${typeof v === 'object' ? JSON.stringify(v) : v}`)

        const lines = ['System Status:']
        if (entries.length > 0) {
            lines.push(...entries)
        } else {
            lines.push('  (no active states)')
        }

        this.ctx.print(lines.join('\n'))
    }
}

export default StatusCmd
