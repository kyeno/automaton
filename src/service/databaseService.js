/**
 * Durable state-transition history service backed by local SQLite.
 *
 * Single source of truth for timestamped state transitions of monitored entities
 * (video players, network presence, and any future monitor). Backed by Node's
 * built-in `node:sqlite` -- no external dependencies -- so history is available
 * offline and survives restarts without a running Redis broker.
 *
 * Design notes:
 *   - Event-sourced / append-only: every genuine transition is recorded as a row
 *     with an epoch-millisecond timestamp; current state is simply the latest row
 *     per (domain, subject), which keeps fast indexed reads while preserving full
 *     history needed for recency conditions ("last change was > N minutes ago").
 *   - Deduped on write: recordTransition() only inserts when the value differs from
 *     the stored one, so repeated identical polls never bloat the table or re-fire
 *     events after a restart that resumes in the same state.
 *   - Fail-open: if the database cannot be opened (read-only filesystem, lock, ...)
 *     the service reports itself unavailable and all accessors degrade gracefully
 *     instead of throwing, so monitors keep working exactly as before.
 *   - States are normalized to short string labels ('online', 'offline', 'playing',
 *     ..., 'unknown'); JS null/undefined maps to 'unknown'. Consumers map back to
 *     their own contracts (e.g., presence 1/0) at their boundary.
 *
 * Storage defaults to <project root>/var/db/automaton.db and can be overridden with the
 * DB_PATH environment variable (or by passing a path to init()). Retention prunes rows
 * older than STATE_DB_RETENTION_DAYS (default 90) at startup.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

import LoggerService from './loggerService.js'
import PROJECT_ROOT from '../lib/projectRoot.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default database file location relative to the project root. */
const DEFAULT_DB_FILE = path.join('var', 'db', 'automaton.db')

/** Label used for an absent/null state value. */
const UNKNOWN_LABEL = 'unknown'

/** Default retention window in days before history rows are pruned at startup. */
const DEFAULT_RETENTION_DAYS = 90

// ---------------------------------------------------------------------------
// SDatabaseService (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * Local SQLite-backed store of timestamped state transitions.
 * ES module caching guarantees a single instance; private fields stay mutable
 * even though the exported object is frozen.
 */
class SDatabaseService {

    /** Open SQLite handle, or null when unavailable. @type {object|null} */
    #db = null

    /** Whether init() succeeded and accessors may be used. @type {boolean} */
    #ready = false

    /** Warn-once flag so a downed store does not spam on every call. @type {boolean} */
    #warnedUnavailable = false

    // -- Lifecycle --------------------------------------------------------

    /**
     * Open (or create) the SQLite database, enable WAL + busy timeout, ensure the
     * schema exists, and apply retention pruning. Never throws: on failure it logs
     * an error and leaves the service marked unavailable so callers fail open.
     * Safe to call more than once; subsequent calls re-open idempotently.
     *
     * @param {string} [dbPath] - Explicit database path (e.g., ':memory:' for tests).
     *   Defaults to $DB_PATH or <project root>/var/db/automaton.db.
     * @returns {Promise<boolean>} true when the store is ready, false otherwise.
     */
    async init(dbPath) {
        const resolved = dbPath ?? process.env.DB_PATH ?? path.join(PROJECT_ROOT, DEFAULT_DB_FILE)

        try {
            if (resolved !== ':memory:') {
                fs.mkdirSync(path.dirname(resolved), { recursive: true })
            }

            this.#closeHandle()
            this.#db = new DatabaseSync(resolved)
            this.#db.prepare('PRAGMA journal_mode = WAL').get()
            this.#db.prepare('PRAGMA busy_timeout = 5000').get()
            this.#createSchema()
            this.#applyRetention()

            this.#ready = true
            this.#warnedUnavailable = false
            this.#log('info', `State history store ready at ${resolved}`)
            return true
        } catch (error) {
            this.#ready = false
            this.#db = null
            this.#log('error', `Unable to open state history store "${resolved}": ${error.message} -- failing open`)
            return false
        }
    }

