/**
 * VLC HTTP API provider (status.json).
 *
 * Owns the fetch + parse for a VLC instance with its HTTP interface enabled.
 * The fetch issues a GET against the configured host/port/path; the parse
 * maps VLC's JSON status document (`{"state": "playing" | "paused" |
 * "stopped"}`, see https://wiki.videolan.org/VLC_HTTP_API) to a normalized
 * status. Anything other than playing/paused maps to `stopped`.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { httpGet } from './http.js'

/**
 * Provider for the VLC HTTP API.
 */
export default class VlcProvider {

    /**
     * Fetch the raw status document from a VLC instance.
     *
     * @param {Object} config - Player endpoint config
     * @param {string} config.host - Host name or IP address
     * @param {number} config.port - HTTP port of the web interface
     * @param {string} config.path - Path to the status document
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
     * Parse a raw VLC status document into a normalized status.
     *
     * @param {string} body - Raw response body (JSON status document)
     * @returns {'playing'|'paused'|'stopped'} Normalized status
     * @throws {Error} When the body is not valid JSON (feeds the monitor's
     *   strike counter, eventually marking the host unreachable)
     */
    parse(body) {
        let data
        try {
            data = JSON.parse(body)
        } catch (error) {
            throw new Error(`VLC status response is not valid JSON: ${error.message}`)
        }

        const state = typeof data?.state === 'string' ? data.state.trim().toLowerCase() : ''
        if (state === 'playing' || state === 'paused') return state
        return 'stopped'
    }

    /**
     * Best-effort extraction of the current media identifier from a VLC status document.
     *
     * VLC's HTTP interface does not expose one stable "title" field across versions, so this
     * probes common candidates and returns the first non-empty value. When none is present it
     * returns null -- the monitor still applies its dwell timer; it simply cannot detect a movie
     * change by name for that player (a documented graceful degradation).
     *
     * @param {string} body - Raw response body (JSON status document)
     * @returns {string|null} Media identifier, or null when not determinable
     */
    extractTitle(body) {
        let data
        try {
            data = JSON.parse(body)
        } catch {
            return null
        }
        if (!data || typeof data !== 'object') return null
        for (const key of ['input_name', 'name', 'current_item', 'filename']) {
            const value = data[key]
            if (typeof value === 'string' && value.trim() !== '') return value.trim()
        }
        // Some builds nest metadata under an object with title/artist/album fields.
        const meta = data.meta ?? data.current_item_meta
        if (meta && typeof meta === 'object') {
            for (const key of ['title', 'artist', 'album']) {
                if (typeof meta[key] === 'string' && meta[key].trim() !== '') return meta[key].trim()
            }
        }
        return null
    }
}