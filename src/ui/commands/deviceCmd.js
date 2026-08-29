/**
 * Device Command -- lists and inspects devices from both device registries.
 *
 * Subcommands:
 *   /device                   Show registry counts plus GNU-style usage help
 *   /device list             List every registered device (Zigbee tree + network table)
 *   /device list zigbee      Zigbee devices only (bridge/coordinator excluded)
 *   /device list network     Network-presence devices only (category, IP per entry)
 *   /device debug <name>     Cross-registry lookup: full detail for one device by name,
 *                             case-insensitive; names present in BOTH registries render both
 *
 * Reads DeviceContainer and NetworkPresence through ctx so tests can inject fakes; a
 * missing service degrades to a note instead of crashing. Uses plain text via ctx.print()
 * so it plays nicely with buffer-based UI windows.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CommandBase from './base/commandBase.js'

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

class DeviceCmd extends CommandBase {
    static name = 'device'
    static description = 'List and inspect Zigbee + network devices'
    static takesArgs = true

    /**
     * Dispatch to a subcommand based on the raw argument string. Bare invocation shows
     * registry counts plus usage help; "list" renders one or both registries; "debug"
     * resolves one device across both registries by name.
     *
     * @param {string} args - Raw argument string after the command verb
     */
    async execute(args) {
        const trimmed = String(args ?? '').trim()
        if (trimmed === '') {
            this.#printOverview()
            return
        }

        // First token is the subcommand; everything after it stays intact as the payload
        // so multi-word device names keep working (same convention as /automation).
        const spaceIdx = trimmed.indexOf(' ')
        const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
        const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

        switch (sub) {
            case 'list':
                await this.#handleList(rest)
                break
            case 'debug':
                await this.#handleDebug(rest)
                break
            default:
                this.ctx.print(`Unknown subcommand "${sub}"`)
                this.#printUsageLines()
        }
    }

    /**
     * Tab-completion candidates for /device arguments. The first token offers the known
     * subcommands; once "debug" has been typed, the union of Zigbee and network device names is
     * offered so "/device debug office<Tab>" completes against both registries at once.
     * @param {Array<string>} typedTokens - Fully-typed tokens after the verb (partial excluded)
     * @returns {Array<string>|null} Candidates for the next token, or null when none apply
     */
    completeNextToken(typedTokens) {
        if (!typedTokens || typedTokens.length === 0) return ['list', 'debug']
        const sub = String(typedTokens[0]).toLowerCase()
        if (sub !== 'debug') return null

        const dc = this.ctx.deviceContainer
        const zigbee = (dc && typeof dc.getNames === 'function') ? dc.getNames({ includeBridge: false }) : []
        const np = this.ctx.networkPresence
        const network = (np && typeof np.getDeviceNames === 'function') ? np.getDeviceNames() : []
        const merged = [...(zigbee ?? []), ...(network ?? [])]
        return merged.length > 0 ? merged.sort() : null
    }

    // -- Registry access ------------------------------------------------------

    /**
     * Zigbee devices from ctx (bridge/coordinator excluded at the source), or an empty
     * object when the container is unavailable.
     * @private
     * @returns {Record<string, Object>} Name-keyed map of device instances
     */
    #zigbeeDevices() {
        const dc = this.ctx.deviceContainer
        if (!dc || typeof dc.getAll !== 'function') return {}
        try {
            const all = dc.getAll({ includeBridge: false }) ?? {}
            return (all && typeof all === 'object' && !Array.isArray(all)) ? all : {}
        } catch {
            return {}
        }
    }

    /**
     * Configured network devices from ctx, or [] when NetworkPresence is unavailable.
     * @private
     * @returns {Array<{name: string, category: string, ip: string}>} Sorted flat listing
     */
    #networkDevices() {
        const np = this.ctx.networkPresence
        if (!np || typeof np.getNetworkDevices !== 'function') return []
        try {
            const list = np.getNetworkDevices() ?? []
            return Array.isArray(list) ? list : []
        } catch {
            return []
        }
    }

    /**
     * Bare invocation view: registry counts, usage help and the union of known names so
     * users can see what "debug" could address without typing it first.
     * @private
     */
    #printOverview() {
        const zigbeeCount = Object.keys(this.#zigbeeDevices()).length
        const networkCount = this.#networkDevices().length
        this.ctx.print(`Zigbee devices: ${zigbeeCount} | Network devices: ${networkCount}`)
        this.ctx.print('')
        this.#printUsageLines()
    }

    /**
     * Usage block shared by bare invocation and unknown-subcommand fallbacks.
     * @private
     */
    #printUsageLines() {
        const lines = [
            'Usage: /device <subcommand> [args]',
            '',
            '  list [zigbee|network]   List registered devices from both or one registry',
            '  debug <name>            Inspect one device across both registries',
            '',
        ]
        const names = this.#allNames()
        if (names.length > 0) {
            lines.push(`Available: ${names.join(', ')}`)
        } else {
            lines.push('(no devices registered)')
        }
        this.ctx.print(lines.join('\n'))
    }

    /**
     * "list" subcommand -- renders the Zigbee tree, the network table, or just one of
     * them when a filter token is given. Unknown filters are reported with valid options.
     * @private
     * @param {string} rest - Argument string after "list" (may be empty)
     */
    async #handleList(rest) {
        let filter = ''
        if (rest !== '') {
            filter = rest.toLowerCase()
            if (!['zigbee', 'network'].includes(filter)) {
                this.ctx.print(`Unknown filter "${rest}"`)
                this.ctx.print('Valid filters: zigbee | network   (omit to list both)')
                return
            }
        }

        // Blank separator appears only between real section outputs when at least one of
        // them rendered an actual tree -- two bare "(none)" notes stay adjacent.
        const hasZigbee = Object.keys(this.#zigbeeDevices()).length > 0
        const hasNetwork = this.#networkDevices().length > 0
        let first = true
        /** @type {(fn: () => Promise<void>|void) => Promise<void>} */
        const emit = async (fn) => {
            if (!first && (hasZigbee || hasNetwork)) this.ctx.print('')
            first = false
            await fn()
        }

        if (filter !== 'network') {
            await emit(hasZigbee ? () => this.#renderZigbeeSection(true) : () => this.ctx.print('(no zigbee devices registered)'))
        }
        if (filter !== 'zigbee') {
            await emit(hasNetwork ? () => this.#renderNetworkSection(true) : () => this.ctx.print('(no network devices configured)'))
        }
    }

    /**
     * Render the Zigbee registry as a shared-style tree entry per device (name plus type
     * and id rows). Prints an explicit note when nothing is registered.
     * @private
     * @param {boolean} headed - Whether to print the section header line first
     */
    async #renderZigbeeSection(headed) {
        const devices = this.#zigbeeDevices()
        const names = Object.keys(devices).sort((a, b) => a.localeCompare(b))
        if (names.length === 0) {
            this.ctx.print('(no zigbee devices registered)')
            return
        }
        if (headed) this.ctx.print(`-- Zigbee devices (${names.length}) --`)
        const entries = names.map((name) => ({ name, props: this.#lightProps(devices[name]) }))
        this.printTree(entries)
    }

    /**
     * Render the network-presence registry as one tree entry per configured device with
     * category/IP rows. Presence state itself belongs in "debug" so listing stays cheap.
     * @private
     * @param {boolean} headed - Whether to print the section header line first
     */
    async #renderNetworkSection(headed) {
        const list = this.#networkDevices()
        if (list.length === 0) {
            this.ctx.print('(no network devices configured)')
            return
        }
        if (headed) this.ctx.print(`-- Network devices (${list.length}) --`)
        const entries = list.map((d) => ({
            name: d.name,
            props: [
                ['category', String(d.category)],
                ['ip', String(d.ip)],
            ],
        }))
        this.printTree(entries)
    }

    /**
     * "debug" subcommand -- resolves one device name across BOTH registries
     * (case-insensitive). A hit in exactly one registry renders its full detail view;
     * a hit in both is reported as ambiguous and renders each under a labelled block so
     * nothing is hidden. Unknown names fall back to the union of available names.
     * @private
     * @param {string} rawName - Name argument after "debug" (may be empty)
     */
    async #handleDebug(rawName) {
        const trimmed = String(rawName ?? '').trim()
        if (!trimmed) {
            this.ctx.print('Missing device name')
            this.#printAvailableNames()
            return
        }

        const zigbeeHit = this.#findZigbee(trimmed)
        const networkHit = this.#networkDevices().find(
            (d) => d.name.toLowerCase() === trimmed.toLowerCase()
        ) ?? null

        if (!zigbeeHit && !networkHit) {
            this.ctx.print(`Unknown device "${trimmed}"`)
            this.#printAvailableNames()
            return
        }

        if (zigbeeHit && networkHit) {
            this.ctx.print(`Ambiguous name "${trimmed}" -- found in BOTH registries:`)
            this.ctx.print('')
            this.ctx.print('-- Zigbee --')
            this.printTree([{ name: zigbeeHit.key, props: this.#zigbeeDebugProps(zigbeeHit.device) }])
            this.ctx.print('')
            this.ctx.print('-- Network --')
            await this.#renderNetworkDebug(networkHit)
            return
        }

        if (zigbeeHit) {
            this.printTree([{ name: zigbeeHit.key, props: this.#zigbeeDebugProps(zigbeeHit.device) }])
            return
        }
        await this.#renderNetworkDebug(networkHit)
    }

    /**
     * Render the full detail view for one configured network device including its live
     * presence state when a lookup is available; cold caches render as "unknown".
     * @private
     * @param {{name: string, category: string, ip: string}} entry - Flat listing entry
     */
    async #renderNetworkDebug(entry) {
        let presence = 'unknown'
        const np = this.ctx.networkPresence
        if (np && typeof np.getPresence === 'function') {
            try {
                presence = (await np.getPresence(entry.name)) ?? 'unknown'
            } catch {
                presence = 'unknown'
            }
        }
        this.printTree([{
            name: entry.name,
            props: [
                ['registry', 'network'],
                ['category', String(entry.category)],
                ['ip', String(entry.ip)],
                ['presence', presence],
            ],
        }])
    }

    /**
     * Compact property rows for list views (type + id only -- deep state belongs in debug).
     * Tolerates devices that lack optional accessors.
     * @private
     * @param {Object} device - Device instance from the registry
     * @returns {Array<[string, string]>} Rows of [label, value] pairs
     */
    #lightProps(device) {
        const props = [['type', DeviceCmd.typeLabel(device)]]
        if (device && typeof device.getId === 'function') {
            const id = device.getId()
            if (id != null) props.push(['id', String(id)])
        }
        return props
    }

    /**
     * Full detail rows for the debug view: type label, Zigbee id, last reported state,
     * origin and active kind when those accessors exist on the instance. Every accessor
     * is guarded so heterogeneous device classes never break rendering.
     * @private
     * @param {Object} device - Device instance from the registry
     * @returns {Array<[string, string]>} Rows of [label, value] pairs
     */
    #zigbeeDebugProps(device) {
        const props = [
            ['registry', 'zigbee'],
            ['type', DeviceCmd.typeLabel(device)],
        ]
        if (!device || typeof device !== 'object') return props

        if (typeof device.getId === 'function') {
            const id = device.getId()
            if (id != null) props.push(['id', String(id)])
        }
        if (typeof device.getStateLast === 'function') {
            const stateLast = device.getStateLast()
            const hasState = stateLast && typeof stateLast === 'object' && Object.keys(stateLast).length > 0
            props.push(['last state', hasState ? JSON.stringify(stateLast) : '(no recent state)'])
        }
        if (typeof device.getStateOrigin === 'function') {
            const origin = device.getStateOrigin()
            if (origin != null) props.push(['origin', String(origin)])
        }
        if (typeof device.hasActive === 'function' && device.hasActive()) {
            const kind = typeof device.getActiveKind === 'function' ? device.getActiveKind() : null
            if (kind != null) props.push(['active', String(kind)])
        }
        return props
    }

    /**
     * Resolve a Zigbee registry entry by user-supplied name: exact match first, then
     * case-insensitive comparison in sorted key order so mistyped casing still works.
     * @private
     * @param {string} rawName - Name typed by the user (may be empty)
     * @returns {{key: string, device: Object}|null} Resolved entry or null when not found
     */
    #findZigbee(rawName) {
        if (!rawName) return null
        const devices = this.#zigbeeDevices()
        if (Object.prototype.hasOwnProperty.call(devices, rawName)) {
            return { key: rawName, device: devices[rawName] }
        }
        const lower = rawName.toLowerCase()
        for (const key of Object.keys(devices).sort((a, b) => a.localeCompare(b))) {
            if (key.toLowerCase() === lower) return { key, device: devices[key] }
        }
        return null
    }

    /**
     * Union of registered names from both registries, de-duplicated and sorted -- used by
     * usage footers and unknown-name fallbacks.
     * @private
     * @returns {string[]} Sorted unique names
     */
    #allNames() {
        const set = new Set(Object.keys(this.#zigbeeDevices()))
        for (const d of this.#networkDevices()) set.add(d.name)
        return [...set].sort((a, b) => a.localeCompare(b))
    }

    /**
     * Print the union listing of known device names (or a note when none exist).
     * @private
     */
    #printAvailableNames() {
        const names = this.#allNames()
        if (names.length === 0) {
            this.ctx.print('(no devices registered)')
        } else {
            this.ctx.print(`Available: ${names.join(', ')}`)
        }
    }

    /**
     * Human-readable type label for a device instance derived from its prototype chain,
     * falling back to "device" for plain objects.
     * @param {Object|null} device - Device instance
     * @returns {string} Class name like "Sensor", "Mechanism" or "device"
     */
    static typeLabel(device) {
        let proto = Object.getPrototypeOf(device ?? null)
        while (proto && proto !== Object.prototype) {
            const ctorName = proto.constructor?.name ?? ''
            if (ctorName !== '') return ctorName
            proto = Object.getPrototypeOf(proto)
        }
        return 'device'
    }
}

export default DeviceCmd