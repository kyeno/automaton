#!/usr/bin/env node
/**
 * AUTOMATON - Pure JavaScript Zigbee2MQTT home automation.
 * Entry point that initializes all core services and handles graceful shutdown.
 * 
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import process from 'node:process'
import { parseArgs } from 'node:util'

import StateService from './service/stateService.js'
import ConfigService from './service/configService.js'
import LoggerService from './service/loggerService.js'
import CacheService from './service/cacheService.js'
import MqttService from './service/mqttService.js'
import I18nLoader from './service/i18nLoader.js'
import EventBus from './service/eventBus.js'

import DeviceContainer from './device/container/deviceContainer.js'
import AutomationContainer from './automation/container/automationContainer.js'
import InteractionContainer from './interaction/container/interactionContainer.js'

import NetworkPresence from './monitor/networkPresence.js'

import AiAssistant     from './ai/aiAssistant.js'
import AiPeriodicService from './service/aiPeriodicService.js'
import TtsService      from './service/ttsService.js'
import Ui              from './ui/ui.js'

// UI instance reference for cleanup
let uiInstance = null

// ---------------------------------------------------------------------------
// CLI argument parsing -- --no-ui disables the UI, --help shows usage
// ---------------------------------------------------------------------------

const HELP_TEXT = `
Usage: node src/main.js [options]

Options:
  -n, --no-ui        Disable the terminal UI
  -h, --help         Show this help message

Environment variables (.env):
  MQTT_URL                          MQTT broker URL (required)
  MQTT_PREFIX                       MQTT topic prefix (default: zigbee2mqtt)
  REDIS_URL                         Redis connection URL (required)
  AI_API_URL                        AI provider API base URL (e.g., http://host:port/v1)
  AI_API_KEY                        AI provider API key (optional)

Behavior settings are in etc/automaton.yaml (ai_language, time_format).
AI model settings are in etc/ai.yaml (model, max_tokens, temperature, etc.).
`

/**
 * Print CLI usage help text and exit.
 * @param {string} [msg] - Optional error message printed to stderr before help
 */
function printHelp(msg) {
    if (msg) process.stderr.write(`${msg}\n`)
    process.stdout.write(HELP_TEXT)
    process.exit(msg ? 1 : 0)
}

let parsed
try {
    parsed = parseArgs({
        options: {
            'no-ui':  { type: 'boolean', default: false, short: 'n' },
            help:     { type: 'boolean', default: false, short: 'h' },
        },
        allowPositionals: true,
        strict: true,
    })
} catch (e) {
    // parseArgs throws on unknown flags -- show a friendly hint + usage
    printHelp(e.message)
}

if (parsed.values.help) {
    printHelp(null)
}

// ---------------------------------------------------------------------------
// Bootstrap -- dependency-aware initialization order
// ---------------------------------------------------------------------------
// Order matters: ConfigService validates env vars and YAML schema first.
// LoggerService sets up transports next so all subsequent startup logs
// appear correctly. Only after these two succeed do we initialize the UI
// (which captures the tty), followed by the remaining services.
// ---------------------------------------------------------------------------

// Initialize lifecycle state in StateService
StateService.set('lifecycle.initializedServices', new Set())
StateService.set('lifecycle.shuttingDown', false)
StateService.set('lifecycle.lastError', null)

StateService.set('cli.noUi', parsed.values['no-ui'])

// Phase 1 -- Configuration & Logging (must succeed before anything else)
await ConfigService.init()
LoggerService.init()
LoggerService.info(`Automaton starting, node.js ${process.version}`, 'Main')

if (parsed.values['no-ui']) {
    LoggerService.info('UI disabled via --no-ui flag', 'Main')
}

// ---------------------------------------------------------------------------
// Graceful shutdown -- checks each service before cleanup
// ---------------------------------------------------------------------------

