/** MQTT adapter for the shared headless command library.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
'use strict'

import ConfigService from '../service/configService.js'
import MqttService from '../service/mqttService.js'
import SequenceContainer from '../sequence/container/sequenceContainer.js'
import IRCommand from '../commands/irCommand.js'
import SequenceCommand from '../commands/sequenceCommand.js'
import OccupancyCommand from '../commands/occupancyCommand.js'
import { VERSION, decodeFrame, RequestCache } from './controlProtocol.js'

const COMMANDS = { ir: IRCommand, sequence: SequenceCommand, occupancy: OccupancyCommand }

/** One globally configured command surface; possession of the key grants access. */
export class SControlService {
    #unsubscribe
    #cache = new RequestCache()
    #config = {}
    #key = ''
    #generation = 0

    /** Read configuration and subscribe, including in --no-ui deployments. */
    async init() {
        await this.reload()
    }

    /** Replace the configured subscription without carrying commands across reloads.
     * @returns {Promise<void>} Completion */
    async reload() {
        this.cleanup()
        const config = ConfigService.getSection('mqtt_control') ?? {}
        this.#config = config
        this.#key = process.env[config.secret_env] ?? ''
        if (config.enabled !== true || !this.#key) return
        this.#unsubscribe = MqttService.subscribe(`${config.topic_base ?? 'automaton/control'}/command`,
            (topic, text, packet) => { void this.handle(text, packet).catch(() => {}) }, { dedupe: false })
    }

    /** Stop accepting commands before dependent services are torn down. */
    cleanup() {
        this.#generation++
        this.#unsubscribe?.()
        this.#unsubscribe = undefined
    }

    /** Authenticate, deduplicate and execute a single request.
     * @param {string} text - JSON request
     * @param {Object} packet - MQTT delivery metadata
     * @returns {Promise<void>} Reply publication */
    async handle(text, packet = {}) {
        const data = decodeFrame(text)
        if (!this.#unsubscribe || packet?.retain || !MqttService.isConnected()) return
        if (!data || data.v !== VERSION || data.key !== this.#key || !this.#cache.claim(data.id)) return
        const generation = this.#generation
        const verb = data.command
        const args = typeof data.args === 'string' ? data.args.trim() : ''
        const sub = args.split(/\s+/)[0] || 'list'
        const allowed = this.#config.commands?.[verb]
        let result = { status: 'rejected', lines: ['Command or operation is not enabled'] }
        if (Object.hasOwn(COMMANDS, verb) && Array.isArray(allowed) && allowed.includes(sub)) {
            result = await COMMANDS[verb].run(args, { sequenceContainer: SequenceContainer, caller: 'mqtt' })
        }
        if (generation !== this.#generation || !MqttService.isConnected()) return
        await MqttService.publishControl(`${this.#config.topic_base ?? 'automaton/control'}/reply`,
            { v: VERSION, id: data.id, ...result })
    }
}

export default Object.freeze(new SControlService())