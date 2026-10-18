/**
 * Sequence Base Class.
 * Ordered device choreography with a blocking mutex and an optional loop
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceContainer from '../../device/container/deviceContainer.js'
import StateService from '../../service/stateService.js'
import LoggerService from '../../service/loggerService.js'
import TimedAction from '../../lib/timedAction.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'
import { slugify } from '../../lib/string.js'
import temporal from '../../lib/date.js'
import { normalizeSequenceConfig } from '../../lib/configMigration.js'


//  SequenceBase class.

/** One sequence instance: ordered steps + blocking run core + optional loop driver. */
class SequenceBase {

    /** Friendly name from config. */
    #name
    /** Registry / state key -- slugify(name), e.g. 'Salon Hazard Light' -> salon_hazard_light. */
    #slug
    /** Raw normalized entry object as loaded from YAML. */
    #config
    /** Resolved ON steps: [{deviceName, payload, delayMs}]. */
    #stepsOn = []
    /** Same shape for OFF runs. */
    #stepsOff = []
    /** Sequence-level inter-step delay (ms); 0 = multi-device endpoint mode. */
    #defaultDelayMs = 0
    /** Loop option: {cycle: 'once'|'continuous', offDelayMs/onDelayMs: number|null(auto)} or null. */
    #loopConfig = null
    /** Referenced devices resolved in init(): Map<deviceName, deviceInstance>. */
    #devices = new Map()
    /** Mutex: true while any run (single or loop phase) is active. */
    #busy = false
    /** A loop session is engaged (survives across phases incl. timer wait). */
    #loopActive = false
    /** Set by stopLoop(); checked between cycles/phases. */
    #stopRequested = false
    /** TimedAction guarding the inter-phase slot. */
    #phaseTimer = null
    /** Resolver unblocking the driver when the inter-phase timer fires or is cancelled. */
    #interPhaseResolver = null


