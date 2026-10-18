/**
 * Email Service -- SMTP notification client for house owners.
 *
 * Owns the outbound mail channel: an SMTP transport built from the SMTP_* environment
 * secrets, the recipient list from `house_owners`, the i18n templates from
 * etc/i18n/<locale>/email.yaml and a per-kind cooldown so one incident never turns into
 * a stack of identical mails. Sends are queued FIFO on a single chain -- a slow or dead
 * relay can never make two notifications overtake each other, and it can never block an
 * automation's execute() either.
 *
 * Connection strings and the relay password stay in .env; every behavioural setting
 * (recipients, sender, enabled kinds, cooldown) lives in etc/automaton.yaml.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import nodemailer from 'nodemailer'
import { parseDocument as yamlParseDocument } from 'yaml'

import ConfigService from './configService.js'
import LoggerService from './loggerService.js'
import CacheService from './cacheService.js'
import EventBus from './eventBus.js'
import I18nLoader from './i18nLoader.js'
import temporal from '../lib/date.js'
import { PROJECT_ROOT } from '../lib/projectRoot.js'
import { interpolateTokens, TOKEN_INTERPOLATION_REGEX } from '../lib/string.js'


/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Default fallback locale for email templates. */
const DEFAULT_LOCALE = 'pl_PL'

/** Event channel this service subscribes to. */
const NOTIFY_CHANNEL = 'notify:email'

/** SMTP handshake and socket timeouts in milliseconds. */
const SMTP_TIMEOUT_MS = 15_000

/** Cap on queued-but-unsent messages; deeper queues are dropped with a warning. */
const MAX_PENDING_SENDS = 25

/** Hard ceiling on one rendered message body, in characters. */
const MAX_BODY_LENGTH = 4000

/** Default re-notification window for one kind ("12h"). */
const DEFAULT_COOLDOWN_MS = 12 * 3_600_000

/** Prefix of every subject line when email.subject_prefix is unset. */
const DEFAULT_SUBJECT_PREFIX = 'Automaton'

/** Sender display name used when only an address is configured. */
const DEFAULT_SENDER_NAME = 'Automaton'

/** Shape a usable mail address must have -- deliberately strict, no display names. */
const EMAIL_ADDRESS_REGEX = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

/** Redis key prefix holding per-kind notification cooldowns. */
const COOLDOWN_KEY_PREFIX = 'mail:cooldown'

//  SEmailService (module-level singleton)

/** Stateless SMTP notification client, queued FIFO and gated per notification kind. */
class SEmailService {

    /** @type {{host: string, port: number, secure: boolean, user: string, pass: string}|null} */ #settings = null
    /** @type {Object|null} */ #transport = null
    /** @type {string} */ #from = ''
    /** @type {string} */ #subjectPrefix = DEFAULT_SUBJECT_PREFIX
    /** @type {Record<string, boolean>} */ #kinds = {}
    /** @type {number} */ #cooldownMs = DEFAULT_COOLDOWN_MS
    /** @type {boolean} */ #enabled = false
    /** @type {boolean} */ #initialized = false
    /** @type {Function|null} */ #unsubscribe = null
    /** @type {Promise<*>} */ #chain = Promise.resolve()
    /** @type {number} */ #pending = 0
    /** @type {Record<string, unknown>|null} */ #bundle = null
    /** @type {string|null} */ #bundleLocale = null
    /** @type {Map<string, number>} */ #cooldowns = new Map()
    /** @type {Set<string>} */ #warned = new Set()
    /** @type {{sent: number, failed: number, skipped: number}} */ #stats = { sent: 0, failed: 0, skipped: 0 }

    //  -- Lifecycle ----------------------------------------------------------

    /** Check whether the SMTP relay is configured via environment variables, init state aside.
     * @returns {boolean} True when SMTP_HOST is set and non-empty */
    isConfigured() {
        return Boolean(process.env.SMTP_HOST && String(process.env.SMTP_HOST).trim())
    }

