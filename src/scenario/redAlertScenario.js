/** Coordinates the local Red Alert lighting and audio session.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
'use strict'

import { setTimeout as delay } from 'node:timers/promises'

import AutomationContainer from '../automation/container/automationContainer.js'
import DeviceContainer from '../device/container/deviceContainer.js'
import DeviceCommandSource from '../enum/deviceCommandSource.js'
import temporal from '../lib/date.js'
import { hasSound, playSound } from '../lib/soundPlayback.js'
import SequenceContainer from '../sequence/container/sequenceContainer.js'
import ConfigService from '../service/configService.js'
import I18nLoader from '../service/i18nLoader.js'
import LoggerService from '../service/loggerService.js'
import MqttService from '../service/mqttService.js'
import StateService from '../service/stateService.js'
import { claimLights, releaseLights } from './lightOwnership.js'

const LABEL = 'RedAlertScenario'
const STATE_KEY = 'scenario.red_alert.active'
const FALLBACK_WARNING = 'infrastructure-offline'
const DEFAULT_INITIAL_DELAY = '2s'
const DEFAULT_REPEAT_DELAY = '20s'
const MAX_DELAY_MS = 2_147_483_647
const WARNING_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Read a configured timer duration. */
function duration(value, fallback, minimum) {
    const ms = temporal.parseDurationMs(value ?? fallback)
    if (!Number.isInteger(ms) || ms < minimum || ms > MAX_DELAY_MS) throw new Error('Invalid Red Alert warning delay')
    return ms
}

