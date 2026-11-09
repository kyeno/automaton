/**
 * Signed host commands over MQTT -- the Automaton side of the HTPC shutdown contract.
 *
 * v1 supports exactly one action ("shutdown") toward an allowlisted host target whose chat
 * client opted in. Requests are published to `<topic_base>/<target>/command` and correlated
 * with a signed ACK on `<topic_base>/<target>/ack`; an ACK proves only that the request
 * reached the host, never that the machine is physically off (see
 * doc/services/host-commands.md). Nothing from the wire is ever interpolated into a command,
 * and the HMAC secret lives only in the environment.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import crypto from 'node:crypto'

import ConfigService from '../service/configService.js'
import MqttService from '../service/mqttService.js'
import LoggerService from '../service/loggerService.js'
import temporal from '../lib/date.js'

import {
    ACK_STATUSES,
    ALLOWED_ACTIONS,
    CLOCK_SKEW_MS,
    COMMAND_VALIDITY_MS,
    DEFAULT_ACK_TIMEOUT_MS,
    DEFAULT_TOPIC_BASE,
    DISPATCH_TIMEOUT_MS,
    PROCESSED_GRACE_MS,
    PROTOCOL_VERSION,
    TARGET_ID_RE,
    canonicalAck,
    canonicalCommand,
    signCanonical,
    verifySignature
} from './hostProtocol.js'


//  SHostCommandService (module-level singleton)

/** Signed host-command dispatcher: allowlisted targets, per-target secret, ACK correlation. */
class SHostCommandService {

    /** Active target registry: target slug -> { secretEnv, secret, ackTimeoutMs }.
     * @type {Map<string, Object>} */
    #targets = new Map()

    /** Requests awaiting their ACK: request id -> { target, action, resolve, timer, iatMs, expMs }.
     * @type {Map<string, Object>} */
    #pending = new Map()

    /** Resolved request ids kept for the replay guard: id -> expiry timestamp ms.
     * @type {Map<string, number>} */
    #processed = new Map()

    /** Active ACK subscriptions: target slug -> unsubscribe function.
     * @type {Map<string, Function>} */
    #subscriptions = new Map()

    /** Master switch from host_commands.enabled.
     * @type {boolean} */
    #enabled = false

    /** Topic tree root from host_commands.topic_base.
     * @type {string} */
    #topicBase = DEFAULT_TOPIC_BASE

    /** True once init() completed -- gates /config reload like the other services.
     * @type {boolean} */
    #initialized = false

    //  -- Lifecycle ----------------------------------------------------------

    /** Read the host_commands section and open the ACK subscriptions. Missing or disabled
     * configuration leaves the service inert -- never fatal at startup.
     * @async */
    async init() {
        this.#applyConfig()
        this.#subscribeAcks()
        this.#initialized = true
        if (this.#enabled) {
            LoggerService.info(`Host commands enabled for ${this.#targets.size} target(s)`, 'HostCommandService')
        }
    }

