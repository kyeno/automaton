/**
 * IR command discovery and fire-and-forget transmission.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './commandDefinition.js'
import IRCommandService from '../ir/irCommandService.js'
import DeviceCommandSource from '../enum/deviceCommandSource.js'

/** Thin UI adapter for the shared IR catalog. */
export default class IRCmd extends CommandBase {
    static name = 'ir'
    static description = 'List, inspect and send named IR commands'
    static takesArgs = true

    /** List metadata or send one configured command.
     * @param {string} args - Slash-command arguments */
    async execute(args) {
        const [sub = 'list', ...rest] = String(args ?? '').trim().split(/\s+/).filter(Boolean)
        const id = rest.join(' ')
        const service = this.ctx.irCommandService ?? IRCommandService
        if (sub === 'list' || sub === 'search') {
            const entries = sub === 'search' ? service.search(id).results : service.list()
            if (!entries.length) this.ctx.print('(no IR commands found)')
            for (const entry of entries) this.ctx.print(`${entry.id}: ${entry.label} [${entry.transmitter}]`)
        } else if (sub === 'show' && id) {
            const entry = service.get(id)
            if (!entry) this.status = 'failed'
            this.ctx.print(entry ? `${entry.id}: ${entry.description}\nTransmitter: ${entry.transmitter}\nFire-and-forget; appliance state is unknown.` : `Unknown IR command: ${id}`)
        } else if (sub === 'send' && id) {
            try {
                const result = await service.send(id, { source: DeviceCommandSource.HUMAN, caller: this.ctx.caller ?? 'ui' })
                this.ctx.print(`IR command ${result.status}: ${id} (appliance state unknown)`)
            } catch (error) {
                this.fail(`IR command failed: ${error.message}`)
            }
        } else {
            this.fail('Usage: /ir list | search <query> | show <id> | send <id>')
        }
    }

    /** Complete stable IDs from the current catalog.
     * @param {string[]} typedTokens - Complete argument tokens
     * @returns {string[]|null} Candidates */
    completeNextToken(typedTokens) {
        if (!typedTokens?.length) return ['list', 'search', 'show', 'send']
        if (typedTokens.length === 1 && ['show', 'send'].includes(typedTokens[0])) {
            return (this.ctx.irCommandService ?? IRCommandService).list().map(entry => entry.id)
        }
        return null
    }
}
