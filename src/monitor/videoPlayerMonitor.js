/**
 * Video Player Status Monitor.
 *
 * Singleton that polls a set of network video players (VLC, MPC-HC/BE, ...)
 * over their HTTP APIs and normalizes each into a small status vocabulary:
 * `playing`, `paused`, `stopped`, or `unreachable`.
 *
 * Design notes:
 *   - Presence-gated: a host is only polled when {@link NetworkPresence}
 *     reports it online. Offline hosts are recorded as `null` (unknown); an
 *     unknown status is treated as "not actively playing", so playback-dependent
 *     actions stay inert while safe/ambient actions still apply -- no flapping.
 *   - Endpoint IPs need no duplication: each player's address resolves from
 *     the same-named `computers` entry; an explicit `host` key overrides, and
 *     a player with neither is skipped with an error log.
 *   - One shared interval timer drives all hosts in parallel; a re-entrancy
 *     guard prevents overlapping sweeps.
 *   - A per-host failure-strike counter (3 strikes) avoids flapping a
 *     transiently failing host to `unreachable`.
 *   - Status is persisted to Redis (`videoPlayer:<host>:status`) and an
 *     EventBus event (`videoPlayer:<host>`) is published only on change.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from '../service/configService.js'
import LoggerService from '../service/loggerService.js'
import CacheService from '../service/cacheService.js'
import EventBus from '../service/eventBus.js'
import NetworkPresence from './networkPresence.js'

import VlcProvider from './providers/vlc.js'
import MpcProvider from './providers/mpc.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Interval between video-player sweeps in milliseconds (4 seconds).
 * @type {number}
 */
const CHECK_INTERVAL_MS = 4_000

/**
 * Consecutive fetch failures before an online host is declared `unreachable`.
 * @type {number}
 */
const FAILURE_STRIKES = 3

/**
 * Presence label (NetworkPresence.getPresence) meaning the host is known to
 * be offline. Known-offline hosts are not polled at all.
 * @type {string}
 */
const PRESENCE_OFFLINE = 'offline'

/**
 * Provider registry mapping a parser name to its provider class.
 * @type {Record<string, Function>}
 */
const PROVIDERS = {
    vlc: VlcProvider,
    mpc: MpcProvider
}

// ---------------------------------------------------------------------------
// SVideoPlayerMonitor (singleton)
// ---------------------------------------------------------------------------

/**
 * Monitors network video players and publishes normalized status transitions.
 */
class SVideoPlayerMonitor {

    instance

    /**
     * Parsed network configuration object.
     * @type {Object}
     */
    #config = {}

    /**
     * Video-player definitions keyed by host name.
     * @type {Record<string, {host: string, port: number, path: string, parser: string}>}
     */
    #videoPlayers = {}

    /**
     * Interval timer handle for periodic sweeps.
     * @type {NodeJS.Timer|null}
     */
    #timer = null

    /**
     * Re-entrancy guard so overlapping sweeps never run concurrently.
     * @type {boolean}
     */
    #checking = false

    /**
     * Per-host consecutive-failure strike counter.
     * @type {Map<string, number>}
     */
    #failCounts = new Map()

    /**
     * In-memory status cache (fallback when Redis is unavailable).
     * @type {Map<string, string|null>}
     */
    #statuses = new Map()

    // -- Singleton --------------------------------------------------------

    /**
     * Synchronous singleton constructor.
     * @return {this}
     */
    constructor() {
        if (!SVideoPlayerMonitor.instance) SVideoPlayerMonitor.instance = this
        return SVideoPlayerMonitor.instance
    }

    // -- Lifecycle --------------------------------------------------------

