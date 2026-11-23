/**
 * Host command wire protocol (v2) -- the shared contract between Automaton and the
 * LANFLIX client running on a host machine.
 *
 * Trusted wired LAN: a request carries the target's shared key and a random ID.
 * Replies echo ID and target. No peer timestamps or signatures are involved.
 * Never retain commands or replay an offline backlog.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'



//  Wire constants (v2) -- shared with LANFLIX.

/** Protocol version stamped on every command and ACK.
 * @type {number} */
export const PROTOCOL_VERSION = 2

/** Topic tree for host commands; never under the Zigbee2MQTT prefix.
 * @type {string} */
export const DEFAULT_TOPIC_BASE = 'automaton/host'

/** Default wait for a matching ACK after local dispatch.
 * @type {number} */
export const DEFAULT_ACK_TIMEOUT_MS = 3_000

/** Shortest ACK timeout a target may ask for -- below this the host is raced, not measured.
 * @type {number} */
export const ACK_TIMEOUT_MIN_MS = 100

/** Longest ACK timeout a target may ask for -- sequences must not hang on one host.
 * @type {number} */
export const ACK_TIMEOUT_MAX_MS = 10_000

/** The only action v2 accepts.
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
