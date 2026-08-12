/**
 * Quit Command -- triggers graceful shutdown of Automaton.
 *
 * Registered under the canonical name 'quit' with aliases ['exit', 'q'].
 * All three verbs (/quit, /exit, /q) route to this same command instance.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

class QuitCmd extends CommandBase {
    static name = 'quit'
    static description = 'Exit automaton gracefully'
    static aliases = ['exit', 'q']

    async execute(args) {
        // Ignore any arguments -- just shut down
        this.ctx.shutdown()
    }
}

export default QuitCmd
