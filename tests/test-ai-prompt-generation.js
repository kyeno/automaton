/**
 * AI Prompt Generation Test.
 *
 * Initializes the application stack (env, i18n, cache, AI assistant),
 * loads device names offline from zigbee.yaml (no MQTT required),
 * restores real conversation history from Redis, appends CLI args as a user message,
 * and prints the EXACT payload that would be sent to the LLM provider.
 *
 * Usage:
 *   node tests/test-ai-prompt-generation.js "What is the temperature outside?"
 *   node tests/test-ai-prompt-generation.js "Turn on the kitchen light" "And close the blinds"
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument as yamlParseDocument } from 'yaml'

// Load .env before anything else (no dotenv dependency -- mimics bin/run.sh behavior)
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx === -1) continue
        const key = trimmed.slice(0, eqIdx).trim()
        let val = trimmed.slice(eqIdx + 1).trim()
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
        }
        process.env[key] ??= val
    }
}

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import I18nLoader from '../src/service/i18nLoader.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import ToolBuilder from '../src/ai/toolBuilder.js'
import StateService from '../src/service/stateService.js'

StateService.set('cli.noUi', true)

// -- Initialize services ---------------------------------------------------

console.log('\n── Initializing AI Prompt Generator ──\n')

// Initialize config first (required by LoggerService which reads logger paths from config)
await ConfigService.init()
LoggerService.init()

try {
    await CacheService.init()
    console.log(`  ✓ CacheService connected (${CacheService.isConnected() ? 'active' : 'inactive'})`)
} catch (err) {
    console.error(`  ✗ CacheService failed: ${err.message}`)
}

// Load devices OFFLINE from zigbee.yaml (no MQTT bridge required).
// For prompt generation we only need device names in the container.
// We manually import type modules so addDevice resolves proper classes instead of DummyDevice.
import Mechanism from '../src/device/type/mechanism.js'
import Sensor from '../src/device/type/sensor.js'
import Remote from '../src/device/type/remote.js'

const TYPE_MAP = Object.freeze({
    mechanism: Mechanism.default || Mechanism,
    sensor: Sensor.default || Sensor,
    remote: Remote.default || Remote,
})

const ZIGBEE_CONFIG_PATH = './etc/device/zigbee.yaml'
let deviceCount = 0
if (fs.existsSync(ZIGBEE_CONFIG_PATH)) {
    const config = yamlParseDocument(
        fs.readFileSync(ZIGBEE_CONFIG_PATH, 'utf8')
    ).contents?.toJSON()

    // Add a dummy bridge entry so it's excluded properly by getEffectiveSystemPrompt
    DeviceContainer.addDevice('bridge', '0xbridge', {})

    // Only load mechanism and sensor categories -- remotes are filtered out in
    // getEffectiveSystemPrompt() by getLogPrefix() === 'Remote'.
    for (const category of ['mechanism', 'sensor']) {
        const list = config?.[category] || []
        const DeviceClass = TYPE_MAP[category]
        for (const name of list) {
            if (!DeviceContainer.findByName(name)) {
                // Use the proper type class instead of DummyDevice
                const deviceId = `offline:${name}`
                const deviceData = { id: deviceId, ieee_address: deviceId, friendly_name: name }
                const device = new DeviceClass(name, deviceId, deviceData)
                // Wire MQTT (will be no-op since MqttService isn't initialized)
                Object.assign(DeviceContainer.getAll(), { [name]: device })
                deviceCount++
            }
        }
    }
}
console.log(`  ✓ Devices loaded offline: ${deviceCount} (from zigbee.yaml)` +
    ` [${Object.keys(DeviceContainer.getAll()).length - 1} unique excluding bridge])`)

// Load AI i18n language bundle
await I18nLoader.init()
console.log(`  ✓ I18n loaded: ${I18nLoader.getLanguage()} `)

// Initialize AI assistant (restores conversation from Redis, builds system prompt)
await AiAssistant.init()
console.log(`  ✓ AiAssistant initialized (available: ${AiAssistant.isAvailable()})`)
console.log(`  ✓ Conversation history: ${AiAssistant.getMessageCount()} messages restored\n`)

// -- Build the exact LLM payload -------------------------------------------

const userMessages = process.argv.slice(2)
if (userMessages.length === 0) {
    console.log('  (No arguments provided -- showing current conversation state only)')
} else {
    // Simulate what processMessage does: push user message(s) into internal array
    const allArgs = userMessages.join(' ')
    AiAssistant.injectUserMessage(allArgs)
}

// Get full messages including system prompt
const rawMessages = AiAssistant.getMessages()

// Strip internal fields exactly as done before sending to provider
const apiMessages = AiAssistant.stripInternalFields(rawMessages)

// Build tools (cached, static)
const tools = ToolBuilder.build()

// -- Output ----------------------------------------------------------------

const payload = JSON.stringify({ messages: apiMessages, tools }, null, 2)
const bytes = Buffer.byteLength(payload, 'utf8')

console.log(`${'═'.repeat(60)}`)
console.log('  EXACT LLM PAYLOAD')
console.log(`${'═'.repeat(60)}\n`)
console.log(payload)
console.log(`\n${'─'.repeat(60)}`)
console.log(`  Messages: ${apiMessages.length} (${rawMessages.filter(m => m.role !== 'system').length} non-system)`)
console.log(`  Tools:      ${tools.length}`)
console.log(`  Payload:    ${bytes.toLocaleString()} bytes (${Math.round(bytes / 1024 * 10) / 10} KB)`)
console.log(`  Est. tokens: ~${Math.ceil(bytes / 3.5).toLocaleString()} (rough estimate)`)
console.log(`${'═'.repeat(60)}\n`)

process.exit(0)