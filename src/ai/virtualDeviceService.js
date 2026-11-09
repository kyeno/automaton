/** AI-facing named actions, presented through the ordinary device tools. */
'use strict'

import ConfigService from '../service/configService.js'
import ConfigBase from '../service/config/configBase.js'
import LoggerService from '../service/loggerService.js'
import DeviceContainer from '../device/container/deviceContainer.js'
import DeviceCommandSource from '../enum/deviceCommandSource.js'
import SequenceContainer from '../sequence/container/sequenceContainer.js'
import AutomationContainer from '../automation/container/automationContainer.js'
import InteractionContainer from '../interaction/container/interactionContainer.js'
import IRCommandService from '../ir/irCommandService.js'
import NetworkPresence from '../monitor/networkPresence.js'
import { normalizeDeviceToolName } from '../lib/string.js'

/** A virtual target has no Zigbee identity or confirmed appliance state. */
class VirtualDevice {
    #entry

    /** @param {Object} entry - Validated YAML entry */
    constructor(entry) { this.#entry = entry }

    /** @returns {string} Friendly name */
    getName() { return this.#entry.name }

    /** @returns {string} AI-facing role description */
    getDescription() { return this.#entry.description ?? '' }

    /** @returns {string} Log category */
    getLogPrefix() { return 'VirtualDevice' }

    /** @returns {boolean} Distinguishes this target from a physical device */
    isVirtual() { return true }

    /** Power-toggle appliance state cannot be inferred from a virtual action.
     * Optional observations report only their named component, after a live monitor check.
     * @returns {Object} Virtual target status */
    getStateSummary() {
        const summary = { device: this.getName(), kind: 'virtual', target_state: 'unknown' }
        if (this.#entry.observations) {
            summary.observations = {}
            for (const [key, source] of Object.entries(this.#entry.observations)) {
                if (source.type === 'network_presence') {
                    summary.observations[key] = NetworkPresence.getLastLabel(source.name) ?? 'unknown'
                }
            }
        }
        return summary
    }

    /** Invoke a configured action and await its local outcome.
     * @param {string} action - Device-style action
     * @param {DeviceCommandSource} [source=DeviceCommandSource.HUMAN] - Initiator
     * @returns {Promise<Object>} Local invocation result */
    async receiveCommand(action, source = DeviceCommandSource.HUMAN) {
        const call = Object.hasOwn(this.#entry.actions, action) ? this.#entry.actions[action] : null
        if (!call) return { device: this.getName(), action, status: 'rejected', error: `Action ${action} is not configured` }
        try {
            let outcome
            if (call.type === 'sequence') {
                const sequence = SequenceContainer.resolveSequence(call.name)
                if (!sequence) throw new Error(`Sequence unavailable: ${call.name}`)
                if (call.phase === 'START_LOOP') {
                    const accepted = await SequenceContainer.startLoop(call.name, { source, caller: 'virtual' })
                    outcome = accepted ? { status: 'started' } : { status: 'rejected', error: 'Sequence busy or loop unavailable' }
                } else if (call.phase === 'STOP_LOOP') {
                    const accepted = SequenceContainer.stopLoop(call.name)
                    outcome = accepted ? { status: 'stop_requested' } : { status: 'rejected', error: 'Sequence is not looping' }
                } else {
                    const accepted = await SequenceContainer.callCommand(call.name, call.phase, { source, caller: 'virtual' })
                    outcome = accepted ? sequence.getLastRunResult() : { status: 'rejected', error: 'Sequence busy or phase unavailable' }
                }
            } else if (call.type === 'automation') {
                if (!AutomationContainer.getAutomation(call.name)) throw new Error(`Automation unavailable: ${call.name}`)
                const invoked = await AutomationContainer.callAutomation(call.name, { trigger: `virtual:${this.getName()}`, ...(call.force ? { force: true } : {}) })
                outcome = invoked ? { status: 'invoked' } : { status: 'rejected', error: 'Automation was not invoked' }
            } else if (call.type === 'interaction') {
                if (!InteractionContainer.getInteraction(call.name)) throw new Error(`Interaction unavailable: ${call.name}`)
                const invoked = await InteractionContainer.callInteraction(call.name, { action: call.action, source })
                outcome = invoked ? { status: 'invoked' } : { status: 'rejected', error: 'Interaction was not invoked' }
            } else if (call.type === 'device') {
                const device = DeviceContainer.findByName(call.name)
                if (!device || typeof device.receiveCommand !== 'function') throw new Error(`Device unavailable: ${call.name}`)
                await device.receiveCommand(call.command, source)
                outcome = { status: 'dispatched' }
            } else {
                outcome = await IRCommandService.send(call.command_id, { source, caller: 'virtual' })
            }
            LoggerService.info(`${this.getName()} ${action} -> ${outcome.status}`, 'VirtualDevice')
            return { device: this.getName(), action, ...outcome }
        } catch (error) {
            LoggerService.warn(`${this.getName()} ${action} failed: ${error.message}`, 'VirtualDevice')
            return { device: this.getName(), action, status: 'rejected', error: error.message }
        }
    }
}

/** Registry isolated from bridge-discovered physical devices. */
class SVirtualDeviceService {
    #devices = new Map()
    #initialized = false
    #signature = null

    /** Load configured virtual targets.
     * @returns {Promise<Object>} Reload result */
    async init() { return this.reload() }

    /** Validate a fresh file before swapping the live registry.
     * @returns {Promise<{ok:boolean,loaded:number,changed?:boolean,error?:string}>} Reload result */
    async reload() {
        try {
            const config = new ConfigBase(ConfigService.getConfigPath('virtual'), 'virtual')
            await config.ensureValidated()
            const next = new Map()
            const entries = config.get('devices', [])
            const usedNames = new Set(Object.keys(DeviceContainer.getAll()).map(normalizeDeviceToolName))
            for (const entry of entries) {
                const toolName = normalizeDeviceToolName(entry.name)
                if (!toolName) throw new Error(`Virtual name cannot be matched by AI tools: ${entry.name}`)
                if (usedNames.has(toolName)) throw new Error(`Virtual name collides with another AI device: ${entry.name}`)
                usedNames.add(toolName)
                const key = entry.name.trim().toLocaleLowerCase()
                next.set(key, new VirtualDevice({ ...entry, name: entry.name.trim() }))
            }
            const signature = JSON.stringify(entries)
            const changed = signature !== this.#signature
            this.#devices = next
            this.#signature = signature
            this.#initialized = true
            LoggerService.info(`${next.size} virtual device(s) loaded`, 'VirtualDeviceService')
            return { ok: true, loaded: next.size, changed }
        } catch (error) {
            LoggerService.warn(`Virtual devices kept unchanged: ${error.message}`, 'VirtualDeviceService')
            this.#initialized = true
            return { ok: false, loaded: this.#devices.size, error: error.message }
        }
    }

    /** @returns {boolean} Whether initialization was attempted */
    isInitialized() { return this.#initialized }

    /** @returns {VirtualDevice[]} Configured targets */
    getAll() { return [...this.#devices.values()] }

    /** Resolve a configured name without fuzzy execution.
     * @param {string} name - Target name
     * @returns {VirtualDevice|null} Target or null */
    findByName(name) { return this.#devices.get(String(name ?? '').trim().toLocaleLowerCase()) ?? null }
}

const VirtualDeviceService = Object.freeze(new SVirtualDeviceService())
export default VirtualDeviceService
