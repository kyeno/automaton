/**
 * Cache service backed by Redis.
 *
 * Provides JSON-serialized get/set accessors with configurable TTL and
 * automatic reconnection via exponential backoff (1 s -> 30 s cap).
 * All lifecycle events (connect, ready, reconnecting, error, end) are logged.
 *
 * Security note: `REDIS_URL` may contain credentials -- do not log the raw URL.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { createClient } from 'redis'
import LoggerService from './loggerService.js'
import StateService from './stateService.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default TTL for cached entries in seconds (3 hours).
 * @type {number}
 */
const DEFAULT_TTL_SECONDS = 10_800

/**
 * Base delay for Redis exponential backoff in milliseconds.
 * @type {number}
 */
const REDIS_RECONNECT_BASE_DELAY_MS = 1_000

/**
 * Upper bound for Redis reconnect backoff in milliseconds.
 * @type {number}
 */
const REDIS_RECONNECT_MAX_DELAY_MS = 30_000

// ---------------------------------------------------------------------------
// CacheService (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * Redis connection wrapper with automatic reconnection.
 *
 * Provides typed get/set accessors backed by JSON serialization,
 * exponential-backoff reconnection strategy, and lifecycle callbacks.
 * ES module caching guarantees single instantiation; no inner constructor check needed.
 *
 * @see {@link https://www.npmjs.com/package/redis}
 */
class SCacheService {

    #redis

    // -- Lifecycle --------------------------------------------------------

    /**
     * Create the Redis client, attach lifecycle listeners, and connect.
     *
     * @async
     */
    async init() {
        this.#redis = createClient({
            url: process.env.REDIS_URL,
            socket: {
                reconnectStrategy: this.#onRedisReconnectAttempt.bind(this)
            }
        })

        this.#redis.on('error', this.#onRedisError.bind(this))
        this.#redis.on('ready', this.#onRedisReady.bind(this))
        this.#redis.on('reconnecting', this.#onRedisReconnecting.bind(this))
        this.#redis.on('connect', this.#onRedisConnect.bind(this))
        this.#redis.on('end', this.#onRedisEnd.bind(this))

        try {
            LoggerService.info('Connecting to Redis...', 'CacheService')
            await this.#redis.connect()
        } catch (e) {
            LoggerService.error(`Unable to connect to Redis: ${e.message}`, 'CacheService')
        }
    }

    // -- Callbacks --------------------------------------------------------

    /**
     * Callback: Redis connection established.
     * @private
     */
    #onRedisConnect() {
        StateService.set('redis.connected', true)
        LoggerService.info('Redis connected', 'CacheService')
    }

    /**
     * Callback: Redis client is ready to accept commands.
     * @private
     */
    #onRedisReady() {
        StateService.set('redis.connected', true)
        LoggerService.info('Redis is ready', 'CacheService')
    }

    /**
     * Callback: Redis error occurred.
     *
     * @param {Error} err - Error object
     * @private
     */
    #onRedisError(_err) {
        StateService.set('redis.connected', false)
        LoggerService.error(`Redis error: ${_err.message}`, 'CacheService')
    }

    /**
     * Callback: Redis reconnection attempt with exponential backoff.
     * Delays grow as 1s, 2s, 4s, 8s ... capped at 30s.
     *
     * @param {number} retry - Retry attempt count (0-based)
     * @returns {number|false} Delay in ms, or false to stop reconnecting
     * @private
     */
    #onRedisReconnectAttempt(retry) {
        const attempt = retry + 1
        const delay = Math.min(
            REDIS_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
            REDIS_RECONNECT_MAX_DELAY_MS
        )

        LoggerService.warn(
            `Redis reconnect attempt #${attempt}, next try in ${delay}ms`,
            'CacheService'
        )

        return delay
    }

    /**
     * Callback: Redis is reconnecting.
     * @private
     */
    #onRedisReconnecting() {
        StateService.set('redis.connected', false)
        LoggerService.info('Redis is reconnecting...', 'CacheService')
    }

    /**
     * Callback: Redis connection ended.
     * @private
     */
    #onRedisEnd() {
        StateService.set('redis.connected', false)
        LoggerService.warn('Redis connection ended', 'CacheService')
    }

    // -- Public API -------------------------------------------------------

    /**
     * Check if Redis client is connected and open.
     *
     * @returns {boolean}
     */
    isConnected() {
        return this.#redis?.isOpen ?? false
    }

    /**
     * Get a cached item by key (JSON-deserialized).
     *
     * @param {string} key - Cache key
     * @returns {Object|undefined} Deserialized value or undefined on failure
     */
    async get(key) {
        if (!this.isConnected()) {
            LoggerService.warn(`Redis is not connected, cannot get key: ${key}`, 'CacheService')
            return undefined
        }

        try {
            const value = await this.#redis.get(key)
            return value ? JSON.parse(value) : undefined
        } catch (e) {
            LoggerService.error(`Redis GET error for key "${key}": ${e.message}`, 'CacheService')
            return undefined
        }
    }

    /**
     * Set a cached item with optional TTL (JSON-serialized).
     *
     * @param {string} key - Cache key
     * @param {Object} item - Value to cache
     * @param {number} [ttl] - Optional TTL in seconds (defaults to {@link DEFAULT_TTL_SECONDS})
     * @returns {boolean} True on success
     */
    async set(key, item, ttl) {
        if (!this.isConnected()) {
            LoggerService.warn(`Redis is not connected, cannot set key: ${key}`, 'CacheService')
            return false
        }

        try {
            const serialized = JSON.stringify(item)
            if (ttl ?? DEFAULT_TTL_SECONDS) {
                await this.#redis.set(key, serialized, { EX: ttl ?? DEFAULT_TTL_SECONDS })
            } else {
                await this.#redis.set(key, serialized)
            }
            return true
        } catch (e) {
            LoggerService.error(`Redis SET error for key "${key}": ${e.message}`, 'CacheService')
            return false
        }
    }

    // -- Human cooldown helpers -------------------------------------------

    /**
     * Set a human-interaction cooldown for a device using Redis TTL.
     * Stores a JSON payload with the expiry epoch so we can compute remaining
     * time without relying on PTTL (which is not reliably available across all
     * redis v4 client interfaces).
     *
     * @param {string} deviceSlug - Slugified device name (e.g., "living_room_roller_left")
     * @param {number} ttlSeconds - Cooldown duration in seconds (e.g., 900 = 15 min)
     * @returns {boolean} True on success
     */
    async setHumanCooldown(deviceSlug, ttlSeconds) {
        if (!this.isConnected()) {
            LoggerService.warn(
                `Redis is not connected, cannot set cooldown for "${deviceSlug}"`,
                'CacheService'
            )
            return false
        }

        try {
            const payload = JSON.stringify({
                type: 'human',
                expiresAt: Date.now() + ttlSeconds * 1000
            })
            await this.#redis.set(`cooldown:${deviceSlug}`, payload, { EX: ttlSeconds })
            return true
        } catch (e) {
            LoggerService.error(
                `Redis SET error for cooldown key "${deviceSlug}": ${e.message}`,
                'CacheService'
            )
            return false
        }
    }

    /**
     * Get remaining cooldown time for a device in milliseconds.
     * Returns null if no cooldown key exists or it has expired.
     *
     * Reads the stored expiry epoch from the JSON payload and compares it to now.
     * This avoids relying on Redis PTTL which may not be available on all client interfaces.
     *
     * @param {string} deviceSlug - Slugified device name
     * @returns {Promise<number|null>} Remaining milliseconds (> 0 means still cooling down), or null
     */
    async getHumanCooldownRemaining(deviceSlug) {
        if (!this.isConnected()) {
            LoggerService.warn(
                `Redis is not connected, cannot check cooldown for "${deviceSlug}"`,
                'CacheService'
            )
            return null
        }

        try {
            const raw = await this.#redis.get(`cooldown:${deviceSlug}`)
            if (!raw) return null

            const data = JSON.parse(raw)
            if (!data || typeof data.expiresAt !== 'number') return null

            const remaining = data.expiresAt - Date.now()
            return remaining > 0 ? remaining : null
        } catch (e) {
            LoggerService.error(
                `Redis GET error for cooldown key "${deviceSlug}": ${e.message}`,
                'CacheService'
            )
            return null
        }
    }

    /**
     * Gracefully disconnect from Redis.
     *
     * @async
     */
    async disconnect() {
        if (this.#redis?.isOpen) {
            try {
                await this.#redis.quit()
                LoggerService.info('Redis disconnected gracefully', 'CacheService')
            } catch (e) {
                LoggerService.error(`Redis disconnect error: ${e.message}`, 'CacheService')
            }
        }
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const CacheService = Object.freeze(new SCacheService())
export default CacheService