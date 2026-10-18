/**
 * VLC HTTP API provider (status.json).
 * Owns the fetch + parse for a VLC instance with its HTTP interface enabled.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { httpGet, playerTimeout } from './http.js'

/** Provider for the VLC HTTP API. */
export default class VlcProvider {

    /** Fetch the raw status document from a VLC instance.
     * @param {Object} config - Player endpoint config
     * @param {string} config.host - Host name or IP address
     * @param {number} config.port - HTTP port of the web interface
     * @param {string} config.path - Path to the status document
     * @param {string} [config.username] - Optional basic-auth username
     * @param {string} [config.password] - Optional basic-auth password
     * @param {number|string} [config.timeout] - Per-player HTTP timeout override
     * @returns {Promise<string>} Raw response body */
    async fetch(config) {
        const url = `http://${config.host}:${config.port}${config.path}`
        return await httpGet(url, {
            username: config.username,
            password: config.password,
            timeoutMs: playerTimeout(config)
        })
    }

    /** Parse a raw VLC status document into a normalized status.
     * @param {string} body - Raw response body (JSON status document)
     * @returns {'playing'|'paused'|'stopped'} Normalized status
     * @throws {Error} When the body is not valid JSON (feeds the monitor's */
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

    /** Best-effort extraction of the current media identifier from a VLC status document.
     * @param {string} body - Raw response body (JSON status document)
     * @returns {string|null} Media identifier, or null when not determinable */
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
        //  Some builds nest metadata under an object with title/artist/album fields.
        const meta = data.meta ?? data.current_item_meta
        if (meta && typeof meta === 'object') {
            for (const key of ['title', 'artist', 'album']) {
                if (typeof meta[key] === 'string' && meta[key].trim() !== '') return meta[key].trim()
            }
        }
        return null
    }
}