/**
 * Mail Command -- inspect and test the SMTP notification channel.
 *
 * /mail status          relay, sender, owners and send counters
 * /mail test [address]  queue the configuration-check mail (owner list, or one address)
 * /mail help            usage
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'
import EmailService from '../../service/emailService.js'

class MailCmd extends CommandBase {
    static name = 'mail'
    static description = 'Check the email channel, send a test notification'
    static takesArgs = true
    static aliases = ['email']

    /** Run one /mail subcommand.
     * @param {string} args - Raw argument string after the verb
     * @returns {Promise<void>} */
    async execute(args) {
        const tokens = String(args ?? '').trim().split(/\s+/).filter(Boolean)
        const verb = (tokens[0] ?? 'help').toLowerCase()

        if (verb === 'test') {
            await this.#test(tokens.slice(1).join(' '))
            return
        }
        if (verb === 'status') {
            this.#status()
            return
        }
        if (verb !== 'help') this.ctx.print(`Unknown /mail verb "${verb}"`)
        this.#usage()
    }

    /** Offer the subcommand names as the first completion token.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb
     * @returns {Array<string>|null} Candidates for the next token, or null */
    completeNextToken(typedTokens) {
        return typedTokens.length === 0 ? ['test', 'status', 'help'] : null
    }

    //  -- Private helpers ---------------------------------------------------

    /** Queue the configuration-check mail and report what happened.
     * @param {string} recipient - Optional explicit address
     * @returns {Promise<void>}
     * @private */
    async #test(recipient) {
        if (!EmailService.isEnabled()) {
            this.ctx.print('Email channel is not active -- set SMTP_HOST in .env, keep email.enabled true and start without --no-email')
            return
        }

        const queued = await EmailService.test(recipient || null)
        this.ctx.print(queued
            ? `Test mail queued for ${recipient ? recipient : 'the house owners'} -- delivery is asynchronous, watch the log window`
            : 'Test mail not queued -- check house_owners and the log window for the reason')
    }

    /** Print the live mail channel settings and counters. Secrets are never shown.
     * @returns {void}
     * @private */
    #status() {
        const configService = typeof this.ctx.configService?.get === 'function' ? this.ctx.configService : null
        const email = configService?.get('email') ?? {}
        const owners = EmailService.getRecipients()
        const stats = EmailService.getStats()
        const relay = process.env.SMTP_HOST
            ? `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || '465'}${process.env.SMTP_SECURE === 'false' ? ' (plain)' : ' (TLS)'}`
            : '(not configured)'

        const lines = [
            'Email channel:',
            `  state:     ${EmailService.isEnabled() ? 'active' : (EmailService.isReady() ? 'disabled' : 'not initialized')}`,
            `  relay:     ${relay}`,
            `  sender:    ${email.from || process.env.SMTP_USER || '(unset)'}`,
            `  prefix:    ${email.subject_prefix ?? 'Automaton'}`,
            `  cooldown:  ${email.cooldown ?? '60m'} per kind`,
            `  kinds:     ${this.#formatKinds(email.notify)}`,
            `  owners:    ${owners.length > 0 ? owners.map((o) => (o.name ? `${o.name} <${o.email}>` : o.email)).join(', ') : '(none -- set house_owners)'}`,
            `  sent:      ${stats.sent} ok, ${stats.failed} failed, ${stats.skipped} skipped`,
        ]
        this.ctx.print(lines.join('\n'))
    }

    /** Notification kind switches as a readable line: enabled kinds, kinds muted by hand.
     * @param {*} raw - Raw email.notify map ({ kind: boolean })
     * @returns {string} Human-readable kind list
     * @private */
    #formatKinds(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '(every kind -- none switched off)'
        const entries = Object.entries(raw).map(([kind, value]) => (value === false ? `${kind} (off)` : kind))
        return entries.length > 0 ? entries.join(', ') : '(every kind -- none switched off)'
    }

    /** Print the usage block.
     * @returns {void}
     * @private */
    #usage() {
        this.ctx.print([
            '  /mail status             relay, sender, owners and send counters',
            '  /mail test [address]     queue the configuration-check mail (default: all owners)',
        ].join('\n'))
    }
}

export default MailCmd