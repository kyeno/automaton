/**
 * Named IR commands shared by UI, interactions, sequences and AI.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from '../service/configService.js'
import ConfigBase from '../service/config/configBase.js'
import DeviceContainer from '../device/container/deviceContainer.js'
import I18nLoader from '../service/i18nLoader.js'
import LoggerService from '../service/loggerService.js'
import DeviceCommandSource from '../enum/deviceCommandSource.js'

/** Language-neutral normalization for bounded catalog searches.
 * @param {string} value - Search text
 * @returns {string} Folded text */
export function normalizeSearch(value) {
    return String(value ?? '').toLowerCase().replace(/ł/g, 'l').normalize('NFKD')
        .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Rank catalog metadata without exposing codes or expanding model tool schemas.
 * @param {Object[]} entries - Public metadata
 * @param {string} query - Natural language query
 * @param {number} [limit=5] - Maximum results (capped at 10)
 * @returns {Object} Bounded results and truncation indicator */
export function searchCatalog(entries, query, limit = 5) {
    const terms = normalizeSearch(query).split(' ').filter(Boolean)
    const ranked = entries.map(entry => {
        const text = normalizeSearch([entry.id, entry.name, entry.label, entry.description].filter(Boolean).join(' '))
        return { entry, score: terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0) }
    }).filter(item => !terms.length || item.score > 0)
        .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(10, limit)) : 5
    return { results: ranked.slice(0, count).map(item => item.entry), has_more: ranked.length > count }
}

/** Catalog owner; device instances remain owned by DeviceContainer. */
class SIRCommandService {
    #commands = new Map()
    #initialized = false

    /** Load the optional catalog at startup. */
    async init() {
        await this.reload()
        this.#initialized = true
    }

    /** Whether startup initialized this service.
     * @returns {boolean} Initialization status */
    isInitialized() {
        return this.#initialized
    }

    /** Validate a complete candidate before replacing the active catalog.
     * @returns {Promise<Object>} Reload report */
    async reload() {
        try {
            const candidate = new ConfigBase(ConfigService.getConfigPath('ir'), 'ir')
            await candidate.ensureValidated()
            const commands = candidate.get('commands')
            const registry = new Map(Object.entries(commands).map(([id, entry]) => [id, Object.freeze({ ...entry })]))
            this.#commands = registry
            return { ok: true, loaded: registry.size }
        } catch (error) {
            LoggerService.warn(`IR catalog kept unchanged: ${error.message}`, 'IRCommandService')
            return { ok: false, error: error.message, loaded: this.#commands.size }
        }
    }

    /** Public metadata for a command; never returns its Base64 code.
     * @param {string} id - Stable command ID
     * @returns {Object|null} Localized metadata */
    get(id) {
        const entry = this.#commands.get(id)
        if (!entry) return null
        return {
            id,
            transmitter: entry.transmitter,
            label: I18nLoader.t(`ir.commands.${id}.label`, id),
            description: I18nLoader.t(`ir.commands.${id}.description`, id)
        }
    }

    /** List live localized command metadata.
     * @returns {Object[]} Commands sorted by ID */
    list() {
        return [...this.#commands.keys()].sort().map(id => this.get(id))
    }

    /** Find a bounded set of commands using current locale metadata.
     * @param {string} query - Search text
     * @param {number} [limit=5] - Result limit
     * @returns {Object} Search results */
    search(query, limit = 5) {
        return searchCatalog(this.list(), query, limit)
    }

    /** Execute by stable ID, optionally restricted to a specific transmitter.
     * @param {string} id - Command ID
     * @param {Object} [context={}] - Source, caller and optional transmitter restriction
     * @returns {Promise<Object>} Local dispatch result; appliance state is unknown */
    async send(id, context = {}) {
        const entry = this.#commands.get(id)
        if (!entry) throw new Error(`Unknown IR command: ${id}`)
        if (context.transmitter && entry.transmitter !== context.transmitter) {
            throw new Error(`IR command ${id} belongs to transmitter ${entry.transmitter}`)
        }
        const transmitter = DeviceContainer.findByName(entry.transmitter)
        if (!transmitter || typeof transmitter.transmit !== 'function') {
            throw new Error(`IR transmitter unavailable: ${entry.transmitter}`)
        }
        const source = context.source ?? DeviceCommandSource.HUMAN
        await transmitter.transmit(entry.code, { ...context, source, commandId: id })
        return { command_id: id, transmitter: entry.transmitter, status: 'dispatched', target_state: 'unknown' }
    }
}

const IRCommandService = Object.freeze(new SIRCommandService())
export default IRCommandService
