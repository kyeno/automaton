/**
 * Manage expiring manual room occupancy through /occupancy.
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'
import RoomOccupancy from '../../service/roomOccupancy.js'
import temporal from '../../lib/date.js'

/** UI for passive room occupancy assertions. */
class OccupancyCmd extends CommandBase {
    static name = 'occupancy'
    static description = 'Manage temporary room occupancy: list, show, set, clear'
    static takesArgs = true

    /** Execute a room occupancy operation.
     * @param {string} args - Subcommand, room ID and optional duration
     * @returns {Promise<void>} */
    async execute(args) {
        const tokens = String(args ?? '').trim().split(/\s+/).filter(Boolean)
        const [action, room, duration] = tokens
        try {
            if (action === 'list' && tokens.length === 1) {
                const rooms = await RoomOccupancy.list()
                if (!rooms.length) this.ctx.print('No occupancy rooms configured')
                for (const status of rooms) this.#printStatus(status)
            } else if (action === 'show' && tokens.length === 2) {
                this.#printStatus(await RoomOccupancy.get(room))
            } else if (action === 'set' && tokens.length === 3) {
                await RoomOccupancy.set(room, duration)
                this.ctx.print(`Room ${room}: occupancy set for ${duration}. Lights unchanged.`)
            } else if (action === 'clear' && tokens.length === 2) {
                await RoomOccupancy.clear(room)
                this.ctx.print(`Room ${room}: occupancy cleared. Lights unchanged.`)
            } else {
                this.ctx.print('Usage: /occupancy list | show <room> | set <room> <30m|45m|1h|90m|2h|3h> | clear <room>')
            }
        } catch (error) {
            this.ctx.print(`Occupancy failed: ${error.message}`)
        }
    }

    /** Complete subcommands, configured room IDs and allowed durations.
     * @param {string[]} tokens - Fully typed argument tokens
     * @returns {string[]|null} Candidates for the next argument */
    completeNextToken(tokens) {
        if (tokens.length === 0) return ['list', 'show', 'set', 'clear']
        if (tokens.length === 1 && ['show', 'set', 'clear'].includes(tokens[0])) {
            return RoomOccupancy.getRooms().map(room => room.id)
        }
        if (tokens.length === 2 && tokens[0] === 'set') return RoomOccupancy.getDurations()
        return null
    }

    /** Render one resolved room state.
     * @private
     * @param {object} status - Room status returned by RoomOccupancy */
    #printStatus(status) {
        const state = status.occupied
            ? `occupied, ${temporal.secondsToHumanReadable(status.remainingSeconds)} remaining`
            : 'no active occupancy assertion'
        this.ctx.print(`Room ${status.id} (${status.name}): ${state}`)
    }
}

export default OccupancyCmd