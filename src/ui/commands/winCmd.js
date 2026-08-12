/**
 * Window Switch Command -- switches to a window by shortcut number or id.
 *
 * Usage: /win <shortcut|id>
 *   /win 1          Switch to window with shortcut 1 (typically logs)
 *   /win device     Switch to window with id 'device'
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

class WinCmd extends CommandBase {
    static name = 'win'
    static description = 'Switch window by shortcut number or id'
    static takesArgs = true

    async execute(args) {
        const target = args.trim()
        if (!target) {
            this.ctx.print('Usage: /win <shortcut_number | window_id>')
            return
        }

        // Pass through switchWindow -- it resolves both numeric shortcuts and ids
        this.ctx.switchWindow(target)
    }
}

export default WinCmd
