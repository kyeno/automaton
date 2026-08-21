/**
 * Console Transport Profile for LoggerService.
 *
 * Used when UI is disabled (--no-ui). Includes a colorized Console transport
 * plus file transports for debug, warn, and trace levels. This is the "headless"
 * mode where logs go directly to stdout. TRACE stays file-only in both modes.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'
import process from 'node:process'

import * as winston from 'winston'

import ConfigService from '../configService.js'
import StateService from '../stateService.js'
import { PROJECT_ROOT } from '../../lib/projectRoot.js'

const TIMESTAMP_FORMAT = 'YYYY-MM-DD HH:mm:ss.SSS A'

/**
 * Exact-match TRACE filter. Winston transport `level` options are LOWER BOUNDS, so
 * without this an entry at any level would pass through -- dropping everything but
 * trace keeps the dedicated stream strictly diagnostic-detail only.
 */
const TRACE_ONLY_FORMAT = new (winston.format(info => info.level === 'trace' ? info : null))()

/**
 * Map snake_case config keys to Winston transport option names (file transport).
 * @param {object} [cfg] - Raw configuration object from YAML
 * @returns {object} Normalized options compatible with Winston File transport
 */
function normalizeFileConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return {}
    const { max_size, max_files, ...rest } = cfg
    return {
        ...(max_size !== undefined ? { maxsize: max_size } : {}),
        ...(max_files !== undefined ? { maxFiles: max_files } : {}),
        ...rest
    }
}

/**
 * Map snake_case config keys to Winston transport option names (console transport).
 * @param {object} [cfg] - Raw configuration object from YAML
 * @returns {object} Normalized options compatible with custom Console transport
 */
function normalizeConsoleConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return {}
    const { console_warn_levels, stderr_levels, ...rest } = cfg
    return {
        ...(console_warn_levels !== undefined ? { consoleWarnLevels: console_warn_levels } : {}),
        ...(stderr_levels !== undefined ? { stderrLevels: stderr_levels } : {}),
        ...rest
    }
}

/**
 * Build Winston transports for console (headless) mode.
 * @returns {winston.Transport[]} Array of transport instances
 */
export function buildConsoleTransports() {
    const loggerConfig = ConfigService.getSection('logger')
    const fileCfg = normalizeFileConfig(loggerConfig?.file)
    const consoleCfg = normalizeConsoleConfig(loggerConfig?.console)
    const onProduction = process.env.NODE_ENV === 'production'

    const consoleFormat = winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.timestamp({ format: TIMESTAMP_FORMAT }),
        winston.format.printf(({ PID, level, message, context, timestamp }) => {
            const colorizedContext = `\u001b[33m[${context}]\u001b[39m`
            const colorizedPID = `\u001b[32m[${PID}]\u001b[39m`
            return `${colorizedPID} - ${timestamp}\t${level}:\t${colorizedContext} ${message}`
        }),
        winston.format.errors({ stack: true })
    )

    const transports = [
        // Console -- DEBUG level and above
        new winston.transports.Console({
            name: 'debug-console',
            level: 'debug',
            format: onProduction ? undefined : consoleFormat,
            handleExceptions: true,
            handleRejections: true,
            humanReadableUnhandledException: true,
            ...consoleCfg
        }),

        // File -- DEBUG level (all logs)
        new winston.transports.File({
            name: 'debug-file',
            level: 'debug',
            filename: path.join(PROJECT_ROOT, loggerConfig.path.debug),
            ...fileCfg
        }),

        // File -- WARN level and above
        new winston.transports.File({
            name: 'warn-file',
            level: 'warn',
            filename: path.join(PROJECT_ROOT, loggerConfig.path.warn),
            handleExceptions: true,
            handleRejections: true,
            humanReadableUnhandledException: true,
            ...fileCfg
        })
    ]

    // The TRACE stream is opt-outable at startup (--no-trace / cli.noTrace): when
    // disabled there is simply no transport for it, so nothing is ever written.
    if (!StateService.get('cli.noTrace')) {
        transports.push(
            // File -- TRACE level ONLY (high-volume diagnostics; never reaches console/UI).
            // Transport `level` is a lower bound, so pin exact-match via format filtering.
            new winston.transports.File({
                name: 'trace-file',
                level: 'trace',
                filename: path.join(PROJECT_ROOT, loggerConfig.path?.trace ?? 'var/log/trace.log'),
                format: TRACE_ONLY_FORMAT,
                ...fileCfg
            })
        )
    }

    return transports
}
