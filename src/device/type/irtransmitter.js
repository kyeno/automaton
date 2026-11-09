/**
 * Zigbee IR transmitter with event-based outgoing commands and ordinary incoming telemetry.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import Mechanism from './mechanism.js'
import IRCommandService from '../../ir/irCommandService.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'
import { exposedProperties } from '../../lib/deviceClassification.js'
import { isIRCode } from '../../validators/ir.js'

/** Fire-and-forget IR actuator; no appliance state is inferred from transmissions. */
export default class IRTransmitter extends Mechanism {
    /** Telemetry is not evidence of human/automation changes to the controlled appliance.
     * @returns {boolean} False */
    shouldTrackOrigin() {
        return false
    }

    /** Device type label.
     * @returns {string} Log prefix */
    getLogPrefix() {
        return 'IRTransmitter'
    }

    /** Resolve the wire field from explicit configuration or known bridge exposes.
     * @returns {string} Send-code field
     * @throws {Error} When the protocol has not been identified */
    getSendProperty() {
        const data = this.getData() ?? {}
        const property = data.ir_send_property
            ?? exposedProperties(data).find(name => name === 'ir_code_to_send')
        if (typeof property !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(property)) {
            throw new Error(`Configure ir_send_property for IR transmitter ${this.getName()}`)
        }
        return property
    }

    /** Dispatch a code through the normal MQTT queue without state correlation or suppression.
     * @param {string} code - Opaque Base64 code
     * @param {Object} [context={}] - Command ID, source and caller for logging
     * @returns {Promise<void>} Resolves at local MQTT dispatch, not appliance confirmation */
    async transmit(code, context = {}) {
        if (!isIRCode(code)) throw new Error('IR code must be non-empty Base64')
        const property = this.getSendProperty()
        this.log(`Sending IR command ${context.commandId ?? '(raw)'} source=${context.source ?? DeviceCommandSource.HUMAN}`)
        const prefix = process.env.MQTT_PREFIX || 'zigbee2mqtt'
        await this.publishAsync(`${prefix}/${this.getName()}/set`, JSON.stringify({ [property]: code }))
    }

    /** Accept only explicit named IR commands; ordinary state writes are invalid.
     * @param {Object} command - Envelope containing ir_command
     * @param {string} [source=DeviceCommandSource.HUMAN] - Initiating source
     * @returns {Promise<Object>} Dispatch result */
    async receiveCommand(command, source = DeviceCommandSource.HUMAN) {
        if (!command || typeof command !== 'object' || typeof command.ir_command !== 'string'
            || Object.keys(command).length !== 1) {
            throw new Error('IRTransmitter expects { ir_command: command_id }')
        }
        return IRCommandService.send(command.ir_command, { source, transmitter: this.getName() })
    }
}
