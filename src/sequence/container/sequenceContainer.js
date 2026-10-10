/**
 * Sequence container (singleton).
 * Repository for all configured sequence instances -- loaded from etc/sequence/.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import ConfigService from '../../service/configService.js'
import LoggerService from '../../service/loggerService.js'
import { slugify } from '../../lib/string.js'
import SequenceBase from '../base/sequenceBase.js'


//  SSequenceContainer (singleton)

/** Sequence repository: loads entries from config and manages instance lifecycle. */
class SSequenceContainer {

    instance

    /** Map of sequence instances keyed by their slug.
     * @type {Map<string, SequenceBase>} */
    #sequences = new Map()


    /** Synchronous singleton constructor.
     * @return {this} */
    constructor() {
        if (!SSequenceContainer.instance) SSequenceContainer.instance = this
        return SSequenceContainer.instance
    }

    //  -- Lifecycle ----------------------------------------------------

    /** Initialize the container: resolve the sequences config path, load + validate the section,
     * normalize entries (name/duplicate-slug/form rules), instantiate each SequenceBase and clear
     * stale state keys. Bad or missing config warns and stays inert -- never crashes startup (D16).
     * @async */
    async init() {
        const filePath = ConfigService.getConfigPath('sequence')
        if (!filePath) {
            LoggerService.warn('No sequence config path configured -- sequences stay inert', 'SequenceContainer')
            return
        }

        const section = ConfigService.load(filePath, 'sequences')
        if (!section) {
            LoggerService.warn(`No sequence config available at "${filePath}" -- sequences stay inert`, 'SequenceContainer')
            return
        }

        let errors = []
        try {
            errors = await section.validate()
        } catch (err) {
            errors = [String(err?.message ?? err)]
        }
        for (const error of errors) {
            LoggerService.warn(`Sequences config: ${error}`, 'SequenceContainer')
        }

        const rawEntries = section.get('sequences', [])
        const entries = Array.isArray(rawEntries) ? rawEntries : []
        let loadedCount = 0

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                LoggerService.warn(`Sequences entry #${i + 1} is not an object -- skipped`, 'SequenceContainer')
                continue
            }

            const name = entry.name
            if (typeof name !== 'string' || !name.trim()) {
                LoggerService.warn(`Sequences entry #${i + 1} has no "name" -- skipped`, 'SequenceContainer')
                continue
            }

            const slug = slugify(name)
            if (this.#sequences.has(slug)) {
                LoggerService.error(`Duplicate sequence slug "${slug}" ("${name}") -- skipping duplicate`, 'SequenceContainer')
                continue
            }

            const hasDevices = Array.isArray(entry.devices) && entry.devices.length > 0
            const hasOn = Array.isArray(entry.on) && entry.on.length > 0
            if (hasDevices === hasOn) {
                LoggerService.warn(`Sequence "${name}" must define exactly one of devices:/on: -- skipped`, 'SequenceContainer')
                continue
            }

            try {
                const seq = new SequenceBase(name, entry)
                await seq.init()
                this.#sequences.set(slug, seq)
                loadedCount++
            } catch (err) {
                LoggerService.error(`Failed to initialize sequence "${name}": ${err.message}`, 'SequenceContainer')
            }
        }

        LoggerService.info(`${loadedCount} sequence(s) loaded`, 'SequenceContainer')
    }

    /** Clean up all sequences during graceful shutdown. */
    cleanupSequences() {
        LoggerService.info('Cleaning up sequences...', 'SequenceContainer')
        const cleanups = [...this.#sequences.values()].map((seq) => {
            try {
                seq.cleanup?.()
            } catch (err) {
                LoggerService.error(`Error cleaning up sequence "${seq.getName()}": ${err.message}`, 'SequenceContainer')
            }
        })
        return Promise.all(cleanups)
    }

    //  -- Public API -----------------------------------------------------

    /** Get a sequence instance by its slug.
     * @param {string} slug - Registry key (slugified name)
     * @returns {SequenceBase|undefined} The instance or undefined when unknown */
    get(slug) {
        return this.#sequences.get(String(slug ?? ''))
    }

    /** All registered instances as an array.
     * @returns {SequenceBase[]} */
    getAll() {
        return [...this.#sequences.values()]
    }

    /** Registered slugs, sorted for stable display.
     * @returns {string[]} */
    getNames() {
        return [...this.#sequences.keys()].sort()
    }

    /** Resolve a user-supplied name to an instance: accepts the slug or the original friendly
     * name (case-insensitive). Returns null when nothing matches.
     * @param {string} rawName - Name typed by the caller
     * @returns {SequenceBase|null} Resolved instance or null when not found */
    resolveSequence(rawName) {
        const raw = String(rawName ?? '').trim()
        if (!raw) return null
        const bySlug = this.#sequences.get(slugify(raw))
        if (bySlug) return bySlug
        const lower = raw.toLowerCase()
        for (const seq of this.#sequences.values()) {
            if (seq.getName().toLowerCase() === lower || seq.getSlug() === lower) return seq
        }
        return null
    }

    /** Send a command down one sequence via its blocking run core; unknown names warn gracefully.
     * @param {string} name - Slug or friendly name
     * @param {'ON'|'OFF'} [command='ON'] - Action to send
     * @returns {Promise<boolean>} true when the run executed, false when rejected/unknown */
    async callCommand(name, command = 'ON') {
        const seq = this.resolveSequence(name)
        if (!seq) {
            LoggerService.warn(`Unknown sequence: "${name}"`, 'SequenceContainer')
            return false
        }
        return seq.run(command)
    }

    /** Start the loop on one sequence instance; unknown names warn gracefully.
     * @param {string} name - Slug or friendly name
     * @returns {Promise<boolean>} true when the loop started */
    async startLoop(name) {
        const seq = this.resolveSequence(name)
        if (!seq) {
            LoggerService.warn(`Unknown sequence: "${name}"`, 'SequenceContainer')
            return false
        }
        return seq.startLoop()
    }

    /** Gracefully stop the loop on one sequence instance; unknown names warn gracefully.
     * @param {string} name - Slug or friendly name
     * @returns {boolean} true when a stop was requested */
    stopLoop(name) {
        const seq = this.resolveSequence(name)
        if (!seq) {
            LoggerService.warn(`Unknown sequence: "${name}"`, 'SequenceContainer')
            return false
        }
        return seq.stopLoop()
    }

    /** Whether one sequence's loop session is currently engaged.
     * @param {string} name - Slug or friendly name
     * @returns {boolean} False for unknown sequences (no warning -- pure query) */
    isLoopActive(name) {
        const seq = this.resolveSequence(name)
        return seq ? seq.isLoopActive() : false
    }
}

//  Singletonize and export to Node.js.
const SequenceContainer = new SSequenceContainer()
Object.freeze(SequenceContainer)
export default SequenceContainer