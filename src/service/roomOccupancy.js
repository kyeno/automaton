/**
 * Passive, manually asserted room occupancy backed by Redis TTLs.
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from './configService.js'
import CacheService from './cacheService.js'

const DURATIONS = Object.freeze({ '30m': 1800, '45m': 2700, '1h': 3600, '90m': 5400, '2h': 7200, '3h': 10800 })
const ROOM_ID = /^[1-9]\d*$/

/** Manual occupancy assertions; never commands devices or triggers automations. */
class SRoomOccupancy {
    /** List configured rooms without accessing Redis.
     * @returns {Array<{id: string, name: string}>} Configured room identities */
    getRooms() {
        const rooms = ConfigService.get('occupancy.rooms') ?? {}
        return Object.entries(rooms).map(([id, room]) => ({ id, name: room.name }))
    }

    /** Allowed activation durations.
     * @returns {string[]} Duration tokens */
    getDurations() { return Object.keys(DURATIONS) }

    /** Validate a configured room reference.
     * @private
     * @param {string|number} roomId - Positive integer room ID
     * @returns {{id: string, name: string}} Configured room
     * @throws {Error} When the room ID is malformed or unconfigured */
    #room(roomId) {
        const id = String(roomId)
        const room = this.getRooms().find(room => room.id === id)
        if (!ROOM_ID.test(id) || !room) throw new Error(`Unknown occupancy room "${id}"`)
        return room
    }

    /** Assert occupancy for a fixed duration, replacing any previous expiry.
     * @param {string|number} roomId - Configured room ID
     * @param {string} duration - One of getDurations()
     * @returns {Promise<void>}
     * @throws {Error} On invalid arguments or failed Redis write */
    async set(roomId, duration) {
        const room = this.#room(roomId)
        if (!Object.hasOwn(DURATIONS, duration)) throw new Error('Duration must be 30m, 45m, 1h, 90m, 2h or 3h')
        const seconds = DURATIONS[duration]
        if (!await CacheService.set(`occupancy:room:${room.id}`, { expiresAt: Date.now() + seconds * 1000 }, seconds)) {
            throw new Error('Could not save room occupancy to Redis')
        }
    }

    /** Read occupancy and remaining time; absent/expired assertions are inactive.
     * @param {string|number} roomId - Configured room ID
     * @returns {Promise<{id: string, name: string, occupied: boolean, expiresAt: number|null, remainingSeconds: number}>}
     * @throws {Error} On unknown rooms, unreadable storage or malformed stored state */
    async get(roomId) {
        const room = this.#room(roomId)
        const entry = await CacheService.getStrict(`occupancy:room:${room.id}`)
        if (entry !== undefined && (!entry || typeof entry !== 'object'
            || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= 0)) {
            throw new Error(`Invalid stored occupancy for room ${room.id}`)
        }
        const remainingSeconds = entry === undefined
            ? 0 : Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000))
        return {
            ...room,
            occupied: remainingSeconds > 0,
            expiresAt: remainingSeconds > 0 ? entry.expiresAt : null,
            remainingSeconds,
        }
    }

    /** Clear a manual assertion, without changing lights or firing automations.
     * @param {string|number} roomId - Configured room ID
     * @returns {Promise<void>}
     * @throws {Error} On an unknown room or failed Redis deletion */
    async clear(roomId) {
        const room = this.#room(roomId)
        if (!await CacheService.delete(`occupancy:room:${room.id}`)) throw new Error('Could not clear room occupancy in Redis')
    }

    /** Read occupancy for every configured room; never scans Redis keys.
     * @returns {Promise<object[]>} Room statuses */
    async list() { return Promise.all(this.getRooms().map(room => this.get(room.id))) }
}

const RoomOccupancy = Object.freeze(new SRoomOccupancy())
export default RoomOccupancy