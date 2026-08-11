/**
 * Help Command -- lists all available slash commands with descriptions.
 *
 * Combines built-in UI shortcuts and registered commands from the container
 * into a single formatted help message printed to the active window.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'
import channels from '../channels.js'

class HelpCmd extends CommandBase {
    static name = 'help'
    static description = 'Show available commands'

    async execute(args) {
        const lines = []

        // Built-in window shortcuts
        const allChannels = channels.getAll()
        if (allChannels.length > 0) {
            lines.push('Built-in shortcuts:')
            for (const ch of allChannels) {
                lines.push(`  /${ch.shortcut}          ${ch.channel}`)
            }
        }

        lines.push('\nCommands:')

        // Registered commands from container
        const cmdInfo = this.ctx.commandContainer?.getAllInfo?.() ?? []
        if (cmdInfo.length > 0) {
            for (const info of cmdInfo) {
                // Skip showing help itself in its own output to avoid confusion
                if (info.name === 'help') continue
                const desc = info.description ? ` -- ${info.description}` : ''
                lines.push(`  /${info.name}${desc}`)
            }
        } else {
            lines.push('  (no registered commands)')
        }

        // Always-listed built-ins that aren't auto-discovered
        lines.push('\nAlways available:')
        lines.push('  /quit           Exit automaton')

        this.ctx.print(lines.join('\n'))
    }
}

export default HelpCmd
