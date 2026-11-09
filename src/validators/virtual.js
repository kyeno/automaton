/** Validation for AI-facing virtual devices. */
'use strict'

const CALL_TYPES = new Set(['sequence', 'automation', 'interaction', 'device', 'ir'])
const ACTIONS = new Set(['ON', 'OFF', 'OPEN', 'CLOSE', 'STOP', 'TOGGLE'])

/** Validate named virtual targets and their bounded action bindings.
 * @param {Object} config - Parsed virtual-device section
 * @returns {string[]} Validation errors */
export function validateConfig(config) {
    const errors = []
    const entries = config.devices
    if (!Array.isArray(entries)) return ['devices must be an array']
    const names = new Set()
    for (const [index, entry] of entries.entries()) {
        const label = `devices[${index}]`
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${label} must be an object`)
            continue
        }
        if (typeof entry.name !== 'string' || !entry.name.trim()) errors.push(`${label}.name is required`)
        const normalized = String(entry.name ?? '').trim().toLocaleLowerCase()
        if (names.has(normalized)) errors.push(`Duplicate virtual device name: ${entry.name}`)
        names.add(normalized)
        if (entry.description != null && typeof entry.description !== 'string') errors.push(`${label}.description must be a string`)
        if (entry.observations != null) {
            if (!entry.observations || typeof entry.observations !== 'object' || Array.isArray(entry.observations)) {
                errors.push(`${label}.observations must be an object`)
            } else {
                for (const [key, source] of Object.entries(entry.observations)) {
                    const path = `${label}.observations.${key}`
                    if (!/^[a-z][a-z0-9_]*$/.test(key)) errors.push(`${path} must use a lowercase identifier`)
                    if (!source || typeof source !== 'object' || Array.isArray(source)) {
                        errors.push(`${path} must be an object`)
                        continue
                    }
                    if (source.type !== 'network_presence') errors.push(`${path}.type must be network_presence`)
                    if (typeof source.name !== 'string' || !source.name.trim()) errors.push(`${path}.name is required`)
                    for (const field of Object.keys(source)) if (!['type', 'name'].includes(field)) errors.push(`${path}.${field} is not allowed`)
                }
            }
        }
        if (!entry.actions || typeof entry.actions !== 'object' || Array.isArray(entry.actions) || Object.keys(entry.actions).length === 0) {
            errors.push(`${label}.actions must be a non-empty object`)
            continue
        }
        for (const [action, call] of Object.entries(entry.actions)) {
            const path = `${label}.actions.${action}`
            if (!ACTIONS.has(action)) errors.push(`${path} is not a supported device action`)
            if (!call || typeof call !== 'object' || Array.isArray(call) || !CALL_TYPES.has(call.type)) {
                errors.push(`${path}.type must be sequence, automation, interaction, device or ir`)
                continue
            }
            const expected = {
                sequence: ['type', 'name', 'phase'],
                automation: ['type', 'name', 'force'],
                interaction: ['type', 'name', 'action'],
                device: ['type', 'name', 'command'],
                ir: ['type', 'command_id']
            }[call.type]
            for (const key of Object.keys(call)) if (!expected.includes(key)) errors.push(`${path}.${key} is not allowed`)
            if (call.type !== 'ir' && (typeof call.name !== 'string' || !call.name.trim())) errors.push(`${path}.name is required`)
            if (call.type === 'ir' && (typeof call.command_id !== 'string' || !call.command_id.trim())) errors.push(`${path}.command_id is required`)
            if (call.type === 'sequence' && !['ON', 'OFF', 'START_LOOP', 'STOP_LOOP'].includes(call.phase)) errors.push(`${path}.phase must be ON, OFF, START_LOOP or STOP_LOOP`)
            if (call.type === 'automation' && call.force != null && typeof call.force !== 'boolean') errors.push(`${path}.force must be boolean`)
            if (call.type === 'interaction' && (typeof call.action !== 'string' || !call.action.trim())) errors.push(`${path}.action is required`)
            if (call.type === 'device' && (typeof call.command !== 'string' || !ACTIONS.has(call.command))) errors.push(`${path}.command must be a supported device action`)
        }
    }
    return errors
}

export default { devices: { type: 'array', required: true } }
