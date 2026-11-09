/**
 * Validator schema for etc/sequence/sequences.yaml (sequence definitions).
 * Loaded automatically by ConfigBase when section name is "sequences". Shape lives here;
 * duplicate slugs, exactly-one-of-devices/on and duration parsing stay in
 * SequenceContainer.init() with warn+skip. Step entries are validated deeply on purpose:
 * a typed host step sits in a shutdown path, where a typo must fail loudly at load time
 * and never become a warned-about, silently skipped no-op.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/** Keys a rich `on:`/`off:` device step may carry. @type {string[]} */
const DEVICE_STEP_KEYS = ['device', 'payload', 'command', 'delay']
/** Keys a typed host step may carry. @type {string[]} */
const HOST_STEP_KEYS = ['kind', 'target', 'action', 'delay']
/** Keys a simple `devices:` object entry may carry. @type {string[]} */
const SIMPLE_STEP_KEYS = ['device', 'command', 'delay']
/** Step kinds SequenceBase understands. @type {string[]} */
const STEP_KINDS = ['host_command']
/** Actions the host protocol understands in v1. @type {string[]} */
const HOST_ACTIONS = ['shutdown']
/** Target slugs share the host_commands target slug shape. @type {RegExp} */
const TARGET_SLUG = /^[a-z][a-z0-9_]{0,31}$/

/** Schema for one rich `on:`/`off:` step, device and host steps alike. A typo in a
 * `kind` or `action` *value* fails the enum here; a typo in a key *name* is caught by
 * validateConfig(), because ConfigBase only walks the keys the schema lists and ignores
 * everything else.
 * @type {Record<string, Object>} */
const stepProperties = {
    device:  { type: 'string' },
    payload: { type: ['string', 'number', 'boolean', 'object'] },
    command: { type: ['string', 'number', 'boolean', 'object'] },
    delay:   { type: ['number', 'string'] },
    kind:    { enum: STEP_KINDS },
    target:  { type: 'string' },
    action:  { enum: HOST_ACTIONS }
}

/** Report the per-step semantics a shape schema cannot express: which keys a step of a
 * given kind may carry, that a host step names a target, and that a device step names a
 * device. Runs after the shape pass, on the same loaded data.
 * @param {Object} config - Parsed sequences section
 * @returns {string[]} Error messages, empty when every step is sound */
export function validateConfig(config) {
    const errors = []
    const sequences = config?.sequences
    if (!Array.isArray(sequences)) return errors

    /** Validate one rich step list (`on:` or `off:`).
     * @param {*} list - Raw step array
     * @param {string} phase - Dot path of the list
     * @returns {void} */
    const checkSteps = (list, phase) => {
        if (!Array.isArray(list)) return
        list.forEach((step, index) => {
            const at = `${phase}[${index}]`
            if (step === null || typeof step !== 'object' || Array.isArray(step)) {
                errors.push(`${at} must be an object -- a device step or a kind: host_command step`)
                return
            }
            const keys = Object.keys(step)
            if (step.kind !== undefined) {
                if (!STEP_KINDS.includes(step.kind)) {
                    errors.push(`${at}.kind must be one of [${STEP_KINDS.join(', ')}], got "${step.kind}"`)
                    return
                }
                const unknown = keys.filter((k) => !HOST_STEP_KEYS.includes(k))
                if (unknown.length > 0) errors.push(`${at} host_command step has unknown keys: ${unknown.join(', ')}`)
                if (step.device !== undefined || step.payload !== undefined) {
                    errors.push(`${at} host_command step must not carry device/payload -- it drives no device`)
                }
                const target = typeof step.target === 'string' ? step.target.trim().toLowerCase() : ''
                if (!target) errors.push(`${at}.target is required -- a host step with no target is a silent no-op`)
                else if (!TARGET_SLUG.test(target)) errors.push(`${at}.target "${step.target}" is not a valid target slug`)
                if (step.action !== undefined && !HOST_ACTIONS.includes(String(step.action).trim().toLowerCase())) {
                    errors.push(`${at}.action must be one of [${HOST_ACTIONS.join(', ')}] in v1`)
                }
                return
            }
            const unknown = keys.filter((k) => !DEVICE_STEP_KEYS.includes(k))
            if (unknown.length > 0) errors.push(`${at} has unknown keys: ${unknown.join(', ')}`)
            if (typeof step.device !== 'string' || !step.device.trim()) errors.push(`${at}.device is required`)
        })
    }

    sequences.forEach((seq, index) => {
        if (seq === null || typeof seq !== 'object' || Array.isArray(seq)) return
        const label = `sequences[${index}]${seq.name ? ` "${seq.name}"` : ''}`
        checkSteps(seq.on, `${label}.on`)
        checkSteps(seq.off, `${label}.off`)
        if (!Array.isArray(seq.devices)) return
        seq.devices.forEach((entry, i) => {
            const at = `${label}.devices[${i}]`
            if (typeof entry === 'string') return
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
                errors.push(`${at} must be a device name or a {device, command, delay} object`)
                return
            }
            if (entry.kind !== undefined) {
                errors.push(`${at} host_command steps belong in on:/off:, not in the simple devices form`)
                return
            }
            const unknown = Object.keys(entry).filter((k) => !SIMPLE_STEP_KEYS.includes(k))
            if (unknown.length > 0) errors.push(`${at} has unknown keys: ${unknown.join(', ')}`)
            if (typeof entry.device !== 'string' || !entry.device.trim()) errors.push(`${at}.device is required`)
        })
    })
    return errors
}

export default {
    sequences: {
        type: 'array',
        required: false,
        items: {
            properties: {
                name:     { type: 'string', required: true },
                force:    { type: 'boolean' },
                delay: { type: ['number', 'string'] },
                devices: {
                    type: 'array',
                    items: {
                        properties: {
                            device:  { type: 'string' },
                            command: { type: ['string', 'number', 'boolean', 'object'] },
                            delay:   { type: ['number', 'string'] }
                        }
                    }
                },
                on:  { type: 'array', items: { properties: stepProperties } },
                off: { type: 'array', items: { properties: stepProperties } },
                loop: {
                    type: 'object',
                    properties: {
                        enabled:      { type: 'boolean' },
                        cycle:        { enum: ['once', 'continuous'] },
                        off_delay: { type: ['number', 'string'] },
                        on_delay:  { type: ['number', 'string'] }
                    }
                }
            }
        }
    }
}