/**
 * Perform a sequential, dependency-aware graceful shutdown.
 *
 * Order matters: high-level consumers are torn down first so they stop
 * triggering work, then their dependencies (devices unsubscribe from MQTT
 * while the broker is still reachable), and finally the infrastructure
 * services (Redis, MQTT) are disconnected.
 *
 * @param {string} reason - Human-readable reason for shutdown
 * @param {number} errorLevel - Exit code passed to process.exit()
 */
async function gracefulDeath(reason, errorLevel = 0) {
    if (StateService.get('lifecycle.shuttingDown')) return
    StateService.set('lifecycle.shuttingDown', true)
    LoggerService.info(`Process terminated (${reason})`, 'Main')

    try {
        // ---------------------------------------------------------------
        // Phase 1 -- Stop high-level logic (interactions → automations)
        // These may reference devices and each-other; halt them first so
        // no new device commands or automation rules fire during teardown.
        // ---------------------------------------------------------------
        const initialized = StateService.get('lifecycle.initializedServices')

        if (initialized.has('InteractionContainer')) {
            LoggerService.debug('Cleaning up interactions...', 'Main')
            await Promise.resolve(InteractionContainer.cleanupInteractions())
        }

        if (initialized.has('AutomationContainer')) {
            LoggerService.debug('Cleaning up automations...', 'Main')
            await Promise.resolve(AutomationContainer.cleanupAutomations())
        }

        // ---------------------------------------------------------------
        // Phase 2 -- Unsubscribe devices from MQTT topics.
        // MUST happen while MqttService is still connected so the broker
        // receives proper UNSUBSCRIBE packets before we disconnect.
        // ---------------------------------------------------------------
        if (initialized.has('DeviceContainer')) {
            LoggerService.debug('Cleaning up devices...', 'Main')
            await DeviceContainer.cleanupDevices()
        }

        // ---------------------------------------------------------------
        // Phase 3 -- Stop optional services (AI periodic timer, TTS unsubscribes from EventBus).
        // ---------------------------------------------------------------
        if (initialized.has('AiPeriodicService')) {
            LoggerService.debug('Cleaning up AiPeriodicService...', 'Main')
            AiPeriodicService.cleanup()
        }

        if (initialized.has('TtsService')) {
            LoggerService.debug('Cleaning up TtsService...', 'Main')
            TtsService.cleanup()
        }

        // ---------------------------------------------------------------
        // Phase 4 -- Tear down the UI so terminal-kit releases the tty.
        // ---------------------------------------------------------------
        if (initialized.has('Ui') && uiInstance) {
            LoggerService.debug('Destroying UI...', 'Main')
            await Promise.resolve(uiInstance.destroy?.())
        }

        // ---------------------------------------------------------------
        // Phase 5 -- Disconnect infrastructure services.
        // Redis first, then MQTT last (devices already unsubscribed).
        // ---------------------------------------------------------------
        if (initialized.has('CacheService')) {
            LoggerService.debug('Disconnecting CacheService...', 'Main')
            await CacheService.disconnect()
        }

        if (initialized.has('MqttService')) {
            LoggerService.debug('Disconnecting MqttService...', 'Main')
            await MqttService.disconnect()
        }
    } catch (e) {
        LoggerService.error(`Shutdown error: ${e.message}`, 'Main')
        errorLevel = 1
    }

    process.exit(errorLevel)
}

process.on('SIGINT', () => { gracefulDeath('CTRL+C') })
process.on('SIGQUIT', () => { gracefulDeath('keyboard quit') })
process.on('SIGTERM', () => { gracefulDeath('killed') })

// ---------------------------------------------------------------------------
// Crash recovery -- print last error to stderr even if UI cleared the screen
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
    StateService.set('lifecycle.lastError', err)
    // Write directly to stderr (fd 2) -- bypasses any terminal clearing
    process.stderr.write(
        `\n\x1b[1m\x1b[31m=== AUTOMATON CRASHED ===\x1b[0m\n` +
        `\x1b[31m${err.message}\x1b[0m\n\n` +
        `${err.stack || ''}\n\n` +
        `Check var/log/ for details.\n\x1b[0m\n`
    )
    gracefulDeath(`crash: ${err.message}`, 1)
})

