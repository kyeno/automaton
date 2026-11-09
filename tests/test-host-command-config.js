/**
 * Main-config validation for the host_commands section: topic-tree guardrails, target slugs,
 * secret environment variable names and ACK timeouts -- plus the sequence steps that carry
 * host commands, where a typo must fail at load time instead of becoming a warned-about,
 * silently skipped no-op in a shutdown path.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import assert from 'node:assert/strict'

import { validateConfig } from '../src/validators/main.js'
import { validateConfig as validateSequences } from '../src/validators/sequences.js'

/** Collect host_commands findings for one section value.
 * @param {*} hostCommands - Value under the host_commands key
 * @returns {string[]} Validation messages */
const hostErrors = (hostCommands) => validateConfig({ host_commands: hostCommands })

const VALID = { enabled: true, topic_base: 'automaton/host', targets: { htpc: { secret_env: 'HTPC_MQTT_SECRET', ack_timeout: '3s' } } }

//  Absent section stays valid -- the feature is opt-in.
assert.deepEqual(hostErrors(undefined), [])
assert.deepEqual(hostErrors(null), [])
assert.deepEqual(hostErrors(VALID), [])
assert.deepEqual(hostErrors({ targets: { htpc: { secret_env: 'HTPC_MQTT_SECRET' } } }), [], 'defaults cover topic_base and ack_timeout')
assert.deepEqual(hostErrors({ enabled: false, targets: {} }), [], 'disabled section with no targets is accepted')

//  Shape.
assert.equal(hostErrors('nope').length, 1)
assert.ok(hostErrors({ enabled: 'yes' }).some(e => /enabled/.test(e)))
assert.ok(hostErrors({ targets: 'htpc' }).some(e => /targets/.test(e)))
assert.ok(hostErrors({ targets: { htpc: null } }).some(e => /htpc/.test(e)))

//  Topic base: wildcards, the Zigbee2MQTT tree and the reserved AI topic are all rejected.
assert.ok(hostErrors({ ...VALID, topic_base: '' }).some(e => /topic_base/.test(e)))
assert.ok(hostErrors({ ...VALID, topic_base: 'automaton/#' }).some(e => /wildcard/.test(e)))
assert.ok(hostErrors({ ...VALID, topic_base: 'automaton/+' }).some(e => /wildcard/.test(e)))
assert.ok(hostErrors({ ...VALID, topic_base: 'zigbee2mqtt' }).some(e => /Zigbee2MQTT/.test(e)))
assert.ok(hostErrors({ ...VALID, topic_base: 'zigbee2mqtt/htpc' }).some(e => /Zigbee2MQTT/.test(e)))
assert.ok(hostErrors({ ...VALID, topic_base: 'automaton/ai' }).some(e => /automaton\/ai/.test(e)))
assert.ok(hostErrors({ ...VALID, topic_base: 'automaton/ai/shutdown' }).some(e => /automaton\/ai/.test(e)))
assert.ok(hostErrors({ ...VALID, topic_base: 'automaton/host/' }).some(e => /topic_base/.test(e)))
assert.deepEqual(hostErrors({ ...VALID, topic_base: 'home/ktos/pc' }), [])

//  Targets: lowercase slugs, a secret env name, supported keys only.
assert.deepEqual(hostErrors({ ...VALID, targets: {} }), [], 'an empty map is inert, not an error')
assert.ok(hostErrors({ targets: { htpc: { secret_env: 'HTPC_MQTT_SECRET' } } }).some(e => /targets/.test(e)) === false)
assert.deepEqual(hostErrors({ ...VALID, targets: { HTPC: { secret_env: 'HTPC_MQTT_SECRET' } } }), [], 'target keys are normalized to lowercase, as the service does')
assert.ok(hostErrors({ ...VALID, targets: { 'htpc av': { secret_env: 'HTPC_MQTT_SECRET' } } }).some(e => /htpc av/.test(e)))
assert.ok(hostErrors({ ...VALID, targets: { '9htpc': { secret_env: 'HTPC_MQTT_SECRET' } } }).some(e => /9htpc/.test(e)))
assert.ok(hostErrors({ ...VALID, targets: { 'htpc-av': { secret_env: 'HTPC_MQTT_SECRET' } } }).some(e => /htpc-av/.test(e)))
assert.ok(hostErrors({ ...VALID, targets: { htpc: {} } }).some(e => /secret_env/.test(e)))
assert.ok(hostErrors({ ...VALID, targets: { htpc: { secret_env: '' } } }).some(e => /secret_env/.test(e)))
assert.ok(hostErrors({ ...VALID, targets: { htpc: { secret_env: 'htpc_mqtt_secret' } } }).some(e => /secret_env/.test(e)))
assert.ok(hostErrors({ ...VALID, targets: { htpc: { secret_env: '2HTPC_SECRET' } } }).some(e => /secret_env/.test(e)))
assert.ok(hostErrors({ ...VALID, targets: { htpc: { secret_env: 'HTPC_MQTT_SECRET', ip: '10.0.0.9' } } }).some(e => /ip/.test(e)),
    'unknown target keys are rejected -- they would smuggle a command')
