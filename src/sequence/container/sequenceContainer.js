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

    /** True once bootstrap ran at least one build attempt -- gates /config reload probes so half-built containers are never touched. */
    #initialized = false


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
        const built = await this.#buildRegistry()
        if (!built.ok) {
            LoggerService.warn(`Sequences stay inert -- ${built.reason}`, 'SequenceContainer')
        } else {
            this.#sequences = built.registry
            LoggerService.info(`${built.loaded} sequence(s) loaded`, 'SequenceContainer')
        }
        this.#initialized = true
    }

    /** Re-read the sequences config from disk and rebuild the live registry in place -- the hook
     * behind /config reload. Two-phase safe swap: when the file cannot be read at all the current
     * registry is kept intact; otherwise engaged loops are gracefully stopped first (in-flight step
     * lists finish per D6), then the map is replaced with freshly built instances so added/renamed/
     * removed definitions take effect without a restart. Entry semantics match startup exactly
     * (bad entries warn+skip, never crash -- D16).
     * @returns {Promise<{ok:boolean, loaded:number, added:string[], removed:string[]}>} Report for UI rendering */
    async reloadSequences() {
        const before = new Set(this.#sequences.keys())
        const built = await this.#buildRegistry()

        if (!built.ok) {
            LoggerService.warn(
                `Sequences reload skipped (${built.reason}) -- keeping ${before.size} registered instance(s)`,
                'SequenceContainer'
            )
            return { ok: false, loaded: 0, added: [], removed: [] }
        }

        //  Graceful teardown of outgoing instances before their definition goes stale (D6/D16):
        //  stop engaged loops and cancel armed inter-phase timers; in-flight step lists finish first.
        for (const seq of [...this.#sequences.values()]) {
            try {
                if (seq.isLoopActive()) seq.stopLoop()
                seq.cleanup?.()
            } catch (err) {
                LoggerService.error(`Error tearing down sequence "${seq.getName()}": ${err.message}`, 'SequenceContainer')
            }
        }

        this.#sequences = built.registry
        this.#initialized = true

        const after = [...this.#sequences.keys()]
        const added = after.filter((slug) => !before.has(slug)).sort()
        const removed = [...before].filter((slug) => !after.includes(slug)).sort()
        return { ok: true, loaded: after.length, added, removed }
    }

    /** Read the sequences config fresh from disk and build a brand-new registry WITHOUT touching
     * the live map -- shared by init() and reloadSequences(). Per-entry diagnostics (schema errors,
     * bad entries, inert devices) warn exactly as they do at startup.
     * @private
     * @returns {Promise<{ok:boolean, reason?:string, registry?:Map<string, SequenceBase>, loaded?:number}>} */
    async #buildRegistry() {
        const filePath = ConfigService.getConfigPath('sequence')
        if (!filePath) {
            return { ok: false, reason: 'no sequence config path configured' }
        }

        //  load() may hand back a cached instance -- possibly one still bound to an older file path.
        //  Rebind through the service when needed and force a disk read either way, so both init()
        //  and reloadSequences() always see current on-disk state; parse errors surface as not-ok
        //  instead of silently rebuilding from stale data.
        let section = ConfigService.load(filePath, 'sequences')
        try {
            if (section && section.filePath !== filePath) {
                ConfigService.unload('sequences')
                section = ConfigService.load(filePath, 'sequences')
            }
            if (!section) throw new Error(`no sequence config available at "${filePath}"`)
            section.refresh()
        } catch (err) {
            return { ok: false, reason: String(err?.message ?? err) }
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
        /** @type {Map<string, SequenceBase>} */
        const registry = new Map()
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
            if (registry.has(slug)) {
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
                registry.set(slug, seq)
                loadedCount++
            } catch (err) {
                LoggerService.error(`Failed to initialize sequence "${name}": ${err.message}`, 'SequenceContainer')
            }
        }

        return { ok: true, registry, loaded: loadedCount }
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

    /** Whether bootstrap has run for this container (even if no sequences loaded) -- /config reload
     * only rebuilds when true, keeping processes that never started it (e.g., unit tests) untouched.
     * @returns {boolean} */
    isInitialized() {
        return this.#initialized
    }

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