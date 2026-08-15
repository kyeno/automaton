/**
 * Channel Configuration Manager.
 *
 * Loads window/channel definitions from automaton.yaml and provides
 * lookup methods so that channel names, shortcuts, and read-only flags
 * are no longer hardcoded throughout the UI codebase.
 *
 * IRC-style naming convention:
 *   !prefix  -- readonly channel (e.g., !log, !sensors)
 *   #prefix  -- interactive channel (e.g., #automaton)
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

// ---------------------------------------------------------------------------
// SChannelManager (singleton)
// ---------------------------------------------------------------------------

/**
 * Manages window/channel definitions loaded from automaton.yaml.
 * Provides lookup by internal id and numeric shortcut key.
 */
class SChannelManager {
    #channels = []
    #byId = new Map()
    #byShortcut = new Map()
    #loaded = false

    // -- Initialization ---------------------------------------------------

    /**
     * Load channel definitions from the 'windows' section of automaton.yaml.
     * Safe to call multiple times; subsequent calls return cached data.
     */
    load() {
        if (this.#loaded) return this.#channels

        try {
            // Use get() not getSection() -- windows is an array and getSection rejects arrays
            const raw = ConfigService.get('windows') || []
            this.#channels = raw.map((w, index) => ({
                id: w.id || `window${index + 1}`,
                channel: w.channel || `#window${index + 1}`,
                title: w.title || `Window ${index + 1}`,
                shortcut: Number(w.shortcut) || (index + 1),
                readonly: Boolean(w.readonly ?? false),
            }))

            // Build lookup maps
            for (const ch of this.#channels) {
                this.#byId.set(ch.id, ch)
                this.#byShortcut.set(ch.shortcut, ch)
            }

            this.#loaded = true
            LoggerService.debug(`Loaded ${this.#channels.length} channel(s) from config`, 'UI')
        } catch (e) {
            LoggerService.warn(`Failed to load channel config: ${e.message}`, 'UI')
            this.#loaded = true // prevent retry storms
        }

        return this.#channels
    }

    // -- Public API -------------------------------------------------------

    /**
     * Get all channel definitions.
     * @returns {Array<Object>} Array of channel objects
     */
    getAll() {
        return this.load()
    }

    /**
     * Look up a channel by its internal id ('logs', 'device', 'ai').
     * @param {string} id - Window/channel ID
     * @returns {Object|null}
     */
    getById(id) {
        return this.#byId.get(id) || null
    }

    /**
     * Look up a channel by its numeric shortcut (1, 2, 3...).
     * @param {number} shortcut
     * @returns {Object|null}
     */
    getByShortcut(shortcut) {
        return this.#byShortcut.get(Number(shortcut)) || null
    }

    /**
     * Get the active window's channel name given its internal id.
     * Falls back to the title if no channel is configured.
     * @param {string} windowId
     * @returns {string} Channel name (e.g., "!log", "#automaton")
     */
    getChannelName(windowId) {
        const ch = this.getById(windowId)
        return ch ? ch.channel : `[window:${windowId}]`
    }
}

// Export a singleton instance
const channels = new SChannelManager()
export default channels