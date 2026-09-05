/**
 * MPC-HC web interface provider (variables.html).
 *
 * Owns the fetch + parse for an MPC-HC instance with its built-in web
 * interface enabled. The fetch issues a GET against the configured
 * host/port/path; the parse extracts the `<p id="statestring">` paragraph
 * and maps it to a normalized status.
 *
 * Enabling the web interface in MPC-HC:
 *   1. Open a movie with MPC-HC.
 *   2. View -> Options -> Player -> Web Interface.
 *   3. Enable "Listen on port" and disable "Allow access from localhost only".
 * The compression setting does not matter: the shared httpGet() helper uses
 * Node's fetch (undici), which decompresses gzip/deflate/br transparently.
 *
 * Version lock: parsing was verified against MPC-HC 1.9.16.63 (52425f077)
 * and is expected to hold across the 1.9.x series. The page reports its own
 * version as `<p id="version">`; builds outside the supported range log a
 * warning once and keep parsing. If a future version restructures the page,
 * the statestring lookup fails, parse() throws, and the monitor's strike
 * counter eventually declares the host unreachable -- a fail-safe outcome.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import LoggerService from '../../service/loggerService.js'
import { httpGet } from './http.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Supported MPC-HC major.minor range -- the parsing contract is only
 * guaranteed here. Anything else warns once and parses anyway.
 * @type {{major: number, minor: number}}
 */
const SUPPORTED_VERSION_RANGE = { major: 1, minor: 9 }

/**
 * Exact build the parser was verified against (for log messages).
 * @type {string}
 */
const TESTED_VERSION = '1.9.16.63 (52425f077)'

/**
 * Version strings already warned about. The monitor re-instantiates providers
 * on every sweep, so this guard must outlive individual instances.
 * @type {Set<string>}
 */
const warnedVersions = new Set()

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provider for the MPC-HC web interface (variables.html).
 */
export default class MpcProvider {

    /**
     * Fetch the raw variables page from an MPC-HC instance.
     *
     * @param {Object} config - Player endpoint config
     * @param {string} config.host - Host name or IP address
     * @param {number} config.port - HTTP port of the web interface
     * @param {string} config.path - Path to the variables page
     * @param {string} [config.username] - Optional basic-auth username
     * @param {string} [config.password] - Optional basic-auth password
     * @param {number} [config.timeout_ms] - Per-player HTTP timeout override
     * @returns {Promise<string>} Raw response body
     */
    async fetch(config) {
        const url = `http://${config.host}:${config.port}${config.path}`
        return await httpGet(url, {
            username: config.username,
            password: config.password,
            timeoutMs: config.timeout_ms
        })
    }

    /**
     * Parse a raw MPC-HC variables page into a normalized status.
     *
     * Reads the `<p id="statestring">` paragraph (case-insensitive). Anything
     * other than Playing/Paused -- including Stopped and the empty page shown
     * when no media is loaded -- maps to `stopped`, the safe non-playing side.
     *
     * @param {string} body - Raw response body
     * @returns {'playing'|'paused'|'stopped'} Normalized status
     * @throws {Error} When the page has no statestring paragraph (feeds the
     *   monitor's strike counter, eventually marking the host unreachable)
     */
    parse(body) {
        this.#warnUnsupportedVersion(this.#extractParagraph(body, 'version'))

        const raw = this.#extractParagraph(body, 'statestring')
        if (raw === null) {
            throw new Error('MPC response has no "statestring" paragraph')
        }

        const status = raw.toLowerCase()
        if (status === 'playing' || status === 'paused') return status
        return 'stopped'
    }

    // -- Private helpers --------------------------------------------------

    /**
     * Extract the trimmed text content of a `<p id="...">` paragraph.
     *
     * @private
     * @param {string} html - Raw HTML page
     * @param {string} id - Paragraph id to look up
     * @returns {string|null} Text content, or null when the paragraph is absent
     */
    #extractParagraph(html, id) {
        const match = html.match(new RegExp(`<p[^>]*id="${id}"[^>]*>([\\s\\S]*?)</p>`, 'i'))
        if (!match) return null
        return match[1].replace(/<[^>]*>/g, '').trim()
    }

    /**
     * Warn once per major.minor when the player version is outside the supported
     * range (or cannot be determined from the page).
     *
     * The warned-versions guard lives at module level because the monitor
     * re-instantiates providers on every sweep -- it must outlive instances.
     *
     * @private
     * @param {string|null} version - Raw version string from the page
     * @returns {void}
     */
    #warnUnsupportedVersion(version) {
        const match = typeof version === 'string' ? version.match(/^(\d+)\.(\d+)/) : null
        if (
            match &&
            Number(match[1]) === SUPPORTED_VERSION_RANGE.major &&
            Number(match[2]) === SUPPORTED_VERSION_RANGE.minor
        ) {
            return
        }

        const key = match ? `${match[1]}.${match[2]}` : 'unknown'
        if (warnedVersions.has(key)) return
        warnedVersions.add(key)
        LoggerService.warn(
            `MPC-HC ${version ?? '(version unknown)'} is outside the supported ` +
            `${SUPPORTED_VERSION_RANGE.major}.${SUPPORTED_VERSION_RANGE.minor}.x range ` +
            `(verified against ${TESTED_VERSION}); parsing continues but is unverified`,
            'MpcProvider'
        )
    }
}