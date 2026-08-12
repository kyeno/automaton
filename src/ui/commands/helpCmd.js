/**
 * Help Command -- lists all available slash commands with descriptions.
 *
 * Dynamically queries the command container for every registered command,
 * showing primary names, aliases, argument indicators, and descriptions.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

class HelpCmd extends CommandBase {
    static name = 'help'
    static description = 'Show available commands'
    static takesArgs = false

    async execute(args) {
        const lines = []

        // All registered commands from container
        const cmdInfo = this.ctx.commandContainer?.getAllInfo?.() ?? []

        if (cmdInfo.length > 0) {
            lines.push('Commands:')
            for (const info of cmdInfo) {
                // Skip help itself in its own output to avoid confusion
                if (info.name === 'help') continue

                let entry = `  /${info.name}`
                if (info.takesArgs) entry += ' [arg]'
                if (info.aliases && info.aliases.length > 0) {
                    entry += ` (${info.aliases.map(a => '/' + a).join(', ')})`
                }
                if (info.description) entry += ` -- ${info.description}`
                lines.push(entry)
            }
        } else {
            lines.push('(no registered commands)')
        }

        this.ctx.print(lines.join('\n'))
    }
}

export default HelpCmd
