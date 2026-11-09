/**
 * IR command catalog validation.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/** Validate an opaque, non-empty standard Base64 code without rewriting it.
 * @param {*} code - Configured code
 * @returns {boolean} Whether the code is valid */
export function isIRCode(code) {
    return typeof code === 'string' && code.length > 0
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(code)
}

/** Validate dynamic command keys and their transmitter bindings.
 * @param {Object} config - IR section
 * @returns {string[]} Configuration errors */
export function validateConfig(config) {
    const errors = []
    const commands = config.commands
    if (!commands || typeof commands !== 'object' || Array.isArray(commands)) return ['commands must be an object']
    for (const [id, entry] of Object.entries(commands)) {
        if (!/^[a-z][a-z0-9_]*$/.test(id)) errors.push(`Invalid IR command ID: ${id}`)
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${id} must be an object`)
            continue
        }
        if (typeof entry.transmitter !== 'string' || !entry.transmitter.trim()) errors.push(`${id}.transmitter is required`)
        if (!isIRCode(entry.code)) errors.push(`${id}.code must be non-empty Base64`)
    }
    return errors
}

export default { commands: { type: 'object', required: true } }
