#!/usr/bin/env node
/** AUTOMATON - Pure JavaScript Zigbee2MQTT home automation.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only */
'use strict'

import process from 'node:process'
import { parseArgs } from 'node:util'

import StateService from './service/stateService.js'
import ConfigService from './service/configService.js'
import LoggerService from './service/loggerService.js'
import CacheService from './service/cacheService.js'
import DatabaseService from './service/databaseService.js'
import SensorHistoryService from './service/sensorHistoryService.js'
import MqttService from './service/mqttService.js'
import I18nLoader from './service/i18nLoader.js'
import EventBus from './service/eventBus.js'
import AnsiColors from './enum/ansiColors.js'

import DeviceContainer from './device/container/deviceContainer.js'
import AutomationContainer from './automation/container/automationContainer.js'
import InteractionContainer from './interaction/container/interactionContainer.js'
import SequenceContainer from './sequence/container/sequenceContainer.js'

import NetworkPresence from './monitor/networkPresence.js'
import VideoPlayerMonitor from './monitor/videoPlayerMonitor.js'
import ZigbeeDeviceOfflineMonitor from './monitor/zigbeeDeviceOfflineMonitor.js'
import FrozenSensorMonitor from './monitor/frozenSensorMonitor.js'
import NetworkDeviceOfflineMonitor from './monitor/networkDeviceOfflineMonitor.js'
import AiBridgeMonitor from './monitor/aiBridgeMonitor.js'

import AiAssistant     from './ai/aiAssistant.js'
import TtsService      from './service/ttsService.js'
import EmailService    from './service/emailService.js'
import Ui              from './ui/ui.js'

//  UI instance reference for cleanup.
let uiInstance = null

//  CLI argument parsing -- --no-* flags disable optional services, --help shows usage.

const HELP_TEXT = `
Usage: node src/main.js [options]

Options:
  -n, --no-ui        Disable the terminal UI
      --no-trace     Disable TRACE-level file logging
      --no-ai        Disable AI features (overrides AI_* environment settings)
      --no-tts       Disable TTS features (overrides TTS_* environment settings)
      --no-email     Disable email notifications (overrides SMTP_* environment settings)
  -c, --config-override "key.path: value"   Override a config parameter from etc/automaton.yaml (strictly validated; repeatable)

  -h, --help         Show this help message

Examples:
  ./bin/automaton --no-ui
  ./bin/automaton -c "locale.language: en_US" -c "ai.temperature: 0.7"

Environment variables (.env):
  MQTT_URL                          MQTT broker URL (required)
  MQTT_PREFIX                       MQTT topic prefix (default: zigbee2mqtt)
  REDIS_URL                         Redis connection URL (required)
  AI_API_URL                        AI provider API base URL (e.g., http://host:port/v1)
  AI_API_KEY                        AI provider API key (optional)
  TTS_API_URL                       TTS server API endpoint (e.g., http://host:port/tts)
  TTS_TCP_ENDPOINT                  Audio playback destination (ip:port)
  SMTP_HOST                         SMTP relay host for notification mails (e.g., smtp.host)
  SMTP_PORT                         SMTP relay port (default: 465)
  SMTP_SECURE                       Use TLS on the relay connection (default: true)
  SMTP_USER                         SMTP login user; also the default sender address
  SMTP_PASS                         SMTP login password

Behavior settings are in etc/automaton.yaml (locale.language, locale.time_format); individual values can be overridden per-run via -c/--config-override.

AI model settings are in etc/ai.yaml (model, max_tokens, temperature, etc.).
`

/** Print CLI usage help text and exit.
 * @param {string} [msg] - Optional error message printed to stderr before help */
function printHelp(msg) {
    if (msg) process.stderr.write(`${msg}\n`)
    process.stdout.write(HELP_TEXT)
    process.exit(msg ? 1 : 0)
}