/** One stoppable scenario; dependency overrides allow isolated tests.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
export class SRedAlertScenario {
    #services
    #session = null
    #recovery = null

    /** @param {Object} [services] - Optional scenario dependency overrides */
    constructor(services = {}) {
        this.#services = {
            config: () => ConfigService.get('scenarios.red_alert'),
            locale: () => I18nLoader.getLocale(),
            sequence: name => SequenceContainer.resolveSequence(name),
            device: name => DeviceContainer.findByName(name),
            hasAutomation: name => Boolean(AutomationContainer.getAutomation(name)),
            restore: name => AutomationContainer.callAutomation(name, { trigger: 'red_alert', force: true }),
            connected: () => MqttService.isConnected(),
            hasSound,
            playSound,
            delay,
            ...services
        }
    }

    /** Start a session, or add a cause without restarting a running session.
     * @param {{warning?: string, host?: string, recovery_warning?: string}} [request] - Local clip IDs and optional network cause
     * @returns {boolean} Whether the request was accepted */
    start({ warning, host, recovery_warning: recoveryWarning } = {}) {
        const config = this.#services.config()
        if (config?.enabled !== true || !this.#services.connected() || StateService.get('lifecycle.shuttingDown')) return false
        if (warning !== undefined && (typeof warning !== 'string' || !WARNING_ID.test(warning))) return false
        const recoveryId = typeof recoveryWarning === 'string' && WARNING_ID.test(recoveryWarning) ? recoveryWarning : undefined
        if (this.#session) {
            if (this.#session.controller.signal.aborted) return false
            if (host) this.#session.hosts.set(host.toLowerCase(), recoveryId)
            return true
        }

        this.#recovery?.controller.abort()
        const session = { controller: new AbortController(), hosts: new Map(host ? [[host.toLowerCase(), recoveryId]] : []) }
        this.#session = session
        StateService.set(STATE_KEY, true)
        session.done = this.#run(session, config, warning).catch(error => {
            LoggerService.error(error.message, LABEL)
        }).finally(() => {
            this.#session = null
            StateService.delete(STATE_KEY)
        })
        return true
    }

    /** Stop and wait for the lighting handoff.
     * @returns {Promise<boolean>} Whether a session was stopped */
    async stop() {
        const session = this.#session
        const recovery = this.#recovery
        if (!session && !recovery) return false
        recovery?.controller.abort()
        session?.controller.abort()
        await Promise.all([session?.done, recovery?.done])
        return true
    }

    /** Clear one outage; stop when the final network cause recovers.
     * @param {string} host - Recovered network name
     * @returns {Promise<boolean>} Whether recovery stopped the session */
    async recover(host) {
        const session = this.#session
        if (!session || session.controller.signal.aborted) return false
        const key = host.toLowerCase()
        const clipId = session.hosts.get(key)
        if (!session.hosts.delete(key) || session.hosts.size) return false
        session.controller.abort()
        if (!clipId) {
            await session.done
            return true
        }

        const recovery = { controller: new AbortController() }
        this.#recovery = recovery
        const { signal } = recovery.controller
        recovery.done = session.done.then(async () => {
            if (signal.aborted || !session.cleanedUp || StateService.get('lifecycle.shuttingDown')) return
            const filename = `red-alert.${this.#services.locale()}.${clipId}.wav`
            if (await this.#services.hasSound(filename) && !signal.aborted) {
                await this.#services.playSound(filename, { signal })
            }
        }).catch(error => {
            if (!signal.aborted) LoggerService.warn(`Red Alert recovery warning failed: ${error.message}`, LABEL)
        }).finally(() => {
            if (this.#recovery === recovery) this.#recovery = null
        })
        await recovery.done
        return true
    }

    /** @returns {boolean} Whether a session is starting, running or stopping */
    isActive() {
        return this.#session !== null
    }

    /** Validate local prerequisites before touching lights.
     * @private
     * @param {Object} config - Scenario settings
     * @param {string|undefined} warning - Requested clip ID
     * @param {AbortSignal} signal - Session lifetime */
    async #prepare(config, warning, signal) {
        const services = this.#services
        const sequence = services.sequence(config.light_sequence)
        const patternDevices = sequence?.getPatternDevices()
        if (!patternDevices?.length || sequence.isActive()) throw new Error('Red Alert needs an idle, continuous light sequence')
        const devices = new Map()
        for (const name of config.lights ?? patternDevices) {
            const device = services.device(name)
            if (!device) throw new Error(`Red Alert light not found: ${name}`)
            devices.set(device.getName(), device)
        }
        if (patternDevices.some(name => !devices.has(services.device(name)?.getName()))) {
            throw new Error('Red Alert light group must contain every pattern light')
        }
        const restore = config.restore_automation
        if (!restore || !services.hasAutomation(restore)) throw new Error('Red Alert restore automation not found')

        const alarm = config.audio?.alarm_file
        if (!await services.hasSound(alarm)) throw new Error('Red Alert alarm file or player is missing')
        const initialDelay = duration(config.audio?.warning_initial_delay, DEFAULT_INITIAL_DELAY, 0)
        const repeatDelay = duration(config.audio?.warning_repeat_delay, DEFAULT_REPEAT_DELAY, 1)
        const locale = services.locale()
        let clip
        if (warning) {
            for (const id of new Set([warning, FALLBACK_WARNING])) {
                signal.throwIfAborted()
                const filename = `red-alert.${locale}.${id}.wav`
                if (await services.hasSound(filename)) {
                    clip = filename
                    break
                }
            }
            if (!clip) LoggerService.warn(`No local Red Alert warning for ${warning} (${locale}); using alarm only`, LABEL)
        }
        return { sequence, devices, restore, alarm, clip, initialDelay, repeatDelay }
    }

    /** Own and supervise both audio branches and the device sequence.
     * @private
     * @param {Object} session - Active session
     * @param {Object} config - Scenario settings
     * @param {string|undefined} warning - Requested clip ID */
    async #run(session, config, warning) {
        const { controller } = session
        const { signal } = controller
        let prepared, lease
        const tasks = []
        try {
            prepared = await this.#prepare(config, warning, signal)
            signal.throwIfAborted()
            if (!this.#services.connected()) throw new Error('Red Alert needs a connected MQTT broker at startup')
            const { sequence, devices, alarm, clip, initialDelay, repeatDelay } = prepared
            lease = claimLights([...devices.keys()], signal)
            await this.#blackout(devices, lease)
            signal.throwIfAborted()
            if (!await sequence.startLoop({ lightLease: lease })) throw new Error('Red Alert light loop could not start')
            tasks.push(sequence.waitForLoop().then(() => {
                if (!signal.aborted) throw new Error('Red Alert light loop ended unexpectedly')
            }))
            tasks.push(this.#repeat(alarm, 0, 0, signal))
            const required = [...tasks]
            if (clip) tasks.push(this.#repeat(clip, initialDelay, repeatDelay, signal).catch(error => {
                if (!signal.aborted) LoggerService.warn(`Red Alert warning stopped: ${error.message}`, LABEL)
            }))
            LoggerService.info('Red Alert started', LABEL)
            await Promise.race(required)
        } catch (error) {
            if (!signal.aborted) throw error
        } finally {
            controller.abort()
            await Promise.allSettled(tasks)
            if (lease) {
                releaseLights(lease)
                // Clear hazard brightness before policy re-evaluation. Unmatched lights stay off.
                try {
                    await this.#blackout(prepared.devices)
                } finally {
                    if (!await this.#services.restore(prepared.restore)) LoggerService.warn('Red Alert lighting handoff was not accepted', LABEL)
                }
                LoggerService.info('Red Alert stopped', LABEL)
                session.cleanedUp = true
            }
        }
    }

    /** Queue a forced OFF for each claimed lighting mechanism.
     * @private
     * @param {Map} devices - Lighting group
     * @param {Object} [lease] - Authorization while claimed */
    async #blackout(devices, lease) {
        const writes = []
        for (const device of devices.values()) {
            if (lease?.signal.aborted) break
            writes.push((async () => device.receiveCommand('OFF', DeviceCommandSource.AUTOMATION, {
                bypassNoOpSuppression: true,
                ...(lease ? { lightLease: lease } : {})
            }))())
        }
        const results = await Promise.allSettled(writes)
        const failure = results.find(result => result.status === 'rejected')
        if (failure) throw failure.reason
    }

    /** Repeat a clip without ever overlapping it with itself.
     * @private
     * @param {string} file - Asset basename
     * @param {number} initialDelay - Delay before first playback in milliseconds
     * @param {number} repeatDelay - Delay between completed plays in milliseconds
     * @param {AbortSignal} signal - Session lifetime */
    async #repeat(file, initialDelay, repeatDelay, signal) {
        const services = this.#services
        if (initialDelay) await services.delay(initialDelay, undefined, { signal })
        while (!signal.aborted) {
            await services.playSound(file, { signal })
            if (repeatDelay) await services.delay(repeatDelay, undefined, { signal })
        }
    }
}

const RedAlertScenario = Object.freeze(new SRedAlertScenario())
export default RedAlertScenario