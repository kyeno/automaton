/**
 * Clear Command -- clears the active window buffer.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

class ClearCmd extends CommandBase {
    static name = 'clear'
    static description = 'Clear current window buffer'

    async execute(args) {
        const win = this.ctx.activeWindow
        if (win && typeof win.clear === 'function') {
            win.clear()
        }
    }
}

export default ClearCmd
