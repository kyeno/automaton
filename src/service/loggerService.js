/**
 * Logging service built on Winston.
 * Provides five log levels (`trace`, `debug`, `info`, `warn`
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import process from 'node:process'

import * as winston from 'winston'

import StateService from './stateService.js'
import { buildConsoleTransports } from './logger/consoleTransports.js'

//  SLoggerService (module-level singleton)

/** Extensible Winston logger wrapper.
 * @see {@link https://www.npmjs.com/package/winston} */
class SLoggerService {

    #winston

    //  -- Lifecycle ----------------------------------------------------

    /** Initialize the Winston logger. */
    init() {
        //  Always start with console + file transports so pre-UI logs are visible.
        const transports = buildConsoleTransports()

        this.#winston = winston.createLogger({
            exitOnError: false,
            defaultMeta: { PID: process.pid },
            //  Explicit npm-style ladder with TRACE below DEBUG. The root gate.
            levels: { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, trace: 6 },
            level: 'trace',  // Capture ALL levels (trace through error); routing is per-transport
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json(),
                winston.format.errors({ all: true })
            ),
            transports
        })
    }

    /** Remove the console transport after UI has taken over the terminal. */
    switchToUiMode() {
        //  Remove only the Console transport(s). Using winston.remove() per-transport.
        for (const t of [...this.#winston.transports]) {
            if (t.name?.includes('console')) {
                this.#winston.remove(t)
            }
        }
    }

    /** Dynamically attach an additional Winston transport after initialization.
     * @param {winston.Transport} transport - A Winston-compatible transport instance */
    addTransport(transport) {
        this.#winston.add(transport)
    }

    //  -- Public API ---------------------------------------------------

    /** Log at DEBUG level. Visible only when `NODE_ENV` is not `'production'`.
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier (e.g., `"MqttService"`, `"NetworkPresence"`)
     * @returns {SLoggerService} Chainable reference to self */
    debug(content, context) {
        this.#winston.debug(content, { context })
        return this
    }

    /** Log at TRACE level. High-volume diagnostic detail routed ONLY to the dedicated.
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier
     * @returns {SLoggerService} Chainable reference to self */
    trace(content, context) {
        this.#winston.trace(content, { context })
        return this
    }

    /** Log at INFO level. Use for lifecycle events (init, shutdown, config loaded).
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier
     * @returns {SLoggerService} Chainable reference to self */
    info(content, context) {
        this.#winston.info(content, { context })
        return this
    }

    /** Log at WARN level. Use for recoverable anomalies and degraded state.
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier
     * @returns {SLoggerService} Chainable reference to self */
    warn(content, context) {
        this.#winston.warn(content, { context })
        return this
    }

    /** Log at ERROR level. Use for failures requiring attention.
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier
     * @returns {SLoggerService} Chainable reference to self */
    error(content, context) {
        this.#winston.error(content, { context })
        return this
    }
}

//  Module-level singleton -- ES module caching guarantees single instantiation.
const LoggerService = Object.freeze(new SLoggerService())
export default LoggerService