    /** Create a sequence instance from one validated YAML entry; normalizes steps + durations.
     * @param {string} name - Friendly name from config (`name:` field)
     * @param {Object} [config={}] - Raw normalized entry object (devices/on/off/delay/loop) */
    constructor(name, config = {}) {
        this.#name = String(name ?? '').trim()
        this.#slug = slugify(this.#name || 'sequence')
        this.#config = normalizeSequenceConfig(config && typeof config === 'object' ? config : {})

        //  Sequence-level pacing -- fully optional (absent => endpoint mode, D5).
        if (this.#config.delay !== undefined) {
            const parsed = temporal.parseDurationMs(this.#config.delay)
            if (parsed === null) {
                LoggerService.warn(`Sequence "${this.#name}": invalid delay "${this.#config.delay}" -- treating as absent`, 'SequenceBase')
            } else {
                this.#defaultDelayMs = parsed
            }
        }

        //  Loop option -- present only when the entry carries an enabled loop block.
        const loopRaw = this.#config.loop
        if (loopRaw && typeof loopRaw === 'object' && loopRaw.enabled === true) {
            let cycle = typeof loopRaw.cycle === 'string' ? loopRaw.cycle.trim().toLowerCase() : 'once'
            if (!['once', 'continuous'].includes(cycle)) {
                LoggerService.warn(`Sequence "${this.#name}": invalid loop.cycle "${loopRaw.cycle}" -- defaulting to "once"`, 'SequenceBase')
                cycle = 'once'
            }
            const parseGap = (value, label) => {
                //  null = auto: that phase starts right when the previous one finishes.
                if (value === undefined || String(value).trim().toLowerCase() === 'auto') return null
                const parsed = temporal.parseDurationMs(value)
                if (parsed === null) {
                    LoggerService.warn(`Sequence "${this.#name}": invalid loop.${label} "${value}" -- treating as auto`, 'SequenceBase')
                    return null
                }
                return parsed
            }
            const offDelayMs = parseGap(loopRaw.off_delay, 'off_delay')   // gap before OFF runs
            const onDelayMs = parseGap(loopRaw.on_delay, 'on_delay')     // gap before ON runs
            this.#loopConfig = { cycle, offDelayMs, onDelayMs }
        }

        this.#phaseTimer = new TimedAction(`sequence:${this.#slug}`)
        this.#normalizeSteps()
    }

    //  -- Lifecycle ----------------------------------------------------------

    /** Resolve every referenced device through DeviceContainer; missing devices make their
     * steps inert with a warning (D10), and stale state keys are cleared for a fresh process.
     * @async */
    async init() {
        const names = [...new Set([...this.#stepsOn, ...this.#stepsOff].map(s => s.deviceName))]
        for (const name of names) {
            let device = null
            try {
                device = DeviceContainer.findByName(name)
            } catch (err) {
                LoggerService.warn(`Sequence "${this.#name}": lookup failed for "${name}": ${err.message}`, 'SequenceBase')
            }
            if (!device) {
                LoggerService.warn(`Sequence "${this.#name}": device "${name}" not found -- its steps will be inert`, 'SequenceBase')
            } else {
                this.#devices.set(name, device)
            }
        }

        //  Fresh-process clean slate: stale keys from a previous run are cleared (D11).
        StateService.delete(this.#stateKey('active'))
        StateService.delete(this.#stateKey('phase'))
        StateService.delete(this.#stateKey('loop.active'))
    }

    /** Cancel timers and clear state keys (called by the container on shutdown). An in-flight
     * step-list always finishes first; nothing is aborted mid-step. */
    cleanup() {
        this.#stopRequested = true
        if (this.#phaseTimer.isActive()) {
            this.#phaseTimer.stop()
            const resolver = this.#interPhaseResolver
            this.#interPhaseResolver = null
            if (resolver) resolver()
        }
        StateService.delete(this.#stateKey('active'))
        StateService.delete(this.#stateKey('phase'))
        StateService.delete(this.#stateKey('loop.active'))
    }

    //  -- Identity & status ---------------------------------------------------

    /** Friendly name as configured.
     * @returns {string} */
    getName() {
        return this.#name
    }

    /** Internal registry / state key derived with slugify().
     * @returns {string} */
    getSlug() {
        return this.#slug
    }

    /** True while any run (single or loop phase) occupies the mutex.
     * @returns {boolean} */
    isActive() {
        return this.#busy
    }

    /** True while a loop session is engaged (survives across phases incl. timer wait).
     * @returns {boolean} */
    isLoopActive() {
        return this.#loopActive
    }

    /** Compact live-status snapshot for UI / AI / status reporting.
     * @returns {{name: string, slug: string, active: boolean, phase: ('on'|'off'|null), loopActive: boolean}} */
    getStateSummary() {
        const phase = StateService.get(this.#stateKey('phase'))
        return {
            name: this.#name,
            slug: this.#slug,
            active: this.#busy,
            phase: (phase === 'on' || phase === 'off') ? phase : null,
            loopActive: this.#loopActive
        }
    }

    //  -- Run core -------------------------------------------------------------

    /** The blocking core: walk the ordered step list for the given action, pacing steps with
     * their per-step delay (falling back to the sequence-level `delay`). Concurrent invocations
     * are rejected and logged, never queued, never overridden (D7).
     * @param {'ON'|'OFF'} [command='ON'] - Action to send down the sequence
     * @returns {Promise<boolean>} true when the run executed; false when rejected by the mutex */
    async run(command = 'ON') {
        const action = String(command ?? '').toUpperCase()
        if (action !== 'ON' && action !== 'OFF') {
            LoggerService.warn(`Sequence "${this.#name}": invalid command "${command}" (expected ON|OFF)`, 'SequenceBase')
            return false
        }
        if (this.#busy || this.#loopActive) {
            LoggerService.warn(`Sequence "${this.#name}" is already running -- ${action} ignored`, 'SequenceBase')
            return false
        }

        this.#busy = true
        StateService.set(this.#stateKey('active'), true)
        StateService.set(this.#stateKey('phase'), action.toLowerCase())
        try {
            await this.#executeSteps(action)
        } finally {
            this.#busy = false
            StateService.delete(this.#stateKey('active'))
            StateService.delete(this.#stateKey('phase'))
        }
        return true
    }

    //  -- Loop state machine -----------------------------------------------------

    /** Start a loop session for this instance (public API for CLI / AI tool calls). Rejected with
     * false + warn log when no `loop:` block is configured or the instance is already busy/looping.
     * @returns {Promise<boolean>} true when the loop started; false when rejected */
    async startLoop() {
        if (!this.#loopConfig) {
            LoggerService.warn(`Sequence "${this.#name}" has no loop configured -- cannot start loop`, 'SequenceBase')
            return false
        }
        if (this.#busy || this.#loopActive) {
            LoggerService.warn(`Sequence "${this.#name}" is already running/looping -- loop start ignored`, 'SequenceBase')
            return false
        }

        this.#stopRequested = false
        this.#loopActive = true
        //  The driver keeps the mutex held across phases incl. the inter-phase window, so an
        //  engaged loop also blocks external runs via #busy alone (D7).
        this.#busy = true
        StateService.set(this.#stateKey('loop.active'), true)

        void this.#driveLoop().catch(err => {
            LoggerService.error(`Sequence "${this.#name}": loop crashed: ${err.message}`, 'SequenceBase')
            this.#exitLoop()
        })
        return true
    }

    /** Graceful stop per D6: set the stop flag; between phases cancel the timer and go straight
     * to IDLE; mid-phase let that step-list finish, then exit without starting further work.
     * @returns {boolean} true when a stop was requested; false when nothing to stop */
    stopLoop() {
        if (!this.#loopActive) return false
        this.#stopRequested = true
        if (this.#phaseTimer.isActive()) {
            //  Between phases -- cancel the armed inter-phase timer; the driver exits to IDLE now.
            this.#phaseTimer.stop()
            const resolver = this.#interPhaseResolver
            this.#interPhaseResolver = null
            if (resolver) resolver()
        }
        LoggerService.info(`Sequence "${this.#name}": loop stop requested`, 'SequenceBase')
        return true
    }

    //  -- Internals ---------------------------------------------------------------

    /** Build #stepsOn / #stepsOff from either config form. Simple `devices:` entries derive bare
     * ON/OFF payloads (per-step `command` overrides the ON payload only); rich `on:`/`off:` steps
     * carry verbatim payloads; a missing `off:` defaults to plain OFF over the `on` devices.
     * @private */
    #normalizeSteps() {
        const parseDelayMs = (value, label) => {
            if (value === undefined || value === null) return 0
            const parsed = temporal.parseDurationMs(value)
            if (parsed === null) {
                LoggerService.warn(`Sequence "${this.#name}": invalid ${label} "${value}" -- treating as absent`, 'SequenceBase')
                return 0
            }
            return parsed
        }

        const buildStep = (entry, index, fallbackPayload) => {
            let deviceName = ''
            let payload = null
            let delayMs = 0
            if (typeof entry === 'string') {
                deviceName = entry.trim()
            } else if (entry && typeof entry === 'object') {
                deviceName = String(entry.device ?? '').trim()
                payload = entry.payload !== undefined ? entry.payload : (entry.command !== undefined ? entry.command : null)
                delayMs = parseDelayMs(entry.delay, `step[${index}] delay`)
            }
            if (!deviceName) {
                LoggerService.warn(`Sequence "${this.#name}": step[${index}] has no device name -- skipped`, 'SequenceBase')
                return null
            }
            return { deviceName, payload: payload ?? fallbackPayload, delayMs }
        }

        this.#stepsOn = []
        this.#stepsOff = []

        if (Array.isArray(this.#config.devices)) {
            for (let i = 0; i < this.#config.devices.length; i++) {
                const onStep = buildStep(this.#config.devices[i], i, 'ON')
                if (onStep) {
                    this.#stepsOn.push(onStep)
                    //  Simple-form OFF runs always send plain OFF over the same ordered devices.
                    this.#stepsOff.push({ ...onStep, payload: 'OFF' })
                }
            }
        } else if (Array.isArray(this.#config.on)) {
            for (let i = 0; i < this.#config.on.length; i++) {
                const onStep = buildStep(this.#config.on[i], i, 'ON')
                if (onStep) this.#stepsOn.push(onStep)
            }
            if (Array.isArray(this.#config.off)) {
                for (let i = 0; i < this.#config.off.length; i++) {
                    const offStep = buildStep(this.#config.off[i], i, 'OFF')
                    if (offStep) this.#stepsOff.push(offStep)
                }
            } else {
                for (const step of this.#stepsOn) {
                    this.#stepsOff.push({ deviceName: step.deviceName, payload: 'OFF', delayMs: step.delayMs })
                }
            }
        }
    }

    /** Walk one phase's step list, sending each resolved device its payload via receiveCommand()
     * with AUTOMATION provenance (D9). Inert steps are skipped silently (warned at init); pacing
     * delays apply only between steps, never after the last one.
     * @private
     * @param {'ON'|'OFF'} action - Phase action (selects the step list + fallback payload) */
    async #executeSteps(action) {
        const steps = action === 'OFF' ? this.#stepsOff : this.#stepsOn
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i]
            const device = this.#devices.get(step.deviceName)
            if (!device) continue   // inert step -- already warned at init (D10)
            try {
                device.receiveCommand(step.payload ?? action, DeviceCommandSource.AUTOMATION)
            } catch (err) {
                LoggerService.warn(`Sequence "${this.#name}": command failed on "${step.deviceName}": ${err.message}`, 'SequenceBase')
            }
            const delay = step.delayMs > 0 ? step.delayMs : this.#defaultDelayMs
            if (delay > 0 && i < steps.length - 1) await this.#sleep(delay)
        }
    }

    /** Loop driver: ON run -> optional gap -> OFF run -> optional gap -> repeat per cycle config.
     * A stop request checked between phases exits to IDLE without starting further work; an armed
     * inter-phase timer is cancelled by stopLoop()/cleanup(). @private */
    async #driveLoop() {
        while (true) {
            //  Yield one event-loop tick each cycle: with all-zero delays every await resolves as a
            //  microtask, which would starve timers/IO/UI and make stop requests unresponsive.
            await this.#sleep(0)
            StateService.set(this.#stateKey('active'), true)
            StateService.set(this.#stateKey('phase'), 'on')
            await this.#executeSteps('ON')
            if (this.#stopRequested) break

            const offDelayMs = this.#loopConfig.offDelayMs
            if (offDelayMs !== null && offDelayMs > 0) {
                await this.#interPhaseWait(offDelayMs)
                if (this.#stopRequested) break
            }

            StateService.set(this.#stateKey('phase'), 'off')
            await this.#executeSteps('OFF')
            if (this.#stopRequested) break
            if (this.#loopConfig.cycle !== 'continuous') break

            //  Gap before the next ON run -- continuous cycles only; same graceful-stop semantics as
            //  the OFF-side gap (a stop in flight cancels it and exits straight to IDLE).
            const onDelayMs = this.#loopConfig.onDelayMs
            if (onDelayMs !== null && onDelayMs > 0) {
                await this.#interPhaseWait(onDelayMs)
                if (this.#stopRequested) break
            }
        }
        this.#exitLoop()
    }

    /** Wait out the configured inter-phase gap with the TimedAction guarding the slot; resolves
     * when the timer fires or when stopLoop()/cleanup() cancels it early.
     * @private
     * @param {number} durationMs - Inter-phase gap in ms (either side) */
    #interPhaseWait(durationMs) {
        return new Promise(resolve => {
            this.#interPhaseResolver = resolve
            const started = this.#phaseTimer.start(durationMs, () => {
                const resolver = this.#interPhaseResolver
                this.#interPhaseResolver = null
                if (resolver) resolver()
            })
            if (!started) {
                //  Slot unexpectedly occupied -- degrade to auto so the loop never stalls.
                LoggerService.warn(`Sequence "${this.#name}": inter-phase timer slot busy -- continuing without gap`, 'SequenceBase')
                this.#interPhaseResolver = null
                resolve()
            }
        })
    }

    /** IDLE transition: release mutex/flags/timer and clear all state keys for this slug.
     * @private */
    #exitLoop() {
        this.#busy = false
        this.#loopActive = false
        this.#stopRequested = false
        if (this.#phaseTimer.isActive()) {
            this.#phaseTimer.stop()
            const resolver = this.#interPhaseResolver
            this.#interPhaseResolver = null
            if (resolver) resolver()
        }
        StateService.delete(this.#stateKey('active'))
        StateService.delete(this.#stateKey('phase'))
        StateService.delete(this.#stateKey('loop.active'))
    }

    /** Sleep helper for step pacing.
     * @private
     * @param {number} ms - Delay in milliseconds */
    #sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /** Build a StateService key under the `sequence.<slug>` prefix (D8).
     * @private
     * @param {string} suffix - Key suffix ('active', 'phase' or 'loop.active')
     * @returns {string} */
    #stateKey(suffix) {
        return `sequence.${this.#slug}.${suffix}`
    }
}

export default SequenceBase