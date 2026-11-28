/** Terminal and MQTT controls for the Red Alert scenario.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
'use strict'

import CommandDefinition from './commandDefinition.js'
import RedAlertScenario from '../scenario/redAlertScenario.js'

/** Shared scenario command; available over MQTT only when explicitly allowed.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
export default class ScenarioCommand extends CommandDefinition {
    static name = 'scenario'
    static description = 'Start, stop, or inspect Red Alert'
    static takesArgs = true

    /** Process a scenario command.
     * @param {string} args - Operation, scenario name, and optional warning ID */
    async execute(args) {
        const [operation, name = 'red_alert', warning, extra] = String(args ?? '').trim().split(/\s+/)
        if (name !== 'red_alert' || extra !== undefined || (operation !== 'start' && warning !== undefined)) {
            this.fail('Usage: /scenario status|start|stop red_alert [warning-id for start]')
            return
        }
        const scenario = this.ctx.redAlertScenario ?? RedAlertScenario
        switch (operation || 'status') {
            case 'status':
                this.ctx.print(scenario.isActive() ? 'Red Alert is active' : 'Red Alert is idle')
                break
            case 'start':
                if (scenario.start({ warning })) this.ctx.print('Red Alert start accepted')
                else this.fail('Red Alert start rejected (disabled, disconnected, stopping, or invalid warning)')
                break
            case 'stop':
                this.ctx.print(await scenario.stop() ? 'Red Alert stopped' : 'Red Alert is idle')
                break
            default:
                this.fail('Usage: /scenario status|start|stop red_alert [warning-id for start]')
        }
    }

    /** Offer operation and scenario completions.
     * @param {string[]} tokens - Fully typed tokens
     * @returns {string[]} Completion candidates */
    completeNextToken(tokens = []) {
        return tokens.length === 0 ? ['status', 'start', 'stop'] : tokens.length === 1 ? ['red_alert'] : []
    }
}