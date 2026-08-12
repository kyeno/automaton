/**
 * Page Down Command -- scrolls the active window down one page.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

class PgDnCmd extends CommandBase {
    static name = 'pgdn'
    static description = 'Scroll page down'
    static takesArgs = false

    async execute(args) {
        this.ctx.scrollPageDown?.()
    }
}

export default PgDnCmd