assert.ok(hostErrors({ ...VALID, targets: { htpc: { secret_env: 'HTPC_MQTT_SECRET', payload: 'rm -rf' } } }).some(e => /payload/.test(e)))

//  ACK timeout: durations parse, out-of-range values do not.
assert.ok(hostErrors({ ...VALID, targets: { htpc: { secret_env: 'HTPC_SECRET', ack_timeout: '30s' } } }).some(e => /ack_timeout/.test(e)), 'above the cap')
assert.ok(hostErrors({ ...VALID, targets: { htpc: { secret_env: 'HTPC_SECRET', ack_timeout: '50ms' } } }).some(e => /ack_timeout/.test(e)), 'below the floor')
assert.ok(hostErrors({ ...VALID, targets: { htpc: { secret_env: 'HTPC_SECRET', ack_timeout: 'soon' } } }).some(e => /ack_timeout/.test(e)), 'unparseable')
assert.deepEqual(hostErrors({ ...VALID, targets: { htpc: { secret_env: 'HTPC_SECRET', ack_timeout: 3000 } } }), [], 'numbers are accepted')
assert.deepEqual(hostErrors({ ...VALID, targets: { htpc: { secret_env: 'HTPC_SECRET', ack_timeout: '3s' } } }), [], 'string durations are accepted')

//  Sequence steps carrying host commands. The shape schema catches a bad `kind`/`action`
//  value; validateConfig() catches what a shape schema cannot -- a typo in a key *name*,
//  a host step with no target, and host steps smuggled into the simple devices form.
const seqErrors = (sequences) => validateSequences({ sequences })
const stepErrors = (step) => seqErrors([{ name: 'Home Cinema', off: [step] }])

assert.deepEqual(seqErrors(undefined), [], 'absent sequences section stays valid')
assert.deepEqual(seqErrors([]), [], 'empty sequences list stays valid')

//  The step the Home Cinema OFF phase ships with.
assert.deepEqual(stepErrors({ kind: 'host_command', target: 'htpc', action: 'shutdown' }), [], 'the shipped host step validates')
assert.deepEqual(stepErrors({ kind: 'host_command', target: 'htpc' }), [], 'action defaults to shutdown')
assert.deepEqual(stepErrors({ kind: 'host_command', target: 'HTPC', delay: '1s' }), [], 'target is normalized to lowercase, as the service does')

//  Every one of these was a silent no-op before: SequenceContainer only warned and skipped.
assert.ok(stepErrors({ kind: 'host_comand', target: 'htpc' }).some(e => /kind/.test(e)), 'typo in the kind value')
assert.ok(stepErrors({ kind: 'host_command', action: 'shutdown' }).some(e => /target/.test(e)), 'host step with no target')
assert.ok(stepErrors({ kind: 'host_command', target: 'htpc', action: 'reboot' }).some(e => /action/.test(e)), 'action outside v1')
assert.ok(stepErrors({ kind: 'host_command', targt: 'htpc' }).some(e => /unknown keys/.test(e)), 'typo in a key name is caught, not ignored')
assert.ok(stepErrors({ kind: 'host_command', target: 'htpc', device: 'Salon Pilot IR' }).some(e => /device\/payload/.test(e)), 'a host step drives no device')
assert.ok(stepErrors({ kind: 'host_command', target: 'htpc av' }).some(e => /slug/.test(e)), 'target slug shape')
assert.ok(stepErrors({ kind: 'host_command', target: 'htpc', payload: 'shutdown.exe' }).some(e => /device\/payload/.test(e)),
    'a host step cannot carry a payload -- nothing on the wire becomes an executable')
assert.ok(seqErrors([{ name: 'X', devices: [{ kind: 'host_command', target: 'htpc' }] }]).some(e => /simple devices form/.test(e)),
    'host steps belong in on:/off:, never in the simple devices form')

//  Existing step shapes must keep passing untouched.
assert.deepEqual(stepErrors({ device: 'Salon Pilot IR', payload: { ir_command: 'avr_off' }, delay: '100ms' }), [], 'rich device step unchanged')
assert.deepEqual(stepErrors({ device: 'Salon Pilot IR', payload: 'OFF' }), [], 'scalar payload accepted')
assert.deepEqual(seqErrors([{ name: 'X', devices: ['Salon Ambient Left'] }]), [], 'simple-form string entry accepted')
assert.deepEqual(seqErrors([{ name: 'X', devices: [{ device: 'Kitchen LED Strip', command: 'ON', delay: '800ms' }] }]), [], 'simple-form object entry accepted')
assert.ok(stepErrors({ payload: { ir_command: 'avr_off' } }).some(e => /device/.test(e)), 'a device step needs a device')
assert.ok(stepErrors({ device: 'Salon Pilot IR', paylaod: { ir_command: 'avr_off' } }).some(e => /unknown keys/.test(e)), 'typo in a device step key name')
assert.ok(stepErrors('just a string').some(e => /must be an object/.test(e)), 'rich steps must be objects')

console.log('Host command config validation tests passed')
