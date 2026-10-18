/**
 * Shared HTTP GET helper for network-API providers.
 * Performs a single GET request with a short timeout (via AbortController)
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import temporal from '../../lib/date.js'

/** Default per-request timeout in milliseconds. Players are LAN-local and should
 * answer well under this; a stalled web thread (e.g. MPC-HC blocking for ~1 s while
 * seeking or skipping) must not be misread as an offline player. Per-player overrides
 * are accepted via the optional `timeout` key in etc/device/network.yaml.
 * @type {number} */
const DEFAULT_TIMEOUT_MS = 1200

/** Resolve a configured player timeout to milliseconds, accepting the former key for direct callers.
 * @param {object} config - Player endpoint configuration.
 * @returns {number} Positive timeout in milliseconds. */
export function playerTimeout(config) {
    const raw = config.timeout !== undefined ? config.timeout : config.timeout_ms
    const ms = temporal.parseDurationMs(raw)
    return ms !== null && ms > 0 ? ms : DEFAULT_TIMEOUT_MS
}

/** Perform an HTTP GET request with a timeout and optional basic auth.
 * @param {string} url - Absolute URL to request (e.g., http://host:port/path)
 * @param {Object} [options={}] - Request options
 * @param {number} [options.timeoutMs=1200] - Abort timeout in milliseconds
 * @param {string} [options.username] - Optional basic-auth username
 * @param {string} [options.password] - Optional basic-auth password
 * @returns {Promise<string>} Response body as text
 * @throws {Error} On timeout, non-OK HTTP status, or network failure */
export async function httpGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS, username, password } = {}) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

    //  VLC's HTTP interface (among others) answers 401 without credentials.
    const headers = {}
    if (username !== undefined || password !== undefined) {
        headers.Authorization = 'Basic ' + Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64')
    }

    try {
        const res = await fetch(url, { signal: controller.signal, headers })
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`)
        }
        return await res.text()
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Fetch timed out after ${timeoutMs}ms: ${url}`)
        }
        throw error
    } finally {
        clearTimeout(timeoutHandle)
    }
}