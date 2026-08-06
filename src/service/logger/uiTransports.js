/**
 * UI Transport Profile for LoggerService.
 *
 * Used when UI is active. Includes ONLY file transports -- no Console transport.
 * Logs are piped to the UI's log window via its custom Winston transport, so
 * stdout remains clean and does not interfere with terminal-kit rendering.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'

import * as winston from 'winston'

import ConfigService from '../configService.js'
import { PROJECT_ROOT } from '../../lib/projectRoot.js'

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
 * Build Winston transports for UI mode (file-only, no console).
 * The UI's log window attaches its own transport separately via addTransport().
 * @returns {winston.Transport[]} Array of transport instances
 */
export function buildUiTransports() {
    const loggerConfig = ConfigService.getSection('logger')
    const fileCfg = normalizeFileConfig(loggerConfig?.file)
    return [
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
}
