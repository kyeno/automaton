/**
 * Cache service backed by Redis.
 * Provides JSON-serialized get/set accessors with configurable TTL.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { createClient } from 'redis'
import LoggerService from './loggerService.js'
import StateService from './stateService.js'


/** Default TTL for cached entries in seconds (3 hours).
 * @type {number} */
const DEFAULT_TTL_SECONDS = 10_800

/** Base delay for Redis exponential backoff in milliseconds.
 * @type {number} */
const REDIS_RECONNECT_BASE_DELAY_MS = 1_000

/** Upper bound for Redis reconnect backoff in milliseconds.
 * @type {number} */
const REDIS_RECONNECT_MAX_DELAY_MS = 30_000

/** Deadline for cache commands, including a connected but unresponsive server. */
const COMMAND_TIMEOUT_MS = 2_000

//  CacheService (module-level singleton)

/** Redis connection wrapper with automatic reconnection.
 * @see {@link https://www.npmjs.com/package/redis} */
class SCacheService {

    #redis
    /** Prevent command deadlines from reconnecting during shutdown. */
    #shuttingDown = false


    /** Create the Redis client, attach lifecycle listeners, and connect.
     * @param {Object} [options={}] - Optional client factory for isolated tests
     * @param {Function} [options.createClientFn] - Factory matching redis.createClient
     * @async */
    async init(options = {}) {
        this.#shuttingDown = false
        this.#redis = (options.createClientFn ?? createClient)({
            url: process.env.REDIS_URL,
            disableOfflineQueue: true,
            commandOptions: { timeout: COMMAND_TIMEOUT_MS },
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

    //  -- Callbacks --------------------------------------------------------

    /** Callback: Redis connection established.
     * @private */
    #onRedisConnect() {
        StateService.set('redis.connected', false)
        LoggerService.info('Redis connected', 'CacheService')
    }

    /** Callback: Redis client is ready to accept commands.
     * @private */
    #onRedisReady() {
        if (this.#shuttingDown) return
        StateService.set('redis.connected', true)
        LoggerService.info('Redis is ready', 'CacheService')
    }