    /** Initialize the mail channel. Call once during application startup.
     *
     * An unconfigured relay is not an error: the service marks itself initialized and
     * disabled, exactly like TTS and the AI assistant do, so callers can ask freely.
     * @async */
    async init() {
        if (ConfigService.get('email.enabled') === false) {
            LoggerService.debug('Email: email.enabled=false -- email notifications disabled', 'EmailService')
            this.#initialized = true
            return
        }

        const settings = this.#readEnv()
        if (!settings) {
            LoggerService.debug('Email: SMTP_HOST not set -- email disabled', 'EmailService')
            this.#initialized = true
            return
        }

        this.#settings = settings
        this.#from = this.#resolveFrom()
        if (!this.#from) {
            LoggerService.warn(
                'Email: SMTP_HOST set but no sender address -- set email.from in etc/automaton.yaml -- email disabled',
                'EmailService'
            )
            this.#initialized = true
            return
        }

        this.#subjectPrefix = this.#readSubjectPrefix()
        this.#kinds = this.#readKinds()
        this.#cooldownMs = this.#readCooldownMs()
        this.#transport = this.#buildTransport()
        this.#subscribe()
        this.#enabled = true

        LoggerService.info(
            `Email enabled -- relay=${settings.host}:${settings.port}${settings.secure ? ' (TLS)' : ''}, sender=${this.#from}, recipients=${this.getRecipients().length}`,
            'EmailService'
        )
        this.#initialized = true
    }

    /** Check whether the mail channel is active and ready to accept sends.
     * @returns {boolean} */
    isEnabled() {
        return this.#enabled
    }

    /** Whether init() has completed at all (enabled or not) -- gate callers use before sending.
     * @returns {boolean} */
    isReady() {
        return this.#initialized
    }

