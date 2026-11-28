/** Lighting leases enforced at device dispatch and at the MQTT queue boundary.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
'use strict'

const owners = new Map()
const epochs = new Map()

/** Claim all listed devices atomically.
 * @param {string[]} names - Canonical device names
 * @param {AbortSignal} signal - Lifetime of authorized writes
 * @returns {Object} Opaque lease */
export function claimLights(names, signal) {
    if (names.some(name => owners.has(name))) throw new Error('Red Alert lights are already owned')
    const lease = { signal }
    for (const name of names) {
        owners.set(name, lease)
        epochs.set(name, (epochs.get(name) ?? 0) + 1)
    }
    return lease
}

/** Release devices claimed by this session.
 * @param {Object} lease - Opaque lease */
export function releaseLights(lease) {
    for (const [name, owner] of owners) {
        if (owner === lease) owners.delete(name)
    }
}

/** Check command authorization again when the queued publish actually runs.
 * @param {string} name - Canonical device name
 * @param {Object} [lease] - Opaque lease for scenario commands
 * @returns {Function} Whether this command is still authorized */
export function lightWriteGuard(name, lease) {
    const epoch = epochs.get(name)
    return lease
        ? () => owners.get(name) === lease && !lease.signal.aborted
        : () => !owners.has(name) && epochs.get(name) === epoch
}