    /**
     * Close the database handle and mark the service unavailable. Safe when already closed.
     * @returns {Promise<void>}
     */
    async close() {
        const had = this.#ready || this.#db != null
        this.#closeHandle()
        if (had) this.#log('debug', 'State history store closed')
    }

    // -- Availability -----------------------------------------------------

    /**
     * Whether the store is currently usable. Callers use this to fail open/closed explicitly.
     * @returns {boolean} true when a live connection exists.
     */
    isAvailable() {
        return this.#ready && this.#db != null
    }

    // -- Write ------------------------------------------------------------

    /**
     * Record a state transition, inserting a row only when it differs from the stored value.
     * This single method centralizes change-detection so monitors do not each re-implement it.
     *
     * @param {{domain: string, subject: string, toState: string|null, source?: string}} entry - Transition details;
     *   `toState` may be null/undefined (recorded as 'unknown').
     * @returns {Promise<{changed: boolean, ts: number|null}>} changed=true and ts set when a new row was written.
     */
    async recordTransition({ domain, subject, toState, source = 'poll' }) {
        if (!this.isAvailable()) {
            this.#warnUnavailableOnce()
            return { changed: false, ts: null }
        }

        const label = normalizeLabel(toState)
        try {
            const current = this.#rawCurrent(domain, subject)
            if (current === label) {
                return { changed: false, ts: null }
            }

            const ts = Date.now()
            this.#db.prepare(
                'INSERT INTO state_events (ts_ms, domain, subject, from_state, to_state, source) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(ts, String(domain), String(subject), current ?? null, label, String(source))

            return { changed: true, ts }
        } catch (error) {
            this.#log('error', `Failed to record transition ${domain}:${subject}: ${error.message}`)
            return { changed: false, ts: null }
        }
    }

    // -- Read -------------------------------------------------------------

    /**
     * Current stored label for a subject, or null when absent/unavailable.
     * @param {string} domain - e.g., 'videoPlayer' | 'network'.
     * @param {string} subject - host name / device name.
     * @returns {Promise<string|null>} Stored label ('online', 'playing', ..., 'unknown'), or null.
     */
    async getCurrent(domain, subject) {
        if (!this.isAvailable()) return null
        try {
            return this.#rawCurrent(domain, subject) ?? null
        } catch {
            return null
        }
    }