    /** Gracefully unsubscribe from EventBus and close the SMTP pool during shutdown.
     * @async */
    async cleanup() {
        if (this.#unsubscribe) {
            this.#unsubscribe()
            this.#unsubscribe = null
        }
        this.#enabled = false
        if (this.#transport && typeof this.#transport.close === 'function') {
            try { this.#transport.close() } catch { /* best-effort teardown */ }
        }
        this.#transport = null
    }

    //  -- Public API -------------------------------------------------------

    /** Normalized recipient list from `house_owners`, entries without a usable address dropped.
     * @returns {Array<{name: string, email: string}>} Usable recipients */
    getRecipients() {
        const raw = ConfigService.get('house_owners')
        const list = Array.isArray(raw) ? raw : (raw != null ? [raw] : [])
        const out = []
        for (const entry of list) {
            const owner = this.#normalizeOwner(entry)
            if (owner) out.push(owner)
        }
        return out
    }

    /** Cumulative send counters for this process run.
     * @returns {{sent: number, failed: number, skipped: number}} Copy of the counters */
    getStats() {
        return { ...this.#stats }
    }

    /** Replace the active SMTP transport. The production transport is built from .env;
     *  this seam lets a test (or a future relay type) drive the send path without a server.
     * @param {Object|null} transport - Transport exposing sendMail(); null detaches
     * @returns {void} */
    attachTransport(transport) {
        this.#transport = transport && typeof transport.sendMail === 'function' ? transport : null
    }

    /** Await every send queued so far. Used by shutdown and by tests.
     * @returns {Promise<*>} Resolves once the queue drains
     * @async */
    async flush() {
        await this.#chain
    }

    /** Queue one message to one address. Acceptance is immediate -- the queue is what
     *  serializes delivery, so no caller ever waits on the relay.
     * @param {Object} [message] - Message request
     * @param {string} [message.to=''] - Recipient address
     * @param {string} [message.subject=''] - Subject line
     * @param {string} [message.text=''] - Plain-text body
     * @returns {boolean} true when the message was accepted into the queue */
    send(message = {}) {
        const { to = '', subject = '', text = '' } = message

        if (!this.#enabled || !this.#transport) return false

        const address = String(to ?? '').trim()
        if (!EMAIL_ADDRESS_REGEX.test(address)) {
            this.#reject('recipient', `invalid recipient address ${JSON.stringify(address)}`)
            return false
        }

        const body = this.#clipBody(text)
        if (!body) {
            this.#reject('body', 'empty message body -- nothing sent')
            return false
        }

        if (this.#pending >= MAX_PENDING_SENDS) {
            this.#stats.skipped++
            this.#reject('queue', `send queue is full (${MAX_PENDING_SENDS} pending) -- dropping the message to ${address}`)
            return false
        }

        this.#pending++
        const job = { to: address, subject: this.#clipSubject(subject), text: body }
        const task = () => this.#deliver(job)
        this.#chain = this.#chain.then(task, task)
        return true
    }

    /** Notify the house owners about one incident kind, using the locale's email templates.
     *
     * Gated by the per-kind switch (`email.notify.<kind>`) and by the notification
     * cooldown, so one incident produces one round of mail and not a copy per report.
     * @param {Object} [request] - Notification request
     * @param {string} [request.kind=''] - Notification kind, e.g. 'gardener_stuck'
     * @param {Record<string, string>} [request.tokens={}] - Values for the template's {% tokens %}
     * @param {string} [request.message=''] - Announcement body (the text speech just used)
     * @param {Record<string, *>} [request.meta={}] - Extra context used for subject tokens only
     * @returns {Promise<boolean>} true when at least one mail was queued
     * @async */
    async notify(request = {}) {
        const { kind = '', tokens = {}, message = '', meta = {} } = request

        if (!this.#enabled) return false
        if (!kind) {
            this.#reject('kind', 'notify() called without a notification kind')
            return false
        }
        if (this.#kinds[kind] === false) {
            LoggerService.debug(`Email: notifications for "${kind}" are disabled -- nothing sent`, 'EmailService')
            return false
        }
        if (!String(message ?? '').trim()) {
            this.#reject(kind, 'notify() called with an empty message body')
            return false
        }
        if (await this.#cooldownActive(kind)) return false

        const owners = this.getRecipients()
        if (owners.length === 0) {
            this.#reject(kind, 'no usable address in house_owners -- nobody to notify')
            return false
        }

        const section = this.#sectionFor(kind)
        let queued = 0
        for (const owner of owners) {
            const merged = { ...this.#baseTokens(), ...tokens, owner_name: owner.name, owner_email: owner.email }
            const subject = this.#renderSubject(section, merged, kind, meta)
            const text = this.#renderBody(section, merged, message)
            if (this.send({ to: owner.email, subject, text })) queued++
        }
        if (queued === 0) return false

        await this.#markNotified(kind)
        LoggerService.info(`Email: notified ${queued} owner(s) about "${kind}"`, 'EmailService')
        return true
    }

    /** Queue a configuration-check mail for every owner (or for one explicit address).
     *  Explicitly requested by a user, so the notification cooldown never silences it.
     * @param {string|null} [recipient=null] - Address to mail instead of the owner list
     * @returns {Promise<boolean>} true when at least one mail was queued
     * @async */
    async test(recipient = null) {
        if (!this.#enabled) return false

        const owners = recipient
            ? [{ name: DEFAULT_SENDER_NAME, email: String(recipient).trim() }]
            : this.getRecipients()
        if (owners.length === 0) {
            this.#reject('test', 'no usable address in house_owners -- nothing to test')
            return false
        }

        const section = this.#sectionFor('test')
        let queued = 0
        for (const owner of owners) {
            const merged = { ...this.#baseTokens(), owner_name: owner.name, owner_email: owner.email }
            const subject = this.#renderSubject(section, merged, 'test', {})
            const text = this.#renderBody(section, merged, this.#testBody(section, merged))
            if (this.send({ to: owner.email, subject, text })) queued++
        }
        return queued > 0
    }

    //  -- Private helpers ---------------------------------------------------

    /** Read the SMTP relay settings from the environment. The password is never logged.
     * @returns {{host: string, port: number, secure: boolean, user: string, pass: string}|null}
     * @private */
    #readEnv() {
        const host = String(process.env.SMTP_HOST ?? '').trim()
        if (!host) return null

        const secureRaw = String(process.env.SMTP_SECURE ?? '').trim().toLowerCase()
        const rawPort = Number(String(process.env.SMTP_PORT ?? '').trim())
        const port = (Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535)
            ? Math.trunc(rawPort)
            : (secureRaw === 'true' ? 465 : 587)
        const secure = secureRaw ? secureRaw === 'true' : port === 465

        return {
            host,
            port,
            secure,
            user: String(process.env.SMTP_USER ?? '').trim(),
            pass: String(process.env.SMTP_PASS ?? ''),
        }
    }

    /** Resolve the sender address: email.from first, the relay login as the fallback.
     * @returns {string} Usable sender address, or '' when neither is one
     * @private */
    #resolveFrom() {
        const configured = String(ConfigService.get('email.from') ?? '').trim()
        if (configured) {
            if (EMAIL_ADDRESS_REGEX.test(configured)) return configured
            LoggerService.warn(
                `Email: email.from ${JSON.stringify(configured)} is not a mail address -- email disabled`,
                'EmailService'
            )
            return ''
        }

        const login = String(process.env.SMTP_USER ?? '').trim()
        return EMAIL_ADDRESS_REGEX.test(login) ? login : ''
    }

    /** Read the subject prefix, keeping an explicit empty value as "no prefix".
     * @returns {string} Prefix (may be empty)
     * @private */
    #readSubjectPrefix() {
        const raw = ConfigService.get('email.subject_prefix')
        if (typeof raw !== 'string') return DEFAULT_SUBJECT_PREFIX
        return raw.trim()
    }

    /** Read the per-kind notification switches from email.notify.
     * @returns {Record<string, boolean>} Kind to enabled map
     * @private */
    #readKinds() {
        const raw = ConfigService.get('email.notify')
        const out = {}
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
        for (const [key, value] of Object.entries(raw)) {
            if (typeof value === 'boolean') out[key] = value
        }
        return out
    }

    /** Read the notification cooldown; accepts "12h", "30m", plain milliseconds.
     * @returns {number} Cooldown window in milliseconds (>= 0)
     * @private */
    #readCooldownMs() {
        const raw = ConfigService.get('email.cooldown')
        if (raw === null || raw === undefined || raw === '') return DEFAULT_COOLDOWN_MS
        const ms = temporal.parseDurationMs(raw)
        if (ms === null || ms < 0) {
            LoggerService.warn(
                `Email: invalid email.cooldown ${JSON.stringify(raw)} (expected e.g. "12h" or plain milliseconds); using default (${temporal.millisecondsToHumanReadable(DEFAULT_COOLDOWN_MS)})`,
                'EmailService'
            )
            return DEFAULT_COOLDOWN_MS
        }
        return ms
    }

    /** Build the nodemailer transport for the relay settings.
     *
     * One connection at a time: the queue is FIFO, and a relay that accepts a second
     * parallel delivery is a relay that lets two notifications overtake each other.
     * @returns {Object} Configured nodemailer transport
     * @private */
    #buildTransport() {
        const settings = this.#settings
        return nodemailer.createTransport({
            host: settings.host,
            port: settings.port,
            secure: settings.secure,
            auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
            connectionTimeout: SMTP_TIMEOUT_MS,
            greetingTimeout: SMTP_TIMEOUT_MS,
            socketTimeout: SMTP_TIMEOUT_MS,
            maxConnections: 1,
            tls: { minVersion: 'TLSv1.2' },
        })
    }

    /** Subscribe to the shared notification channel so any component can request a mail
     *  without importing this service.
     * @private */
    #subscribe() {
        this.#unsubscribe = EventBus.subscribe(NOTIFY_CHANNEL, (payload) => {
            this.notify(payload ?? {}).catch((error) => {
                LoggerService.warn(`Email notification request failed: ${error.message}`, 'EmailService')
            })
        })
    }

