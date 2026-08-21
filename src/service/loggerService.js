/**
 * Logging service built on Winston.
 *
 * Provides five log levels (`trace`, `debug`, `info`, `warn`, `error`) routed to
 * a colorized console transport and separate file transports per level. TRACE is
 * file-only by design: it never reaches the console or the UI log window.
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
 * Provides five log levels (trace, debug, info, warn, error) routed to both
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
            // Explicit npm-style ladder with TRACE below DEBUG. The root gate is the
            // lowest level so every entry reaches the transports; each transport then
            // applies its own level filter -- TRACE flows only to the trace-file stream.
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
     * Log at TRACE level. High-volume diagnostic detail routed ONLY to the dedicated
     * trace log file (`logger.path.trace`) -- never shown on the console or in the UI
     * log window, because those transports are gated at `debug`. Use for raw payloads,
     * per-report verdict context, and token lifecycle events that would spam the TUI.
     *
     * @param {string|object} message - Message or structured data to log
     * @param {string} context - Source component identifier
     * @returns {SLoggerService} Chainable reference to self
     */
    trace(content, context) {
        this.#winston.trace(content, { context })
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
