/**
 * AI assistant name personalization tests.
 *
 * The assistant's name is a single config value (`ai.name`) that every naming site
 * reads through AiAssistant.getAssistantName(): the `{% name %}` token in the i18n
 * system prompt, the AI window transcript prefix and the action lines. Coverage here:
 *   - getAssistantName() returns the configured name, trimmed,
 *   - a blank or missing name degrades to the neutral default,
 *   - getEffectiveSystemPrompt() resolves `{% name %}` to that name and leaves no
 *     unresolved token behind,
 *   - the token is resolved per call, so a config reload reaches the next turn,
 *   - every i18n ai bundle carries the token and none hard-codes an assistant name.
 * No MQTT broker, live Redis or LLM provider required.
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
import { config } from 'dotenv'
config()

import { parseDocument as yamlParseDocument } from 'yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import I18nLoader from '../src/service/i18nLoader.js'
import AiAssistant from '../src/ai/aiAssistant.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
LoggerService.init()
await I18nLoader.init()
// init() is what loads the i18n system prompt into the assistant, so it must run
// after the bundle is ready (Redis and provider are optional for this test).
await AiAssistant.init()

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// -- The configured name is what the assistant reports -----------------------------

console.log('\n\u2500\u2500 Configured assistant name \u2500\u2500\n')

{
    const configured = String(ConfigService.get('ai.name') ?? '').trim()
    assert(configured !== '', 'etc/automaton.yaml declares an ai.name')
    assert(AiAssistant.getAssistantName() === configured,
        `getAssistantName() returns the configured name (${configured})`)
    assert(AiAssistant.getAssistantName() === AiAssistant.getAssistantName(),
        'name is stable across calls')
}

// -- Blank config degrades to the neutral default -----------------------------------

console.log('\n\u2500\u2500 Missing name fallback \u2500\u2500\n')

{
    const proto = Object.getPrototypeOf(ConfigService)
    const originalGet = proto.get
    // ConfigService is a frozen singleton, so the seam is its prototype (mirrors
    // the CacheService stubbing used across the suite).
    proto.get = function (key, ...rest) {
        if (key === 'ai.name') return '   '
        return originalGet.call(this, key, ...rest)
    }
    try {
        assert(AiAssistant.getAssistantName() === 'AI', 'blank ai.name falls back to the default name')
        proto.get = function (key, ...rest) {
            if (key === 'ai.name') return undefined
            return originalGet.call(this, key, ...rest)
        }
        assert(AiAssistant.getAssistantName() === 'AI', 'missing ai.name falls back to the default name')
    } finally {
        proto.get = originalGet
    }
    assert(AiAssistant.getAssistantName() === String(ConfigService.get('ai.name')).trim(),
        'stub removed: configured name reported again')
}

// -- The system prompt carries the name, not the token -----------------------------

console.log('\n\u2500\u2500 System prompt personalization \u2500\u2500\n')

{
    const configured = AiAssistant.getAssistantName()
    const prompt = AiAssistant.getEffectiveSystemPrompt()

    assert(typeof prompt === 'string' && prompt.length > 0, 'effective system prompt built')
    assert(prompt.includes(configured), `prompt addresses the assistant as ${configured}`)
    assert(!prompt.includes('{%'), 'no unresolved {% ... %} token left in the prompt')

    // Resolved per call, so /config reload picks up a renamed assistant at once.
    const proto = Object.getPrototypeOf(ConfigService)
    const originalGet = proto.get
    proto.get = function (key, ...rest) {
        if (key === 'ai.name') return 'Renamed Assistant'
        return originalGet.call(this, key, ...rest)
    }
    try {
        const renamed = AiAssistant.getEffectiveSystemPrompt()
        assert(renamed.includes('Renamed Assistant'), 'renamed config reaches the next prompt build')
        assert(!renamed.includes('{%'), 'renamed prompt leaves no token behind')
    } finally {
        proto.get = originalGet
    }
}

// -- i18n bundles carry the token, never a hard-coded name --------------------------

console.log('\n\u2500\u2500 i18n bundles \u2500\u2500\n')

{
    const bundleFiles = []
    const i18nRoot = path.join(repoRoot, 'etc', 'i18n')
    for (const locale of fs.readdirSync(i18nRoot)) {
        for (const file of ['ai.yaml', 'ai.yaml.dist']) {
            const full = path.join(i18nRoot, locale, file)
            if (fs.existsSync(full)) bundleFiles.push(full)
        }
    }
    assert(bundleFiles.length >= 2, `found i18n ai bundles (${bundleFiles.length})`)

    for (const file of bundleFiles) {
        const rel = path.relative(repoRoot, file)
        const doc = yamlParseDocument(fs.readFileSync(file, 'utf8'))
        const prompt = String(doc.get('system_prompt') ?? '')
        assert(prompt.includes('{% name %}'), `${rel}: system_prompt carries the {% name %} token`)
        assert(!/Gerwazy/i.test(prompt), `${rel}: no assistant name hard-coded in the prompt`)
    }
}

// -- Summary ------------------------------------------------------------------------

const total = passed + failed
console.log(`\nResults: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}\n`)

process.exit(failed > 0 ? 1 : 0)