let parsed
try {
    parsed = parseArgs({
        options: {
            'no-ui':    { type: 'boolean', default: false, short: 'n' },
            'no-trace': { type: 'boolean', default: false },
            'no-ai':    { type: 'boolean', default: false },
            'no-tts':   { type: 'boolean', default: false },
            'no-email': { type: 'boolean', default: false },
            'config-override': { type: 'string', short: 'c', multiple: true },

            help:       { type: 'boolean', default: false, short: 'h' },
        },
        allowPositionals: true,
        strict: true,
    })
} catch (e) {
    //  parseArgs throws on unknown flags -- show a friendly hint + usage.
    printHelp(e.message)
}

if (parsed.values.help) {
    printHelp(null)
}

//  --no-ai / --no-tts / --no-email make each feature behave exactly as if its .env vars were.
if (parsed.values['no-ai']) {
    delete process.env.AI_API_URL
    delete process.env.AI_API_KEY
}

if (parsed.values['no-tts']) {
    delete process.env.TTS_API_URL
    delete process.env.TTS_TCP_ENDPOINT
}

if (parsed.values['no-email']) {
    delete process.env.SMTP_HOST
    delete process.env.SMTP_PORT
    delete process.env.SMTP_SECURE
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
}

//  Bootstrap -- dependency-aware initialization order.

StateService.set('lifecycle.initializedServices', new Set())
StateService.set('lifecycle.shuttingDown', false)
StateService.set('lifecycle.lastError', null)

StateService.set('cli.noUi', parsed.values['no-ui'])
StateService.set('cli.noTrace', parsed.values['no-trace'])
StateService.set('cli.noAi', parsed.values['no-ai'])
StateService.set('cli.noTts', parsed.values['no-tts'])
StateService.set('cli.noEmail', parsed.values['no-email'])
StateService.set('cli.configOverrides', parsed.values['config-override'] ?? [])

//  Phase 1 -- Configuration & Logging (must succeed before anything else).
try {
    await ConfigService.init(parsed.values['config-override'] ?? [])
    LoggerService.init()
} catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    process.stderr.write(
        `\n${AnsiColors.bold}${AnsiColors.red}CRITICAL ERROR${AnsiColors.reset}: Automaton failed to start -- ${detail}\n` +
        `${e instanceof Error && e.stack ? '\n' + e.stack + '\n' : ''}`
    )
    process.exit(1)
}

LoggerService.info(`Automaton starting, node.js ${process.version}`, 'Main')

if (parsed.values['no-ui']) {
    LoggerService.info('UI disabled via --no-ui flag', 'Main')
}

if (parsed.values['no-trace']) {
    LoggerService.info('TRACE logging disabled via --no-trace flag', 'Main')
}

if (parsed.values['no-ai']) {
    LoggerService.info('AI disabled via --no-ai flag', 'Main')
}

if (parsed.values['no-tts']) {
    LoggerService.info('TTS disabled via --no-tts flag', 'Main')
}

if (parsed.values['no-email']) {
    LoggerService.info('Email disabled via --no-email flag', 'Main')
}

if ((parsed.values['config-override'] ?? []).length > 0) {
    LoggerService.info(`Config override(s) active: ${parsed.values['config-override'].join(', ')}`, 'Main')
}


//  Graceful shutdown -- checks each service before cleanup.

/** Perform a sequential, dependency-aware graceful shutdown.
 * @param {string} reason - Human-readable reason for shutdown
 * @param {number} errorLevel - Exit code passed to process.exit() */
