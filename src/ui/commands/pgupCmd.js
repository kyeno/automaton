/**
 * Page Up Command -- scrolls the active window up one page.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

class PgUpCmd extends CommandBase {
    static name = 'pgup'
    static description = 'Scroll page up'
    static takesArgs = false

    async execute(args) {
        this.ctx.scrollPageUp?.()
    }
}

export default PgUpCmd
