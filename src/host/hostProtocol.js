/**
 * Host command wire protocol (v1) -- the shared contract between Automaton and the
 * chat client running on a host machine.
 *
 * One action exists in v1: "shutdown". Requests travel on `<topic_base>/<target>/command`
 * and are answered by a signed ACK on `<topic_base>/<target>/ack`. Signatures are
 * HMAC-SHA256 over canonical newline-delimited byte strings, so both the Node and Dart
 * sides can reproduce them byte-for-byte (see doc/services/host-commands.md).
 *
 * This module is dependency-free on purpose: services, validators and tests all import
 * the same definitions, and nothing here touches MQTT, config or logging.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import crypto from 'node:crypto'


//  Wire constants (v1) -- shared verbatim with the Flutter chat implementation.

/** Protocol version stamped on every command and ACK.
 * @type {number} */
export const PROTOCOL_VERSION = 1

/** Topic tree for host commands; never under the Zigbee2MQTT prefix.
 * @type {string} */
export const DEFAULT_TOPIC_BASE = 'automaton/host'

/** Default wait for a matching signed ACK after local dispatch.
 * @type {number} */
export const DEFAULT_ACK_TIMEOUT_MS = 3_000

/** Lifetime of a published command (exp_ms = iat_ms + this).
 * @type {number} */
export const COMMAND_VALIDITY_MS = 15_000

/** Extra time an accepted request ID stays in the replay guard after its validity window.
 * @type {number} */
export const PROCESSED_GRACE_MS = 60_000

/** Upper bound for handing the command to mqtt.js.
 * @type {number} */
export const DISPATCH_TIMEOUT_MS = 5_000

/** Tolerance applied to peer timestamps when validating an ACK.
 * @type {number} */
export const CLOCK_SKEW_MS = 2_000

/** Shortest ACK timeout a target may ask for -- below this the host is raced, not measured.
 * @type {number} */
export const ACK_TIMEOUT_MIN_MS = 100

/** Longest ACK timeout a target may ask for -- sequences must not hang on one host.
 * @type {number} */
export const ACK_TIMEOUT_MAX_MS = 10_000

/** The only action v1 accepts.
 * @type {ReadonlySet<string>} */
export const ALLOWED_ACTIONS = Object.freeze(new Set(['shutdown']))

/** ACK statuses the protocol recognizes.
 * @type {ReadonlySet<string>} */
export const ACK_STATUSES = Object.freeze(new Set(['accepted', 'failed', 'rejected']))

/** Keys a target entry may carry -- anything else (payload, command, executable) is rejected.
 * @type {ReadonlySet<string>} */
export const TARGET_KEYS = Object.freeze(new Set(['secret_env', 'ack_timeout']))

/** Target IDs are plain lowercase slugs -- they become MQTT topic levels verbatim.
 * @type {RegExp} */
export const TARGET_ID_RE = /^[a-z][a-z0-9_]{0,31}$/

/** Environment variable names must be unmistakably env vars.
 * @type {RegExp} */
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,}$/


//  Canonical signing helpers -- the Dart implementation mirrors these byte-for-byte.

/** Canonical byte string for a command signature: v1 + LF + id + LF + target + LF + action
 * + LF + decimal iat_ms + LF + decimal exp_ms.
 * @param {Object} parts - Command fields
 * @param {string} parts.id - Request UUID
 * @param {string} parts.target - Target slug
 * @param {string} parts.action - Action name
 * @param {number} parts.iatMs - Issue time in ms
 * @param {number} parts.expMs - Expiry time in ms
 * @returns {string} Canonical string (signed as UTF-8) */
export function canonicalCommand({ id, target, action, iatMs, expMs }) {
    return ['v1', String(id), String(target), String(action), String(iatMs), String(expMs)].join('\n')
}

/** Canonical byte string for an ACK signature: v1 + LF + ack + LF + id + LF + target
 * + LF + status + LF + decimal ts_ms.
 * @param {Object} parts - ACK fields
 * @param {string} parts.id - Request UUID being acknowledged
 * @param {string} parts.target - Target slug
 * @param {string} parts.status - accepted | failed | rejected
 * @param {number} parts.tsMs - ACK timestamp in ms
 * @returns {string} Canonical string (signed as UTF-8) */
export function canonicalAck({ id, target, status, tsMs }) {
    return ['v1', 'ack', String(id), String(target), String(status), String(tsMs)].join('\n')
}

/** HMAC-SHA256 of a canonical string as lowercase hex.
 * @param {string} secret - Shared per-host secret
 * @param {string} canonical - Canonical string to sign
 * @returns {string} Lowercase hex digest */
export function signCanonical(secret, canonical) {
    return crypto.createHmac('sha256', String(secret)).update(Buffer.from(canonical, 'utf8')).digest('hex')
}

/** Constant-time comparison of a claimed signature against the expected digest.
 * @param {string} secret - Shared per-host secret
 * @param {string} canonical - Canonical string the signature must cover
 * @param {*} signature - Signature claimed by the peer
 * @returns {boolean} true only for an exact 64-hex match */
export function verifySignature(secret, canonical, signature) {
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false
    const expected = Buffer.from(signCanonical(secret, canonical), 'hex')
    const claimed = Buffer.from(signature, 'hex')
    return expected.length === claimed.length && crypto.timingSafeEqual(expected, claimed)
}