async function gracefulDeath(reason, errorLevel = 0) {
    if (StateService.get('lifecycle.shuttingDown')) return
    StateService.set('lifecycle.shuttingDown', true)
    LoggerService.info(`Process terminated (${reason})`, 'Main')

    try {
        //  Phase 1 -- Stop high-level logic (interactions -> automations)
        const initialized = StateService.get('lifecycle.initializedServices')

        if (initialized.has('InteractionContainer')) {
            LoggerService.debug('Cleaning up interactions...', 'Main')
            await Promise.resolve(InteractionContainer.cleanupInteractions())
        }

        if (initialized.has('SequenceContainer')) {
            LoggerService.debug('Cleaning up sequences...', 'Main')
            await Promise.resolve(SequenceContainer.cleanupSequences())
        }

        if (initialized.has('AutomationContainer')) {
            LoggerService.debug('Cleaning up automations...', 'Main')
            await Promise.resolve(AutomationContainer.cleanupAutomations())
        }

        //  Phase 1b -- Stop network monitors (presence + video players)
        if (initialized.has('NetworkPresence')) {
            LoggerService.debug('Stopping NetworkPresence...', 'Main')
            NetworkPresence.stop()
        }

        if (initialized.has('VideoPlayerMonitor')) {
            LoggerService.debug('Stopping VideoPlayerMonitor...', 'Main')
            VideoPlayerMonitor.stop()
        }

        if (initialized.has('FrozenSensorMonitor')) {
            LoggerService.debug('Stopping FrozenSensorMonitor...', 'Main')
            await FrozenSensorMonitor.stop()
        }

        if (initialized.has('ZigbeeDeviceOfflineMonitor')) {
            LoggerService.debug('Stopping ZigbeeDeviceOfflineMonitor...', 'Main')
            ZigbeeDeviceOfflineMonitor.stop()
        }

        if (initialized.has('NetworkDeviceOfflineMonitor')) {
            LoggerService.debug('Stopping NetworkDeviceOfflineMonitor...', 'Main')
            NetworkDeviceOfflineMonitor.stop()
        }

        if (initialized.has('AiBridgeMonitor')) {
            LoggerService.debug('Stopping AiBridgeMonitor...', 'Main')
            AiBridgeMonitor.stop()
        }

        if (initialized.has('SensorHistoryService')) SensorHistoryService.stop()

        //  Phase 2 -- Unsubscribe devices from MQTT topics.
        if (initialized.has('DeviceContainer')) {
            LoggerService.debug('Cleaning up devices...', 'Main')
            await DeviceContainer.cleanupDevices()
        }

        //  Phase 3 -- Stop optional services (TTS unsubscribes from EventBus).
        if (initialized.has('TtsService')) {
            LoggerService.debug('Cleaning up TtsService...', 'Main')
            TtsService.cleanup()
        }

        //  Mail queue drains before the relay closes -- no notification lost on shutdown.
        if (initialized.has('EmailService')) {
            LoggerService.debug('Closing EmailService...', 'Main')
            await EmailService.cleanup()
        }

        //  Phase 4 -- Tear down the UI so terminal-kit releases the tty.
        if (initialized.has('Ui') && uiInstance) {
            LoggerService.debug('Destroying UI...', 'Main')
            await Promise.resolve(uiInstance.destroy?.())
        }

        //  Phase 5 -- Disconnect infrastructure services.
        if (initialized.has('CacheService')) {
            LoggerService.debug('Disconnecting CacheService...', 'Main')
            await CacheService.disconnect()
        }

        if (initialized.has('DatabaseService')) {
            LoggerService.debug('Closing DatabaseService...', 'Main')
            await DatabaseService.close()
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

//  Crash recovery -- print last error to stderr even if UI cleared the screen.

process.on('uncaughtException', (err) => {
    StateService.set('lifecycle.lastError', err)
    //  Write directly to stderr (fd 2) -- bypasses any terminal clearing.
    process.stderr.write(
        `
${AnsiColors.bold}${AnsiColors.red}=== AUTOMATON CRASHED ===${AnsiColors.reset}
` +
        `${AnsiColors.red}${err.message}${AnsiColors.reset}

` +
        `${err.stack || ''}

` +
        `Check var/log/ for details.
${AnsiColors.reset}
`
    )
    gracefulDeath(`crash: ${err.message}`, 1)
})

process.on('unhandledRejection', (reason, promise) => {
    const msg = reason?.message || String(reason)
    StateService.set('lifecycle.lastError', reason)
    LoggerService.error(`Unhandled rejection at ${promise}: ${msg}`, 'Main')
})

//  Service initialization -- all failures route through gracefulDeath.

/** Initialize a single service, track its success/failure.
 * @param {string} name - Human-readable service name
 * @param {Function} initFn - Async function to call for initialization
 * @param {boolean} optional - If true, log warning instead of crashing on failure */
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
            //  Ensure critical init failures are printed to stderr regardless of UI state.
            process.stderr.write(`
${AnsiColors.bold}${AnsiColors.red}CRITICAL ERROR${AnsiColors.reset}: ${errMsg}
${e.stack || ''}

`)
            gracefulDeath(`init failed: ${name}`, 1)
        }
    }
}