    /**
     * Initialize the video-player monitor.
     *
     * Reads the `videoPlayers` map from the network config section, resolving
     * each endpoint IP from the same-named `computers` entry unless an
     * explicit `host` key overrides it, and starts the periodic sweep. An
     * optional `configOverride` may be supplied (used by tests) to bypass the
     * live config section.
     *
     * @param {Object} [configOverride] - Optional network-config object override
     * @async
     */
    async init(configOverride) {
        const networkConfig = ConfigService.section('network')
        const config = configOverride ?? (networkConfig ? networkConfig.toJSON() : {})
        this.#config = config

        // Validate entries up front so a malformed definition warns once here
        // instead of producing garbage fetch URLs on every sweep.
        this.#videoPlayers = {}
        for (const [host, entry] of Object.entries(config.videoPlayers ?? {})) {
            const problem = this.#validatePlayerEntry(entry)
            if (problem) {
                LoggerService.warn(`Ignoring video player "${host}": ${problem}`, 'VideoPlayerMonitor')
                continue
            }

            // Resolve the endpoint IP: an explicit "host" wins (failsafe
            // override); otherwise the same-named "computers" entry is the
            // single source of truth. Unresolvable players are skipped loudly.
            const resolvedHost = entry.host ?? config.computers?.[host]
            if (typeof resolvedHost !== 'string' || resolvedHost.trim() === '') {
                LoggerService.error(
                    `Ignoring video player "${host}": no "host" key and no matching "computers" entry to resolve it from`,
                    'VideoPlayerMonitor'
                )
                continue
            }
            this.#videoPlayers[host] = { ...entry, host: resolvedHost }
        }

        const hosts = Object.keys(this.#videoPlayers)
        if (hosts.length === 0) {
            LoggerService.info('No video players configured (videoPlayers section empty or invalid)', 'VideoPlayerMonitor')
            return
        }

        // Hosts not listed under any pingable network.yaml category never get a
        // presence state -- they are polled directly instead of waiting on a
        // gate that could never pass.
        const pingable = new Set(NetworkPresence.getNetworkDevices().map((d) => d.name))
        for (const host of hosts) {
            if (!pingable.has(host)) {
                LoggerService.info(
                    `Video player "${host}" is not listed in any network.yaml ping category; polling it directly without presence pre-gating`,
                    'VideoPlayerMonitor'
                )
            }
        }

        this.#timer = setInterval(() => {
            void this.#checkAll()
        }, CHECK_INTERVAL_MS)

        // Kick off an immediate first sweep so status is available without
        // waiting a full interval.
        void this.#checkAll()