process.on('unhandledRejection', (reason, promise) => {
    const msg = reason?.message || String(reason)
    StateService.set('lifecycle.lastError', reason)
    LoggerService.error(`Unhandled rejection at ${promise}: ${msg}`, 'Main')
})

// ---------------------------------------------------------------------------
// Service initialization -- all failures route through gracefulDeath
// ---------------------------------------------------------------------------

/**
 * Initialize a single service, track its success/failure.
 * On failure, trigger gracefulDeath immediately with the failing service name.
 *
 * @param {string} name - Human-readable service name
 * @param {Function} initFn - Async function to call for initialization
 * @param {boolean} optional - If true, log warning instead of crashing on failure
 */
async function initService(name, initFn, optional = false) {
    try {
        await initFn()
        StateService.get('lifecycle.initializedServices').add(name)
        LoggerService.debug(`${name} initialized`, 'Main')
    } catch (e) {
        if (optional) {
            LoggerService.warn(`${name} initialization skipped: ${e.message}`, 'Main')
        } else {
            const errMsg = `Failed to initialize ${name}: ${e.message}`
            LoggerService.error(errMsg, 'Main')
            // Ensure critical init failures are printed to stderr regardless of UI state
            process.stderr.write(`\n\x1b[1m\x1b[31mCRITICAL ERROR\x1b[0m: ${errMsg}\n${e.stack || ''}\n\n`)
            gracefulDeath(`init failed: ${name}`, 1)
        }
    }
}

/**
 * Bootstrap all application services in dependency-aware order.
 * Initializes UI (optional), core infrastructure (Cache, MQTT), device container,
 * automation container, interaction container, network presence, i18n, AI and TTS.
 */
async function bootstrap() {
    // Initialize UI early so all subsequent startup logs appear in the log window
    if (!parsed.values['no-ui']) {
        // Import terminal-kit and create a Terminal instance
        // terminal-kit exports: default.terminal (ESM wrapper) or terminal (CJS)
        // It's a FACTORY function that must be called to produce a Terminal instance.
        const terminalKit = await import('terminal-kit');
        const factory = terminalKit.default?.terminal || terminalKit.terminal || terminalKit.default
        const term = typeof factory === 'function' ? factory() : factory

        uiInstance = new Ui()
        await initService('Ui', () => uiInstance.init(term))

        // UI captured the tty -- remove console transport so logs go to UI only
        LoggerService.switchToUiMode()
    }

    // Core services (required -- any failure crashes)
    await initService('CacheService', () => CacheService.init())
    await initService('MqttService', () => MqttService.init())
    await initService('DeviceContainer', () => DeviceContainer.init())
    await initService('AutomationContainer', () => AutomationContainer.init())
    await initService('InteractionContainer', () => InteractionContainer.init())
    await initService('NetworkPresence', () => NetworkPresence.init())

    // I18n Loader reads config/i18n.yaml (ai_language + time_format) and loads
    // the AI language bundle -- all in a single init call.
    await initService('I18nLoader', () => I18nLoader.init(), true)

    // AI Assistant is optional
    await initService('AiAssistant', () => AiAssistant.init(), true)

    // AI Periodic Service runs after both I18nLoader and AiAssistant are ready
    await initService('AiPeriodicService', () => AiPeriodicService.init(), true)

    // TTS Service auto-enables when TTS_API_URL is set in .env
    await initService('TtsService', () => TtsService.init(), true)

    const services = []
    if (AiAssistant.isAvailable()) services.push('AI')
    if (TtsService.isEnabled())   services.push('TTS')
    const statusLabel = services.length > 0 ? `(including ${services.join(', ')})` : ''
    LoggerService.info(`All core services initialized ${statusLabel}`, 'Main')
}

bootstrap().catch(e => {
    LoggerService.error(`Unexpected bootstrap error: ${e.message}`, 'Main')
    gracefulDeath('bootstrap crash', 1)
})