/** Bootstrap all application services in dependency-aware order. */
async function bootstrap() {
    //  Initialize UI early so all subsequent startup logs appear in the log window.
    if (!parsed.values['no-ui']) {
        //  Import terminal-kit and create a Terminal instance.
        const terminalKit = await import('terminal-kit');
        const factory = terminalKit.default?.terminal || terminalKit.terminal || terminalKit.default
        const term = typeof factory === 'function' ? factory() : factory

        uiInstance = new Ui()
        await initService('Ui', () => uiInstance.init(term))

        //  UI captured the tty -- remove console transport so logs go to UI only.
        LoggerService.switchToUiMode()
    }

    //  Core services (required -- any failure crashes)
    await initService('CacheService', () => CacheService.init())
    // Durable state-transition history (local SQLite via node:sqlite)
    await initService('DatabaseService', () => DatabaseService.init(), true)
    await initService('MqttService', () => MqttService.init())

    //  I18n Loader must initialize BEFORE the automation/interaction containers.
    await initService('I18nLoader', () => I18nLoader.init(), true)

    await initService('SensorHistoryService', () => SensorHistoryService.init(), true)
    await initService('DeviceContainer', () => DeviceContainer.init())
    //  Sequences resolve their steps through DeviceContainer -- must come after it (D16: optional-tolerant).
    await initService('SequenceContainer', () => SequenceContainer.init(), true)
    await initService('AutomationContainer', () => AutomationContainer.init())
    await initService('InteractionContainer', () => InteractionContainer.init())
    await initService('NetworkPresence', () => NetworkPresence.init())
    await initService('VideoPlayerMonitor', () => VideoPlayerMonitor.init())
    //  Spoken warnings for devices leaving the Zigbee mesh and for mission-critical.
    await initService('NetworkDeviceOfflineMonitor', () => NetworkDeviceOfflineMonitor.init(), true)
    await initService('ZigbeeDeviceOfflineMonitor', () => ZigbeeDeviceOfflineMonitor.init(), true)

    //  AI Assistant -- optional; skipped entirely when unconfigured so startup logs.
    if (AiAssistant.isConfigured()) {
        await initService('AiAssistant', () => AiAssistant.init(), true)
    } else {
        LoggerService.info('AI assistant disabled at startup -- provider not configured', 'Main')
    }

    //  TTS Service -- same treatment as the AI assistant above.
    if (TtsService.isConfigured()) {
        await initService('TtsService', () => TtsService.init(), true)
    } else {
        LoggerService.info('TTS service disabled at startup -- not configured', 'Main')
    }

    //  Email -- optional SMTP notification channel; skipped when SMTP_HOST is unset, exactly
    //  like the two above. Needs CacheService (cooldown markers) and I18nLoader (templates).
    if (EmailService.isConfigured()) {
        await initService('EmailService', () => EmailService.init(), true)
    } else {
        LoggerService.info('Email service disabled at startup -- SMTP relay not configured', 'Main')
    }

    //  AI Bridge -- optional MQTT channel feeding external prompts (web UI / STT backends)
    await initService('AiBridgeMonitor', () => AiBridgeMonitor.init(), true)
    // Sensor health runs independently after its notification channels are initialized.
    await initService('FrozenSensorMonitor', () => FrozenSensorMonitor.init(), true)

    const services = []
    if (AiAssistant.isAvailable()) services.push('AI')
    if (TtsService.isEnabled())   services.push('TTS')
    if (EmailService.isEnabled()) services.push('Email')
    const statusLabel = services.length > 0 ? `(including ${services.join(', ')})` : ''
    LoggerService.info(`All core services initialized ${statusLabel}`, 'Main')
}

bootstrap().catch(e => {
    LoggerService.error(`Unexpected bootstrap error: ${e.message}`, 'Main')
    gracefulDeath('bootstrap crash', 1)
})