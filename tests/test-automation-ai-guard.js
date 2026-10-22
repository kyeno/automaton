/**
 * AI automation concurrency: YAML gating, independent instances/hosts and failure recovery.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import assert from 'node:assert/strict'
import AutomationBase from '../src/automation/base/automationBase.js'
import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import AiAssistant from '../src/ai/aiAssistant.js'
import TtsService from '../src/service/ttsService.js'
import TtsTwilightAutomation from '../etc/automation/ttsTwilightAutomation.js'
import TtsGardenerAutomation from '../etc/automation/ttsGardenerAutomation.js'
import TtsWeatherManAutomation from '../etc/automation/ttsWeatherManAutomation.js'
import TtsGreeterAutomation from '../etc/automation/ttsGreeterAutomation.js'

await ConfigService.init()
LoggerService.init()
const base = new AutomationBase({ name: 'guard' })
base.log = () => {}
let release
const gate = new Promise(resolve => { release = resolve })
let calls = 0
const first = base.runWithAiGuard(true, async () => { calls++; await gate })
await base.runWithAiGuard(true, async () => { calls++ })
assert.equal(calls, 1)
await base.runWithAiGuard(true, async () => { calls++ }, 'another-host')
await base.runWithAiGuard(false, async () => { calls++ })
assert.equal(calls, 3, 'independent hosts and plain TTS bypass a busy key')
release()
await first
await assert.rejects(base.runWithAiGuard(true, async () => { throw new Error('failed') }), /failed/)
await base.runWithAiGuard(true, async () => { calls++ })
assert.equal(calls, 4, 'failure releases the guard')

const aiProto = Object.getPrototypeOf(AiAssistant)
const ttsProto = Object.getPrototypeOf(TtsService)
const originalAi = aiProto.isAvailable
const originalTts = ttsProto.isEnabled
try {
    ttsProto.isEnabled = () => true
    for (const Class of [TtsTwilightAutomation, TtsGardenerAutomation, TtsWeatherManAutomation, TtsGreeterAutomation]) {
        for (const available of [true, false]) {
            aiProto.isAvailable = () => available
            for (const setting of [true, false, undefined]) {
                const automation = new Class()
                automation.config = { use_ai: setting, triggers_network: ['first', 'second'] }
                automation.log = () => {}
                const guarded = available && (Class === TtsWeatherManAutomation ? setting !== false : setting === true)
                let entered = 0
                let finish
                const pending = new Promise(resolve => { finish = resolve })
                if (Class === TtsGreeterAutomation) {
                    automation.isInSilentPeriod = () => false
                    automation.greetDecisionFor = async () => {
                        entered++
                        await pending
                        return { action: 'skip', reason: 'test' }
                    }
                } else {
                    // Hold context lookup before output: protection must start before any await.
                    automation.isInSilentPeriod = () => false
                    automation.isVideoPlayerSuppressionActive = async () => false
                    const pause = async () => { entered++; await pending; throw new Error('test context failure') }
                    automation.buildContext = pause
                    automation.dueAnnounceSlot = pause
                }
                const trigger = Class === TtsGreeterAutomation ? 'network:first' : Class === TtsGardenerAutomation ? 'timer' : 'manual'
                const running = automation.execute({ trigger }).catch(() => {})
                for (let i = 0; i < 100 && entered === 0; i++) await new Promise(resolve => setImmediate(resolve))
                assert.equal(entered, 1, `${Class.name} enters the operation`)
                const overlapping = automation.execute({ trigger }).catch(() => {})
                for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
                assert.equal(entered, guarded ? 1 : 2, `${Class.name}: use_ai=${setting}, available=${available}`)
                if (Class === TtsGreeterAutomation && guarded) {
                    const otherHost = automation.execute({ trigger: 'network:second' })
                    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
                    assert.equal(entered, 2, 'another host is not suppressed by a slow greeting')
                    finish()
                    await otherHost
                }
                finish()
                await Promise.all([running, overlapping])
                await automation.execute({ trigger }).catch(() => {})
                assert.equal(entered, (guarded ? 2 : 3) + (Class === TtsGreeterAutomation && guarded ? 1 : 0), 'later execution proceeds after completion or failure')
            }
        }
    }
} finally {
    aiProto.isAvailable = originalAi
    ttsProto.isEnabled = originalTts
}
console.log('AI automation guards passed')
