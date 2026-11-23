/** Trusted-LAN protocol v2. No signatures, peer clocks or client identities.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
'use strict'

export const VERSION = 2
export const REQUEST_ID_RE = /^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

/** Parse a small JSON object without logging credentials.
 * @param {string} text - MQTT payload
 * @returns {Object|null} Object or null */
export function decodeFrame(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) return null
    try {
        const data = JSON.parse(text)
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null
    } catch { return null }
}

/** Bounded duplicate guard measured only against the receiver's monotonic clock. */
export class RequestCache {
    #seen = new Map()

    /** Claim a request before any asynchronous work.
     * @param {string} id - Random request ID
     * @returns {boolean} False for malformed or recently processed IDs */
    claim(id) {
        if (typeof id !== 'string' || !REQUEST_ID_RE.test(id)) return false
        const now = performance.now()
        for (const [key, expiry] of this.#seen) if (expiry <= now) this.#seen.delete(key)
        if (this.#seen.has(id)) return false
        // Fail closed at capacity rather than evicting live IDs and re-running an action.
        if (this.#seen.size >= 4096) return false
        this.#seen.set(id, now + 120000)
        return true
    }
}