    /**
     * Epoch-millisecond timestamp of the most recent recorded transition for a subject,
     * or null when none exists or the store is unavailable. Powers recency conditions.
     * @param {string} domain - Domain identifier.
     * @param {string} subject - Subject identifier.
     * @returns {Promise<number|null>} Timestamp (ms since epoch), or null.
     */
    async lastTransitionTs(domain, subject) {
        if (!this.isAvailable()) return null
        try {
            const row = this.#db.prepare(
                'SELECT ts_ms FROM state_events WHERE domain = ? AND subject = ? ORDER BY id DESC LIMIT 1'
            ).get(String(domain), String(subject))
            return row ? Number(row.ts_ms) : null
        } catch {
            return null
        }
    }

    /**
     * How long (ms) the subject sat in its state immediately preceding the current one --
     * i.e., the interval between this subject's two most recent transitions. Because
     * recordTransition() only inserts when the value changes, consecutive rows always
     * differ, so the second-newest row is by definition the previous state. The duration
     * is measured up to the newest transition's timestamp (not wall-clock "now"), which
     * keeps it stable for callers evaluating shortly after the event. Returns null when
     * fewer than two transitions are recorded or the store is unavailable. Powers
     * absence/presence windowing (e.g., the greeter's reboot vs welcome-back decision).
     * @param {string} domain - Domain identifier.
     * @param {string} subject - Subject identifier.
     * @returns {Promise<number|null>} Duration in milliseconds, or null.
     */
    async priorStateDurationMs(domain, subject) {
        if (!this.isAvailable()) return null
        try {
            const rows = this.#db.prepare(
                'SELECT ts_ms FROM state_events WHERE domain = ? AND subject = ? ORDER BY id DESC LIMIT 2'
            ).all(String(domain), String(subject))
            if (rows.length < 2) return null
            const duration = Number(rows[0].ts_ms) - Number(rows[1].ts_ms)
            return Number.isFinite(duration) && duration >= 0 ? duration : null
        } catch {
            return null
        }
    }

    /**
     * Recent transitions (newest first), optionally filtered by domain and/or subject.
     * Intended for debugging, UI history views, and AI tools.
     * @param {{domain?: string, subject?: string, limit?: number}} [filter] - Optional filters.
     * @returns {Promise<Array<{ts: number, domain: string, subject: string, fromState: string|null, toState: string, source: string}>>}
     */
    async getTransitions({ domain, subject, limit = 50 } = {}) {
        if (!this.isAvailable()) return []
        try {
            const clauses = []
            const params = []
            if (domain != null) { clauses.push('domain = ?'); params.push(String(domain)) }
            if (subject != null) { clauses.push('subject = ?'); params.push(String(subject)) }
            const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
            const rows = this.#db.prepare(
                `SELECT ts_ms AS ts, domain, subject, from_state AS fromState, to_state AS toState, source FROM state_events${where} ORDER BY id DESC LIMIT ?`
            ).all(...params, Math.max(1, Number(limit)))
            return rows.map((r) => ({ ...r, ts: Number(r.ts), fromState: r.fromState ?? null }))
        } catch {
            return []
        }
    }

    // -- Internal ---------------------------------------------------------

    /**
     * Read the latest stored label for a subject without availability guards.
     * @private
     * @param {string} domain - State-change domain
     * @param {string} subject - Subject identifier within the domain
     * @returns {string|undefined} Latest stored label, or undefined when absent
     */
    #rawCurrent(domain, subject) {
        const row = this.#db.prepare(
            'SELECT to_state FROM state_events WHERE domain = ? AND subject = ? ORDER BY id DESC LIMIT 1'
        ).get(String(domain), String(subject))
        return row?.to_state ?? undefined
    }

    /** Create tables + index if missing. @private */
    #createSchema() {
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS state_events (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_ms      INTEGER NOT NULL,
                domain     TEXT    NOT NULL,
                subject    TEXT    NOT NULL,
                from_state TEXT,
                to_state   TEXT    NOT NULL,
                source     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_state_lookup ON state_events (domain, subject, id);
        `)
    }

    /** Prune rows older than the configured retention window. @private */
    #applyRetention() {
        const days = Number(process.env.STATE_DB_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)
        if (!Number.isFinite(days) || days <= 0) return
        const cutoffMs = Date.now() - days * 86_400_000
        try {
            const result = this.#db.prepare('DELETE FROM state_events WHERE ts_ms < ?').run(cutoffMs)
            if (result.changes > 0) {
                this.#log('debug', `Pruned ${result.changes} history row(s) older than ${days} day(s)`)
            }
        } catch (error) {
            this.#log('warn', `History retention prune skipped: ${error.message}`)
        }
    }

    /** Close the underlying handle without touching readiness flags. @private */
    #closeHandle() {
        if (this.#db != null) {
            try { this.#db.close() } catch { /* already closed */ }
            this.#db = null
        }
    }

    /** Log a single warning when accessors are hit while unavailable. @private */
    #warnUnavailableOnce() {
        if (this.#warnedUnavailable) return
        this.#warnedUnavailable = true
        this.#log('warn', 'State history store is not available -- transitions will not be persisted')
    }

    /**
     * Route logs through LoggerService with a console fallback so logging never throws.
     * @private
     * @param {'info'|'warn'|'error'|'debug'} level - Log level
     * @param {string} message - Message body
     */
    #log(level, message) {
        const fn = typeof LoggerService !== 'undefined' ? LoggerService?.[level] : undefined
        if (typeof fn === 'function') {
            try { fn.call(LoggerService, message, 'DatabaseService'); return } catch { /* fall back below */ }
        }
        const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
        out(`[DatabaseService] ${message}`)
    }
}

/** Normalize an arbitrary state value to its stored label ('unknown' for null/undefined). @param {*} value @returns {string} */
function normalizeLabel(value) {
    return value == null ? UNKNOWN_LABEL : String(value)
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const DatabaseService = Object.freeze(new SDatabaseService())
export default DatabaseService