    /** Re-read the section from the live config and rebuild subscriptions -- the /config reload
     * hook. In-flight requests are resolved as failed so no caller waits on a discarded registry.
     * @returns {Promise<Object>} Reload report for UI rendering */
    async reload() {
        if (!this.#initialized) return { ok: true, skipped: true, targets: 0 }
        try {
            this.#failAllPending('host commands reloaded')
            this.#unsubscribeAcks()
            this.#applyConfig()
            this.#subscribeAcks()
            return { ok: true, targets: this.#targets.size, enabled: this.#enabled }
        } catch (error) {
            LoggerService.warn(`Host commands kept as-is after failed reload: ${error.message}`, 'HostCommandService')
            return { ok: false, error: error.message, targets: this.#targets.size }
        }
    }

    /** Release every pending request, subscription and timer (graceful shutdown).
     * @async */
    async cleanup() {
        this.#failAllPending('host command service shutting down')
        this.#unsubscribeAcks()
        this.#initialized = false
    }

    /** Whether bootstrap initialized this service.
     * @returns {boolean} Initialization status */
    isInitialized() {
        return this.#initialized
    }

    /** Whether the master switch is on and at least one target is configured.
     * @returns {boolean} Capability status */
    isEnabled() {
        return this.#enabled && this.#targets.size > 0
    }

    /** Public target inventory for UI/diagnostics -- never exposes the secret.
     * @returns {Object[]} Targets sorted by slug with readiness */
    listTargets() {
        return [...this.#targets.entries()]
            .map(([target, cfg]) => ({
                target,
                ready: Boolean(cfg.secret),
                secret_env: cfg.secretEnv,
                ack_timeout_ms: cfg.ackTimeoutMs,
                command_topic: this.commandTopic(target),
                ack_topic: this.ackTopic(target)
            }))
            .sort((a, b) => a.target.localeCompare(b.target))
    }

    //  -- Topics -------------------------------------------------------------

    /** Command topic for one allowlisted target.
     * @param {string} target - Target slug
     * @returns {string} Exact publish topic */
    commandTopic(target) {
        return `${this.#topicBase}/${target}/command`
    }

    /** ACK topic for one allowlisted target.
     * @param {string} target - Target slug
     * @returns {string} Exact subscription topic */
    ackTopic(target) {
        return `${this.#topicBase}/${target}/ack`
    }

    //  -- Public API ---------------------------------------------------------

    /** Ask one host to shut down and wait for its signed ACK.
     *
     * Returns an explicit outcome; it never throws and never retries:
     *   accepted -- the host validated the request and acknowledged it (NOT proof it is off);
     *   failed   -- rejected by the host, unconfigured target, missing secret, no ACK
     *               subscription, or local dispatch error;
     *   timeout  -- no matching signed ACK within the target's ack_timeout.
     *
     * @param {string} target - Allowlisted target slug
     * @param {Object} [options] - Per-request overrides
     * @param {string} [options.action='shutdown'] - Action; only 'shutdown' is accepted in v1
     * @returns {Promise<Object>} { status, target, action, id?, reason?, ack_ts_ms? }
     * @async */
    async requestShutdown(target, options = {}) {
        const name = String(target ?? '').trim().toLowerCase()
        const action = String(options?.action ?? 'shutdown').trim().toLowerCase()

        if (!this.#enabled) {
            return { status: 'failed', target: name, action, reason: 'host commands are disabled' }
        }
        if (!ALLOWED_ACTIONS.has(action)) {
            return { status: 'failed', target: name, action, reason: `unsupported action "${action}"` }
        }
        const cfg = this.#targets.get(name)
        if (!cfg) {
            return { status: 'failed', target: name, action, reason: `target "${name}" is not allowlisted` }
        }
        if (!cfg.secret) {
            return {
                status: 'failed', target: name, action,
                reason: `secret environment variable "${cfg.secretEnv}" is not set`
            }
        }
        if (!MqttService.isConnected()) {
            return { status: 'failed', target: name, action, reason: 'MQTT broker is not connected' }
        }
        //  Without the ACK subscription a request can never be confirmed -- say so now, not after a silent timeout.
        if (!this.#subscriptions.has(name)) {
            return { status: 'failed', target: name, action, reason: `target "${name}" has no ACK subscription (host commands reloaded while MQTT was disconnected)` }
        }

        const id = crypto.randomUUID()
        const iatMs = Date.now()
        const expMs = iatMs + COMMAND_VALIDITY_MS
        const signature = signCanonical(cfg.secret, canonicalCommand({ id, target: name, action, iatMs, expMs }))
        const payload = {
            v: PROTOCOL_VERSION,
            id,
            target: name,
            action,
            iat_ms: iatMs,
            exp_ms: expMs,
            sig: signature
        }

        return new Promise((resolve) => {
            const pending = { target: name, action, resolve, timer: null, iatMs, expMs }
            this.#pending.set(id, pending)

            //  The ACK clock starts only after local dispatch -- queueing time is not host latency.
            MqttService.publishAsync(this.commandTopic(name), payload, DISPATCH_TIMEOUT_MS, { qos: 1, retain: false })
                .then(() => {
                    if (!this.#pending.has(id)) return
                    pending.timer = setTimeout(() => this.#expire(id), cfg.ackTimeoutMs)
                    LoggerService.debug(`Host command dispatched: ${name}/${action} id=${id}`, 'HostCommandService')
                })
                .catch((error) => {
                    this.#pending.delete(id)
                    LoggerService.warn(`Host command dispatch failed: ${name}/${action} id=${id}: ${error.message}`, 'HostCommandService')
                    resolve({ status: 'failed', target: name, action, id, reason: error.message })
                })
        })
    }


    //  -- Internals ----------------------------------------------------------

    /** Rebuild the target registry from the live main config section.
     * @private */
    #applyConfig() {
        const section = ConfigService.getSection('host_commands') ?? {}
        this.#enabled = section.enabled === true
        const base = typeof section.topic_base === 'string' ? section.topic_base.trim() : ''
        this.#topicBase = base || DEFAULT_TOPIC_BASE

        const raw = section.targets
        const registry = new Map()
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [key, entry] of Object.entries(raw)) {
                const name = String(key).trim().toLowerCase()
                if (!TARGET_ID_RE.test(name)) {
                    LoggerService.warn(`Host target "${key}" is not a valid slug -- skipped`, 'HostCommandService')
                    continue
                }
                const cfg = entry && typeof entry === 'object' ? entry : {}
                const secretEnv = typeof cfg.secret_env === 'string' ? cfg.secret_env.trim() : ''
                let ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS
                if (cfg.ack_timeout !== undefined && cfg.ack_timeout !== null) {
                    const parsed = temporal.parseDurationMs(cfg.ack_timeout)
                    if (parsed === null) {
                        LoggerService.warn(`Host target "${name}": invalid ack_timeout "${cfg.ack_timeout}" -- using default`, 'HostCommandService')
                    } else if (parsed > 0) {
                        ackTimeoutMs = parsed
                    }
                }
                const secret = secretEnv ? (process.env[secretEnv] ?? '') : ''
                registry.set(name, { secretEnv, secret, ackTimeoutMs })
                if (!secret) {
                    LoggerService.warn(`Host target "${name}": environment variable "${secretEnv || '(secret_env missing)'}" is unset -- requests will fail`, 'HostCommandService')
                }
            }
        }
        this.#targets = registry
    }

    /** Open one exact ACK subscription per target (no wildcards, dedupe exempt).
     * @private */
    #subscribeAcks() {
        for (const target of this.#targets.keys()) {
            const topic = this.ackTopic(target)
            const unsubscribe = MqttService.subscribe(
                topic,
                (received, message) => this.#handleAck(received, message),
                { dedupe: false }
            )
            if (typeof unsubscribe === 'function') {
                this.#subscriptions.set(target, unsubscribe)
            } else {
                LoggerService.warn(`Host target "${target}" has no ACK subscription -- MQTT was not connected`, 'HostCommandService')
            }
        }
    }

    /** Drop every ACK subscription.
     * @private */
    #unsubscribeAcks() {
        for (const unsubscribe of this.#subscriptions.values()) {
            try { unsubscribe() } catch (error) {
                LoggerService.warn(`Host ACK unsubscribe failed: ${error.message}`, 'HostCommandService')
            }
        }
        this.#subscriptions.clear()
    }

    /** Validate one incoming ACK and resolve its pending request, if any.
     * @private
     * @param {string} topic - Exact topic the message arrived on
     * @param {string} message - Raw payload */
    #handleAck(topic, message) {
        let data
        try {
            data = JSON.parse(message)
        } catch {
            LoggerService.warn(`Host ACK on "${topic}" is not valid JSON -- ignored`, 'HostCommandService')
            return
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return

        const target = String(data.target ?? '').trim().toLowerCase()
        const status = String(data.status ?? '').trim().toLowerCase()
        const id = String(data.id ?? '')
        const cfg = this.#targets.get(target)

        //  Topic/target binding: an ACK on one target's topic must name that target.
        if (!cfg || topic !== this.ackTopic(target)) {
            LoggerService.warn(`Host ACK on "${topic}" names unknown target "${target}" -- ignored`, 'HostCommandService')
            return
        }
        if (data.v !== PROTOCOL_VERSION || !ACK_STATUSES.has(status)) {
            LoggerService.warn(`Host ACK for "${target}" has unsupported v/status -- ignored`, 'HostCommandService')
            return
        }

        const pending = this.#pending.get(id)
        if (!pending) {
            //  Stale, replayed, forged or simply late -- there is nothing to resolve.
            LoggerService.debug(`Host ACK for "${target}" id=${id} matches no pending request -- ignored`, 'HostCommandService')
            return
        }
        if (pending.target !== target) {
            LoggerService.warn(`Host ACK for "${target}" id=${id} does not match the pending request -- ignored`, 'HostCommandService')
            return
        }
        if (!verifySignature(cfg.secret, canonicalAck({ id, target, status, tsMs: data.ts_ms }), data.sig)) {
            LoggerService.warn(`Host ACK for "${target}" id=${id} failed signature verification -- ignored`, 'HostCommandService')
            return
        }

        const tsMs = Number(data.ts_ms)
        const now = Date.now()
        if (!Number.isFinite(tsMs) || tsMs < pending.iatMs - CLOCK_SKEW_MS || tsMs > now + CLOCK_SKEW_MS) {
            LoggerService.warn(`Host ACK for "${target}" id=${id} has an implausible timestamp -- ignored`, 'HostCommandService')
            return
        }

        this.#resolve(id, { status, target, action: pending.action, id, ack_ts_ms: data.ts_ms })
    }

    /** Settle one pending request exactly once.
     * @private
     * @param {string} id - Request id
     * @param {Object} outcome - Result handed back to the caller */
    #resolve(id, outcome) {
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        this.#processed.set(id, pending.expMs + PROCESSED_GRACE_MS)
        this.#purgeProcessed()
        LoggerService.info(`Host command ${outcome.target}/${outcome.action} id=${id} -> ${outcome.status}`, 'HostCommandService')
        pending.resolve(outcome)
    }

    /** Ack timeout reached: report it, never retry.
     * @private
     * @param {string} id - Request id */
    #expire(id) {
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        pending.timer = null
        LoggerService.warn(`Host command ${pending.target}/${pending.action} id=${id} timed out waiting for an ACK`, 'HostCommandService')
        pending.resolve({ status: 'timeout', target: pending.target, action: pending.action, id, reason: 'no ACK within the timeout' })
    }

    /** Fail every in-flight request (reload/shutdown) so no caller hangs on a discarded registry.
     * @private
     * @param {string} reason - Shared explanation */
    #failAllPending(reason) {
        for (const [id, pending] of [...this.#pending.entries()]) {
            this.#pending.delete(id)
            if (pending.timer) clearTimeout(pending.timer)
            pending.resolve({ status: 'failed', target: pending.target, action: pending.action, id, reason })
        }
    }

    /** Drop replay-guard entries whose grace period has elapsed.
     * @private */
    #purgeProcessed() {
        const now = Date.now()
        for (const [id, expiry] of this.#processed.entries()) {
            if (expiry <= now) this.#processed.delete(id)
        }
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const HostCommandService = Object.freeze(new SHostCommandService())
export default HostCommandService
