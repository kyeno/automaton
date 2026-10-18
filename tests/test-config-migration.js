/**
 * Configuration migration and duration-unit regressions, using isolated YAML and stubbed AI.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify, parse } from 'yaml'
import { normalizeConfig, normalizeSequenceConfig } from '../src/lib/configMigration.js'
import ConfigBase from '../src/service/config/configBase.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import I18nLoader from '../src/service/i18nLoader.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import OpenAiProvider from '../src/ai/providers/openaiProvider.js'
import { playerTimeout } from '../src/monitor/providers/http.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-config-migration-'))
const old = {
    ...parse(fs.readFileSync(new URL('../etc/automaton.yaml.dist', import.meta.url), 'utf8')),
    locale: { language: 'en_US', time_format: '24h' },
    ai: { model: 'test', max_tokens: -1, temperature: 1, fetch_timeout_ms: '5m', conversation_ttl_sec: 900, bridge: { enabled: false } },
    ai_bridge: { enabled: true, topic_base: 'test/legacy', forward_events: false },
    automation: { human_interaction_cooldown_ms: 10000, human_interaction_cooldown: 0, motion_stall_timeout_ms: '20s' },
    email: { cooldown_ms: 0 },
    alerts: { network_offline_cooldown_ms: '5m', network_offline_devices: { Server: { cooldown_ms: '2m' } } },
}
const original = structuredClone(old)
const migrated = normalizeConfig(old, 'main')
assert.deepEqual(old, original, 'loading migration does not mutate input')
assert.equal(migrated.ai.fetch_timeout, '5m')
assert.equal(migrated.ai.conversation_ttl, 900000, 'legacy numeric TTL seconds are converted to milliseconds')
assert.deepEqual(migrated.ai.bridge, { enabled: false, topic_base: 'test/legacy', forward_events: false }, 'partial canonical bridge overrides only matching legacy fields')
assert.equal(migrated.ai_bridge, undefined)
assert.equal(normalizeConfig({ ai: {}, ai_bridge: false }, 'main').ai.bridge, false, 'invalid legacy bridge type remains visible to validation')
assert.equal(migrated.automation.human_interaction_cooldown, 0, 'explicit canonical zero wins over legacy key')
assert.equal(migrated.email.cooldown, 0)
assert.equal(migrated.alerts.network_offline_devices.Server.cooldown, '2m')
assert.equal(normalizeConfig({ ai: { conversation_ttl: 500, conversation_ttl_sec: 900 } }, 'main').ai.conversation_ttl, 500)
assert.equal(normalizeConfig({ ai: { conversation_ttl_sec: '15m' } }, 'main').ai.conversation_ttl, '15m')
assert.equal(normalizeConfig({ ai: { bridge: false }, ai_bridge: { enabled: true } }, 'main').ai.bridge, false, 'invalid explicit new value remains available to validation')
const sequence = { delay_ms: '2s', loop: { off_delay_ms: 'auto', on_delay_ms: 500 }, on: [{ device: 'Lamp', delay_ms: '1s', payload: { delay_ms: 42 } }] }
const normalized = normalizeSequenceConfig(sequence)
assert.equal(normalized.delay, '2s')
assert.equal(normalized.loop.on_delay, 500)
assert.equal(normalized.on[0].delay, '1s')
assert.equal(normalized.on[0].payload.delay_ms, 42, 'raw device command payloads are never renamed')
assert.equal(sequence.delay_ms, '2s')
assert.equal(normalizeConfig({ videoPlayers: { Player: { timeout_ms: 700 } } }, 'network').videoPlayers.Player.timeout, 700)
assert.equal(normalizeConfig({ timer_interval_ms: 3000 }, 'custom-automation').timer_interval, 3000)
assert.equal(playerTimeout({ timeout: '2s' }), 2000)
assert.equal(playerTimeout({ timeout: 600, timeout_ms: 1 }), 600)
assert.equal(playerTimeout({ timeout_ms: 700 }), 700)
assert.equal(playerTimeout({ timeout: 'wrong' }), 1200)
assert.equal(playerTimeout({ timeout: 0 }), 1200)

const restores = []
function stub(instance, method, fn) {
    const proto = Object.getPrototypeOf(instance)
    const previous = proto[method]
    proto[method] = fn
    restores.push(() => { proto[method] = previous })
}
try {
    const file = path.join(dir, 'main.yaml')
    fs.writeFileSync(file, stringify(old))
    const config = new ConfigBase(file, 'main')
    await config.ensureValidated()
    assert.equal(config.get('ai.bridge.enabled'), false)
    assert.equal(config.get('ai.conversation_ttl'), 900000)
    assert.equal(config.get('ai_bridge'), undefined)
    assert.equal((await config.checkOverridePaths([{ path: 'ai.bridge.enabled', value: true }])).problems.length, 0)
    assert.ok((await config.checkOverridePaths([{ path: 'ai_bridge.enabled', value: true }])).problems.length > 0, 'runtime overrides advertise canonical schema paths')
    old.ai_bridge.topic_base = 'test/reloaded'
    fs.writeFileSync(file, stringify(old))
    config.refresh()
    assert.equal(config.get('ai.bridge.topic_base'), 'test/reloaded', 'reload re-applies migration')

    await ConfigService.init()
    LoggerService.init()
    await I18nLoader.init()
    const ttls = []
    stub(CacheService, 'isConnected', () => true)
    stub(CacheService, 'get', async () => undefined)
    stub(CacheService, 'delete', async () => true)
    stub(CacheService, 'set', async (_key, _value, ttl) => { ttls.push(ttl); return true })
    const originalChat = OpenAiProvider.prototype.chat
    OpenAiProvider.prototype.chat = async () => ({ role: 'assistant', content: 'Hello' })
    restores.push(() => { OpenAiProvider.prototype.chat = originalChat })
    await AiAssistant.init()
    for (const [value, expectedSeconds] of [[1500, 2], ['15m', 900], [900000, 900], [0, 900]]) {
        ConfigService.section('main').set('ai.conversation_ttl', value)
        await AiAssistant.resetConversation()
        await AiAssistant.processMessage('hello')
        assert.equal(ttls.at(-1), expectedSeconds, `canonical TTL ${JSON.stringify(value)} uses milliseconds before conversion to Redis seconds`)
    }
    console.log('Config migration, canonical precedence, legacy TTL units, player timeouts and reload passed')
} finally {
    for (const restore of restores.reverse()) restore()
    fs.rmSync(dir, { recursive: true, force: true })
}
