/**
 * Logging service built on Winston.
 *
 * Provides four log levels (`debug`, `info`, `warn`, `error`) routed to both
 * a colorized console transport and separate file transports per level.
 * File paths are configured in {@link ../config/logger.js}.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import process from 'node:process'

import * as winston from 'winston'

import StateService from './stateService.js'
import { buildConsoleTransports } from './logger/consoleTransports.js'

// ---------------------------------------------------------------------------
// SLoggerService (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * Extensible Winston logger wrapper.
 *
 * Provides four log levels (debug, info, warn, error) routed to both
 * a colorized console transport and separate file transports per level.
 * ES module caching guarantees single instantiation.
 *
 * @see {@link https://www.npmjs.com/package/winston}
 */
class SLoggerService {

    #winston

    // -- Lifecycle ----------------------------------------------------

    /**
     * Initialize the Winston logger.
     * 
     * In both UI and headless modes, console transport is always enabled first
     * so startup logs appear directly in the terminal before UI captures it.
     * When UI initializes, call switchToUiMode() to remove the console transport.
     */
    init() {
        // Always start with console + file transports so pre-UI logs are visible
        const transports = buildConsoleTransports()

        this.#winston = winston.createLogger({
            exitOnError: false,
            defaultMeta: { PID: process.pid },
            level: 'debug',  // Capture ALL levels (debug, info, warn, error)
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json(),
                winston.format.errors({ all: true })
            ),
            transports
        })
    }

    /**
     * Remove the console transport after UI has taken over the terminal.
     * Called by main.js bootstrap right after uiInstance.init() succeeds.
     * Leaves only file transports active; UI attaches its own transport via addTransport().
     */
    switchToUiMode() {
        // Remove only the Console transport(s). Using winston.remove() per-transport
        // avoids calling winston.clear() which destroys ALL underlying streams
        // (including File transports) causing "write after end" errors.
        for (const t of [...this.#winston.transports]) {
            if (t.name?.includes('console')) {
                this.#winston.remove(t)
            }
        }
    }

    /**
      * Dynamically attach an additional Winston transport after initialization.
      * Used by the UI to pipe log entries into its log window without race
     * conditions -- called only after the terminal buffer is ready.
     *
     * @param {winston.Transport} transport - A Winston-compatible transport instance
     */
    addTransport(transport) {
        this.#winston.add(transport)
    }

    // -- Public API ---------------------------------------------------

    /**
     * Log at DEBUG level. Visible only when `NODE_ENV` is not `'production'`.
     *
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier (e.g., `"MqttService"`, `"NetworkPresence"`)
     * @returns {SLoggerService} Chainable reference to self
     */
    debug(content, context) {
        this.#winston.debug(content, { context })
        return this
    }

    /**
     * Log at INFO level. Use for lifecycle events (init, shutdown, config loaded).
     *
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier
     * @returns {SLoggerService} Chainable reference to self
     */
    info(content, context) {
        this.#winston.info(content, { context })
        return this
    }

    /**
     * Log at WARN level. Use for recoverable anomalies and degraded state.
     *
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier
     * @returns {SLoggerService} Chainable reference to self
     */
    warn(content, context) {
        this.#winston.warn(content, { context })
        return this
    }

    /**
     * Log at ERROR level. Use for failures requiring attention.
     *
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier
     * @returns {SLoggerService} Chainable reference to self
     */
    error(content, context) {
        this.#winston.error(content, { context })
        return this
    }
}

// Module-level singleton -- ES module caching guarantees single instantiation.
const LoggerService = Object.freeze(new SLoggerService())
export default LoggerService
