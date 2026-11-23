/** Headless command contract shared by terminal and MQTT adapters.
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
'use strict'

/** Command metadata, completion and request-local output collection. */
export default class CommandDefinition {
    /** Inject the services and output sink for this invocation.
     * @param {Object} ctx - Request-local dependencies */
    constructor(ctx = {}) {
        this.ctx = ctx
        this.status = 'ok'
    }

    /** Report a failure without coupling it to a rendering adapter.
     * @param {string} message - Human-readable explanation */
    fail(message) {
        this.status = 'failed'
        this.ctx.print(message)
    }

    /** Run with isolated output; concurrent requests never share a print sink.
     * @param {string} args - Raw command arguments
     * @param {Object} ctx - Services and caller metadata
     * @returns {Promise<Object>} Structured status and output */
    static async run(args, ctx = {}) {
        const lines = []
        const command = new this({ ...ctx, print: line => lines.push(String(line)) })
        try {
            await command.execute(args)
        } catch (error) {
            command.fail(error.message)
        }
        return { status: command.status, lines }
    }
}