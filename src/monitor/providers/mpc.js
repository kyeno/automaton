/**
 * MPC-HC web interface provider (variables.html).
 * Owns the fetch + parse for an MPC-HC instance with its built-in web.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import LoggerService from '../../service/loggerService.js'
import { httpGet } from './http.js'


/** Supported MPC-HC major.minor range -- the parsing contract is only
 * @type {{major: number, minor: number}} */
const SUPPORTED_VERSION_RANGE = { major: 1, minor: 9 }

/** Exact build the parser was verified against (for log messages).
 * @type {string} */
const TESTED_VERSION = '1.9.16.63 (52425f077)'

/** Version strings already warned about. The monitor re-instantiates providers
 * @type {Set<string>} */
const warnedVersions = new Set()


/** Provider for the MPC-HC web interface (variables.html). */
export default class MpcProvider {

    /** Fetch the raw variables page from an MPC-HC instance.
     * @param {Object} config - Player endpoint config
     * @param {string} config.host - Host name or IP address
     * @param {number} config.port - HTTP port of the web interface
     * @param {string} config.path - Path to the variables page
     * @param {string} [config.username] - Optional basic-auth username
     * @param {string} [config.password] - Optional basic-auth password
     * @param {number} [config.timeout_ms] - Per-player HTTP timeout override
     * @returns {Promise<string>} Raw response body */
    async fetch(config) {
        const url = `http://${config.host}:${config.port}${config.path}`
        return await httpGet(url, {
            username: config.username,
            password: config.password,
            timeoutMs: config.timeout_ms
        })
    }

    /** Parse a raw MPC-HC variables page into a normalized status.
     * @param {string} body - Raw response body
     * @returns {'playing'|'paused'|'stopped'} Normalized status
     * @throws {Error} When the page has no statestring paragraph (feeds the */
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

    /** Extract the current media title from a variables page for identity tracking.
     * @param {string} body - Raw response body
     * @returns {string|null} Media title/identifier, or null when not determinable */
    extractTitle(body) {
        const file = this.#extractParagraph(body, 'file')
        if (file) return file
        const title = this.#extractParagraph(body, 'title')
        return title || null
    }

    //  -- Private helpers --------------------------------------------------

    /** Extract the trimmed text content of a `<p id="...">` paragraph.
     * @private
     * @param {string} html - Raw HTML page
     * @param {string} id - Paragraph id to look up
     * @returns {string|null} Text content, or null when the paragraph is absent */
    #extractParagraph(html, id) {
        const match = html.match(new RegExp(`<p[^>]*id="${id}"[^>]*>([\\s\\S]*?)</p>`, 'i'))
        if (!match) return null
        return match[1].replace(/<[^>]*>/g, '').trim()
    }

    /** Warn once per major.minor when the player version is outside the supported.
     * @private
     * @param {string|null} version - Raw version string from the page
     * @returns {void} */
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