    /** Callback: Redis error occurred.
     * @param {Error} err - Error object
     * @private */
    #onRedisError(_err) {
        StateService.set('redis.connected', false)
        LoggerService.error(`Redis error: ${_err.message}`, 'CacheService')
    }

    /** Callback: Redis reconnection attempt with exponential backoff.
     * @param {number} retry - Retry attempt count (0-based)
     * @returns {number|false} Delay in ms, or false to stop reconnecting
     * @private */
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

    /** Callback: Redis is reconnecting.
     * @private */
    #onRedisReconnecting() {
        StateService.set('redis.connected', false)
        LoggerService.info('Redis is reconnecting...', 'CacheService')
    }

    /** Callback: Redis connection ended.
     * @private */
    #onRedisEnd() {
        StateService.set('redis.connected', false)
        LoggerService.warn('Redis connection ended', 'CacheService')
    }

    //  -- Public API -------------------------------------------------------

    /** Check if Redis is ready to execute commands without waiting for reconnection.
     * @returns {boolean} */
    isConnected() {
        return !this.#shuttingDown && (this.#redis?.isReady ?? false)
    }

    /** Get a cached item by key (JSON-deserialized).
     * @param {string} key - Cache key
     * @returns {Object|undefined} Deserialized value or undefined on failure */
    async get(key) {
        if (!this.isConnected()) {
            LoggerService.warn(`Redis is not connected, cannot get key: ${key}`, 'CacheService')
            return undefined
        }

        try {
            const value = await this.#command('get', key)
            return value ? JSON.parse(value) : undefined
        } catch (e) {
            LoggerService.error(`Redis GET error for key "${key}": ${e.message}`, 'CacheService')
            return undefined
        }
    }

    /** Set a cached item with optional TTL (JSON-serialized).
     * @param {string} key - Cache key
     * @param {Object} item - Value to cache
     * @param {number} [ttl] - Optional TTL in seconds (defaults to {@link DEFAULT_TTL_SECONDS}).
     * @returns {boolean} True on success */
    async set(key, item, ttl) {
        if (!this.isConnected()) {
            LoggerService.warn(`Redis is not connected, cannot set key: ${key}`, 'CacheService')
            return false
        }

        try {
            const serialized = JSON.stringify(item)
            if (ttl ?? DEFAULT_TTL_SECONDS) {
                await this.#command('set', key, serialized, { EX: ttl ?? DEFAULT_TTL_SECONDS })
            } else {
                await this.#command('set', key, serialized)
            }
            return true
        } catch (e) {
            LoggerService.error(`Redis SET error for key "${key}": ${e.message}`, 'CacheService')
            return false
        }
    }

    /** Delete a cached item by key.
     * @param {string} key - Cache key
     * @returns {boolean} True on success */
    async delete(key) {
        if (!this.isConnected()) {
            LoggerService.warn(`Redis is not connected, cannot delete key: ${key}`, 'CacheService')
            return false
        }

        try {
            await this.#command('del', key)
            return true
        } catch (e) {
            LoggerService.error(`Redis DEL error for key "${key}": ${e.message}`, 'CacheService')
            return false
        }
    }

    //  -- Human cooldown helpers -------------------------------------------

    /** Set a human-interaction cooldown for a device using Redis TTL.
     * @param {string} deviceSlug - Slugified device name (e.g., "living_room_roller_left")
     * @param {number} ttlSeconds - Cooldown duration in seconds (e.g., 900 = 15 min)
     * @returns {boolean} True on success */
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
            await this.#command('set', `cooldown:${deviceSlug}`, payload, { EX: ttlSeconds })
            return true
        } catch (e) {
            LoggerService.error(
                `Redis SET error for cooldown key "${deviceSlug}": ${e.message}`,
                'CacheService'
            )
            return false
        }
    }

    /** Get remaining cooldown time for a device in milliseconds.
     * @param {string} deviceSlug - Slugified device name
     * @returns {Promise<number|null>} Remaining milliseconds (> 0 means still cooling down), or null */
    async getHumanCooldownRemaining(deviceSlug) {
        if (!this.isConnected()) {
            LoggerService.warn(
                `Redis is not connected, cannot check cooldown for "${deviceSlug}"`,
                'CacheService'
            )
            return null
        }

        try {
            const raw = await this.#command('get', `cooldown:${deviceSlug}`)
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

    /** Bound the entire command, including time waiting for a reply on the socket.
     * Redis commandOptions.timeout only covers commands not yet written. On deadline,
     * retire the socket to flush pending replies and reconnect without replaying writes.
     * @param {string} method - Redis command method
     * @param {...any} args - Command arguments
     * @returns {Promise<any>} Command result, or rejection handled by the public accessor
     * @private */
    async #command(method, ...args) {
        const client = this.#redis
        const controller = new AbortController()
        let timer
        try {
            return await Promise.race([
                client.withAbortSignal(controller.signal)[method](...args),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        reject(new Error(`Redis command timed out after ${COMMAND_TIMEOUT_MS}ms`))
                        controller.abort()
                        if (this.#redis !== client || this.#shuttingDown) return
                        StateService.set('redis.connected', false)
                        try {
                            if (client.isOpen) client.destroy()
                            void client.connect().catch((error) => {
                                if (this.#shuttingDown || this.#redis !== client) return
                                LoggerService.error(`Redis recovery failed: ${error.message}`, 'CacheService')
                            })
                        } catch (error) {
                            LoggerService.error(`Redis recovery failed: ${error.message}`, 'CacheService')
                        }
                    }, COMMAND_TIMEOUT_MS)
                })
            ])
        } finally {
            clearTimeout(timer)
        }
    }

    /** Gracefully disconnect from Redis.
     * @async */
    async disconnect() {
        this.#shuttingDown = true
        StateService.set('redis.connected', false)
        if (this.#redis?.isOpen) {
            try {
                if (!this.#redis.isReady) {
                    this.#redis.destroy()
                } else {
                    let timer
                    try {
                        await Promise.race([
                            this.#redis.quit(),
                            new Promise((_, reject) => {
                                timer = setTimeout(() => reject(new Error('Redis disconnect timed out')), COMMAND_TIMEOUT_MS)
                            })
                        ])
                    } finally {
                        clearTimeout(timer)
                        if (this.#redis.isOpen) this.#redis.destroy()
                    }
                }
                LoggerService.info('Redis disconnected gracefully', 'CacheService')
            } catch (e) {
                LoggerService.error(`Redis disconnect error: ${e.message}`, 'CacheService')
            }
        }
    }
}

//  Module-level singleton -- ES module caching guarantees single instantiation.
const CacheService = Object.freeze(new SCacheService())
export default CacheService