        LoggerService.info(
            `Video player monitor started (${hosts.length} player(s): ${hosts.join(', ')})`,
            'VideoPlayerMonitor'
        )
    }

    /**
     * Stop the periodic sweep.
     */
    stop() {
        if (this.#timer) {
            clearInterval(this.#timer)
            this.#timer = null
            LoggerService.info('Video player monitor stopped', 'VideoPlayerMonitor')
        }
    }

    // -- Public API -------------------------------------------------------

    /**
     * Trigger an immediate sweep of all configured video players.
     * Safe to call concurrently (guarded by the re-entrancy flag).
     * @returns {Promise<void>}
     */
    async checkNow() {
        await this.#checkAll()
    }

    /**
     * Get the current normalized status for a host.
     * Reads Redis first (fresh), falling back to the in-memory cache.
     *
     * @param {string} host - Host name as configured in network.yaml
     * @returns {Promise<string|null>} `playing`/`paused`/`stopped`/`unreachable`, or null when unknown
     */
    async getStatus(host) {
        // In-memory map first: while running, this process is the only writer,
        // so it is always fresher than Redis. Redis serves purely as a fallback
        // for values recorded before this process knew anything (e.g. right
        // after a restart, before the first sweep completes). This ordering
        // also avoids a Redis round-trip (and its disconnected-warn spam) on
        // every rule evaluation.
        if (this.#statuses.has(host)) {
            return this.#statuses.get(host) ?? null
        }
        const value = await CacheService.get(`videoPlayer:${host}:status`)
        return value !== undefined ? value : null
    }

    /**
     * The configured video-player definitions keyed by host name.
     * @returns {Record<string, {host: string, port: number, path: string, parser: string}>}
     */
    getVideoPlayers() {
        return this.#videoPlayers
    }

    /**
     * List of configured host names.
     * @returns {string[]}
     */
    getHostNames() {
        return Object.keys(this.#videoPlayers)
    }

    /**
     * Directly seed a host's status for testing.
     *
     * Writes the value to the in-memory cache and, when a Redis broker is
     * reachable, to the `videoPlayer:<host>:status` key as well. This lets
     * tests drive {@link getStatus} deterministically without a live player
     * or a running sweep. Unlike {@link #setStatus} it does not publish an
     * EventBus event and does not consult the previous value.
     *
     * @param {string} host - Host name
     * @param {string|null} status - Normalized status (or null for unknown)
     * @returns {Promise<void>}
     */
    async setTestStatus(host, status) {
        this.#statuses.set(host, status)
        await CacheService.set(`videoPlayer:${host}:status`, status)
    }

    // -- Private helpers --------------------------------------------------

    /**
     * Sweep every configured host in parallel. A re-entrancy guard ensures at
     * most one sweep runs at a time.
     * @private
     */
    async #checkAll() {
        if (this.#checking) return
        this.#checking = true
        try {
            const checks = Object.entries(this.#videoPlayers).map(
                ([host, cfg]) => this.#checkOne(host, cfg)
            )
            await Promise.allSettled(checks)
        } finally {
            this.#checking = false
        }
    }

    /**
     * Check a single host: presence gate, fetch, parse, and status update.
     * @private
     * @param {string} host - Host name
     * @param {{host: string, port: number, path: string, parser: string}} cfg - Endpoint config
     */
    async #checkOne(host, cfg) {
        // Presence gate: skip polling only when the host is *known* offline --
        // an offline machine cannot answer anyway. Unknown presence (host not
        // listed in any ping category, or no state cached yet) still polls:
        // the HTTP fetch plus the strike counter is its own reachability test.
        const presence = await NetworkPresence.getPresence(host)
        if (presence === PRESENCE_OFFLINE) {
            await this.#setStatus(host, null)
            return
        }

        const provider = this.#getProvider(cfg)
        if (!provider) {
            LoggerService.warn(`Unknown parser "${cfg.parser}" for video player "${host}"`, 'VideoPlayerMonitor')
            return
        }

        try {
            const body = await provider.fetch(cfg)
            const status = provider.parse(body)
            this.#failCounts.set(host, 0)
            await this.#setStatus(host, status)
        } catch (error) {
            const strikes = (this.#failCounts.get(host) ?? 0) + 1
            this.#failCounts.set(host, strikes)
            if (strikes >= FAILURE_STRIKES) {
                await this.#setStatus(host, 'unreachable')
            } else {
                // Keep the previous status to avoid flapping on transient failures.
                LoggerService.debug(
                    `${host}: status fetch failed (${strikes}/${FAILURE_STRIKES}): ${error.message}`,
                    'VideoPlayerMonitor'
                )
            }
        }
    }

    /**
     * Validate one videoPlayers entry from network.yaml.
     * @private
     * @param {*} entry - Raw entry value
     * @returns {string|null} Problem description, or null when valid
     */
    #validatePlayerEntry(entry) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return 'entry must be an object with port/path/parser keys'
        }
        if (entry.host != null && (typeof entry.host !== 'string' || entry.host.trim() === '')) {
            return '"host" is optional but, when present, must be a non-empty string'
        }
        if (!Number.isFinite(entry.port) || entry.port <= 0 || entry.port > 65535) {
            return '"port" must be a number between 1 and 65535'
        }
        if (typeof entry.path !== 'string' || !entry.path.startsWith('/')) {
            return '"path" must be a string starting with "/"'
        }
        if (!PROVIDERS[entry.parser]) {
            return `"parser" must be one of: ${Object.keys(PROVIDERS).join(', ')}`
        }
        return null
    }

    /**
     * Instantiate the provider for a host's parser name.
     * @private
     * @param {{parser: string}} cfg - Endpoint config
     * @returns {Object|null} Provider instance, or null for an unknown parser
     */
    #getProvider(cfg) {
        const ProviderClass = PROVIDERS[cfg?.parser]
        return ProviderClass ? new ProviderClass() : null
    }

    /**
     * Record a new status for a host, persist it to Redis, and publish an
     * EventBus event when it changed.
     * @private
     * @param {string} host - Host name
     * @param {string|null} status - New normalized status
     */
    async #setStatus(host, status) {
        const prev = this.#statuses.get(host)
        if (prev === status) return
        this.#statuses.set(host, status)

        await CacheService.set(`videoPlayer:${host}:status`, status)

        LoggerService.info(
            `Video player ${host}: ${prev ?? 'unknown'} -> ${status}`,
            'VideoPlayerMonitor'
        )
        EventBus.publish(`videoPlayer:${host}`)
    }
}

// ---------------------------------------------------------------------------
// Export frozen singleton
// ---------------------------------------------------------------------------

/**
 * Frozen singleton instance of the video-player monitor.
 */
const VideoPlayerMonitor = new SVideoPlayerMonitor()
Object.freeze(VideoPlayerMonitor)
export default VideoPlayerMonitor