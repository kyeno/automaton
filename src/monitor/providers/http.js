/**
 * Shared HTTP GET helper for network-API providers.
 *
 * Performs a single GET request with a short timeout (via AbortController) and
 * returns the response body as text. Non-OK status codes and timeouts are
 * surfaced as thrown Errors so callers can apply their own failure policy
 * (e.g., a strike counter before declaring a host unreachable).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/**
 * Default per-request timeout in milliseconds. Players are LAN-local and
 * answer in single-digit milliseconds -- a dead endpoint should be detected
 * fast so the monitor's strike counter flips it to `unreachable` quickly.
 * @type {number}
 */
const DEFAULT_TIMEOUT_MS = 500

/**
 * Perform an HTTP GET request with a timeout and optional basic auth.
 *
 * @param {string} url - Absolute URL to request (e.g., http://host:port/path)
 * @param {Object} [options={}] - Request options
 * @param {number} [options.timeoutMs=500] - Abort timeout in milliseconds
 * @param {string} [options.username] - Optional basic-auth username
 * @param {string} [options.password] - Optional basic-auth password
 * @returns {Promise<string>} Response body as text
 * @throws {Error} On timeout, non-OK HTTP status, or network failure
 */
export async function httpGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS, username, password } = {}) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

    // VLC's HTTP interface (among others) answers 401 without credentials.
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