    /** Normalize one house_owners entry into a usable recipient.
     *  Accepts the documented shape ({ name, email }) and a bare address string;
     *  anything without a well-formed address is dropped, not silently mangled.
     * @param {*} entry - Raw config entry
     * @returns {{name: string, email: string}|null} Usable owner, or null
     * @private */
    #normalizeOwner(entry) {
        const raw = typeof entry === 'string' ? { name: '', email: entry } : entry
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

        const email = String(raw.email ?? '').trim()
        if (!EMAIL_ADDRESS_REGEX.test(email)) return null

        const name = String(raw.name ?? '').trim()
        return { name: name || email.split('@')[0], email }
    }

    /** Warn about a rejected send once per reason, then keep the detail at debug level.
     * @param {string} label - Reason key used for the dedupe
     * @param {string} message - Human-readable detail
     * @private */
    #reject(label, message) {
        const key = `reject:${label}`
        if (this.#warned.has(key)) {
            LoggerService.debug(`Email: ${message}`, 'EmailService')
            return
        }
        this.#warned.add(key)
        LoggerService.warn(`Email: ${message}`, 'EmailService')
    }

    /** Normalize a body to plain text within the length ceiling.
     * @param {*} text - Raw body
     * @returns {string} Body ready for transport, '' when there is nothing to send
     * @private */
    #clipBody(text) {
        const raw = String(text ?? '').replace(/\r\n/g, '\n').trim()
        if (!raw) return ''
        if (raw.length <= MAX_BODY_LENGTH) return raw
        this.#reject('body', `message body longer than ${MAX_BODY_LENGTH} characters -- truncated`)
        return `${raw.slice(0, MAX_BODY_LENGTH - 3).trimEnd()}...`
    }

    /** Flatten a subject to a single line within the transport's length ceiling.
     * @param {*} subject - Raw subject
     * @returns {string} Single-line subject
     * @private */
    #clipSubject(subject) {
        const raw = String(subject ?? '').replace(/\s+/g, ' ').trim()
        return raw.length > 200 ? raw.slice(0, 197).trimEnd() : raw
    }

    /** Hand one queued message to the relay. Never throws -- the chain must survive
     *  a dead relay, or one failed send would silence the channel for good.
     * @param {{to: string, subject: string, text: string}} job - Queued message
     * @returns {Promise<boolean>} true when the relay accepted it
     * @private
     * @async */
    async #deliver(job) {
        if (!this.#transport) {
            this.#pending = Math.max(0, this.#pending - 1)
            return false
        }

        try {
            await this.#transport.sendMail({
                from: this.#from,
                to: job.to,
                subject: job.subject,
                text: job.text,
            })
            this.#stats.sent++
            LoggerService.debug(`Email sent to ${job.to} (subject "${job.subject}")`, 'EmailService')
            return true
        } catch (error) {
            this.#stats.failed++
            LoggerService.warn(`Email to ${job.to} failed: ${error.message}`, 'EmailService')
            return false
        } finally {
            this.#pending = Math.max(0, this.#pending - 1)
        }
    }

    /** Load the email bundle for the active locale, cached per locale so a /config
     *  reload that switches language picks the new templates up on the next notification.
     * @returns {Record<string, unknown>|null} Parsed bundle, or null when unavailable
     * @private */
    #loadBundle() {
        const locale = I18nLoader.isReady ? I18nLoader.getLocale() : DEFAULT_LOCALE
        if (this.#bundle !== null && this.#bundleLocale === locale) return this.#bundle

        let bundle = null
        try {
            const filePath = path.join(I18N_ROOT, locale, 'email.yaml')
            if (!fs.existsSync(filePath)) {
                LoggerService.warn(
                    `Email: no bundle at ${filePath} -- falling back to '${DEFAULT_LOCALE}'`,
                    'EmailService'
                )
                bundle = this.#readBundle(path.join(I18N_ROOT, DEFAULT_LOCALE, 'email.yaml'))
            } else {
                bundle = this.#readBundle(filePath)
            }
        } catch (error) {
            LoggerService.warn(`Email: failed to load the email bundle for '${locale}': ${error.message}`, 'EmailService')
        }

        this.#bundle = bundle
        this.#bundleLocale = locale
        return this.#bundle
    }

    /** Parse one YAML bundle file.
     * @param {string} filePath - Bundle path
     * @returns {Record<string, unknown>|null} Parsed root object, or null
     * @private */
    #readBundle(filePath) {
        if (!fs.existsSync(filePath)) return null
        const doc = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
        return doc.contents?.toJSON() ?? null
    }

    /** Resolve the template section of one notification kind.
     * @param {string} kind - Notification kind
     * @returns {Record<string, unknown>|null} Section node, or null when absent
     * @private */
    #sectionFor(kind) {
        const bundle = this.#loadBundle()
        if (!bundle || !kind) return null
        const section = bundle[kind]
        return (section && typeof section === 'object' && !Array.isArray(section)) ? section : null
    }

    /** Tokens every email template gets for free, independent of the caller.
     * @returns {Record<string, string>} Base token map
     * @private */
    #baseTokens() {
        const now = new Date()
        const name = String(ConfigService.get('ai.name') ?? '').trim()
        return {
            bot_name: name || DEFAULT_SENDER_NAME,
            hostname: String(os.hostname() || 'automaton'),
            date: temporal.getLocalDayString(now),
            time: temporal.formatClockTime(now),
        }
    }

    /** Render the subject line, prefix included.
     * @param {Record<string, unknown>|null} section - Kind's template section
     * @param {Record<string, string>} tokens - Token map
     * @param {string} kind - Notification kind, used by the fallback subject
     * @param {Record<string, *>} meta - Extra context merged into the tokens
     * @returns {string} Single-line subject
     * @private */
    #renderSubject(section, tokens, kind, meta) {
        const filled = this.#fill(section?.subject, { ...tokens, ...meta })
        const subject = filled || this.#kindWords(kind)
        return this.#clipSubject(this.#subjectPrefix ? `${this.#subjectPrefix}: ${subject}` : subject)
    }

    /** Assemble the plain-text body: greeting, the announcement, signature, footer.
     * @param {Record<string, unknown>|null} section - Kind's template section
     * @param {Record<string, string>} tokens - Token map
     * @param {string} message - Announcement body generated for speech
     * @returns {string} Complete message body
     * @private */
    #renderBody(section, tokens, message) {
        const parts = [
            this.#fill(section?.greeting, tokens),
            String(message ?? '').trim(),
            this.#fill(section?.signature, tokens),
            this.#fill(section?.footer, tokens),
        ]
        return parts.filter(Boolean).join('\n\n')
    }

    /** Body of a configuration-check mail.
     * @param {Record<string, unknown>|null} section - The 'test' template section
     * @param {Record<string, string>} tokens - Token map
     * @returns {string} Test body
     * @private */
    #testBody(section, tokens) {
        return this.#fill(section?.body, tokens)
            || 'This is a test of the automaton email channel. Receiving it means the SMTP relay, the sender address and the house_owners list are all configured correctly.'
    }

    /** Fill a template line and drop every placeholder the data cannot answer.
     *  A mail is read, not heard: a leftover "{% x %}" is a bug the owner should not
     *  have to look at, so unanswered placeholders are removed instead of passed through.
     * @param {*} template - Raw template line
     * @param {Record<string, string>} tokens - Token map
     * @returns {string} Filled line, '' when there is no template
     * @private */
    #fill(template, tokens) {
        if (typeof template !== 'string' || !template.trim()) return ''
        return interpolateTokens(template, tokens)
            .replace(TOKEN_INTERPOLATION_REGEX, '')
            .replace(/[ \t]{2,}/g, ' ')
            .trim()
    }

    /** Human-readable name of a notification kind, built from its key.
     * @param {string} kind - Notification kind
     * @returns {string} Subject words
     * @private */
    #kindWords(kind) {
        const words = String(kind ?? '').replace(/_/g, ' ').trim()
        return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Notification'
    }

    /** Redis key holding the last notification of one kind.
     * @param {string} kind - Notification kind
     * @returns {string} Key ("mail:cooldown:<kind>")
     * @private */
    #cooldownKey(kind) {
        return `${COOLDOWN_KEY_PREFIX}:${kind}`
    }

    /** Whether the last notification of this kind is still cooling down. The marker
     *  lives in Redis so the cooldown survives a restart; a Redis outage falls back to
     *  the in-memory timestamp and fails open when there is none.
     * @param {string} kind - Notification kind
     * @returns {Promise<boolean>} true when this notification must stay silent
     * @private
     * @async */
    async #cooldownActive(kind) {
        if (this.#cooldownMs <= 0) return false

        let markerAt = null
        try {
            const marker = await CacheService.get(this.#cooldownKey(kind))
            const at = Number(marker?.at)
            if (Number.isFinite(at)) markerAt = at
        } catch (_) {
            //  Redis unavailable -- the in-memory copy below is all there is.
        }

        const lastAt = markerAt ?? this.#cooldowns.get(kind) ?? null
        if (lastAt === null) return false

        const elapsedMs = Date.now() - lastAt
        if (elapsedMs < 0 || elapsedMs >= this.#cooldownMs) return false
        LoggerService.debug(
            `Email: "${kind}" cooling down -- ${Math.round(elapsedMs / 1000)}s of ${Math.round(this.#cooldownMs / 1000)}s`,
            'EmailService'
        )
        return true
    }

    /** Record that this kind was just notified: in-memory timestamp plus Redis marker.
     * @param {string} kind - Notification kind
     * @returns {Promise<void>}
     * @private
     * @async */
    async #markNotified(kind) {
        const at = Date.now()
        this.#cooldowns.set(kind, at)
        if (this.#cooldownMs <= 0) return
        try {
            await CacheService.set(this.#cooldownKey(kind), { at }, Math.max(1, Math.ceil(this.#cooldownMs / 1000)))
        } catch (_) {
            //  Redis unavailable -- the in-memory copy keeps this run quiet.
        }
    }
}

//  Module-level singleton -- ES module caching guarantees single instantiation.
const EmailServiceInstance = Object.freeze(new SEmailService())
export default EmailServiceInstance








