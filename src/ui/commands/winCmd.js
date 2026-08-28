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
import channels from '../channels.js'

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

    /**
     * Tab-completion candidates for /win arguments: every configured window id plus its
     * numeric shortcut, so "/win d<Tab>" offers "device" alongside the raw digits.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null when none apply
     */
    completeNextToken(typedTokens) {
        if (typedTokens && typedTokens.length > 0) return null
        try {
            const all = channels.getAll?.() ?? []
            const names = new Set()
            for (const ch of all) {
                if (ch?.id != null && String(ch.id) !== '') names.add(String(ch.id))
                if (ch?.shortcut != null && String(ch.shortcut) !== '') names.add(String(ch.shortcut))
            }
            return names.size > 0 ? [...names].sort() : null
        } catch {
            return null
        }
    }
}

export default WinCmd
