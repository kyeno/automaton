/**
 * Tests for EmailService -- the SMTP notification channel.
 *
 * Covers the configuration gates (no relay, no usable sender, email.enabled=false),
 * recipient normalization from house_owners, the per-kind notification switches, the
 * per-kind cooldown (Redis marker, in-memory fallback, Redis outage), template rendering
 * (subject prefix, greeting, signature, footer, unanswered placeholders removed and never
 * left in the mail), the FIFO queue with its cap, the send counters, the shared
 * 'notify:email' channel and the configuration-check mail.
 *
 * No SMTP relay is contacted: the transport is a stub attached through the public seam,
 * and CacheService is patched with an in-memory store standing in for Redis.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { parse as yamlParse } from 'yaml'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import CacheService from '../src/service/cacheService.js'
import EventBus from '../src/service/eventBus.js'
import EmailService from '../src/service/emailService.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'
for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS']) delete process.env[key]

await ConfigService.init()
LoggerService.init()

const ROOT = resolve(import.meta.dirname, '..')
let passed = 0
let failed = 0

/** Record one assertion.
 * @param {boolean} condition - Condition to check
 * @param {string} label - Human-readable assertion name
 * @returns {void} */
function assert(condition, label) {
    if (condition) {
        console.log(`  ok - ${label}`)
        passed++
    } else {
        console.error(`  FAIL - ${label}`)
        failed++
    }
}

// -- Config stub: EmailService reads its behavioural settings through ConfigService.get.
const cfgProto = Object.getPrototypeOf(ConfigService)
const origCfgGet = cfgProto.get
let cfgOverrides = {}
cfgProto.get = function (key, defaultVal) {
    return (key in cfgOverrides) ? cfgOverrides[key] : origCfgGet.call(ConfigService, key, defaultVal)
}
/** Set the config values the mail service sees.
 * @param {Record<string, *>} map - Dot-keyed overrides
 * @returns {void} */
function setConfig(map) { cfgOverrides = { ...map } }

// -- Cache stub: stands in for Redis, including the outage case.
const cacheProto = Object.getPrototypeOf(CacheService)
const origCacheGet = cacheProto.get
const origCacheSet = cacheProto.set
const markerStore = new Map()
let cacheDown = false
cacheProto.get = async (key) => { if (cacheDown) throw new Error('redis is down'); return markerStore.get(key) }
cacheProto.set = async (key, value) => { if (cacheDown) throw new Error('redis is down'); markerStore.set(key, value); return true }

// -- Transport stub: the relay never runs, every accepted message is recorded.
const sent = []
let relayExplodes = false
const stubTransport = {
    sendMail: async (job) => {
        if (relayExplodes) throw new Error('relay exploded')
        sent.push(job)
        return { messageId: `stub-${sent.length}` }
    },
    close: () => {},
}

/** Point the service at the stub relay and the two test owners.
 * @param {Record<string, *>} [extra={}] - Config values overriding the defaults
 * @returns {Promise<void>} */
async function useWorkingChannel(extra = {}) {
    //  Drain any sends still queued from a previous scenario while the transport is
    //  still the stub, so they never run against the real relay that init() rebuilds.
    await EmailService.flush()
    process.env.SMTP_HOST = 'smtp.test.local'
    process.env.SMTP_PORT = '465'
    process.env.SMTP_SECURE = 'true'
    process.env.SMTP_USER = 'automaton@test.local'
    process.env.SMTP_PASS = 'secret'
    setConfig({
        'email.enabled': true,
        'email.from': 'automaton@test.local',
        'email.subject_prefix': 'Automaton',
        'email.cooldown_ms': '60m',
        'email.notify': { sensor_frozen: true },
        'house_owners': [
            { name: 'Anna', email: 'anna@test.local' },
            { name: 'Jan', email: 'jan@test.local' },
        ],
        ...extra,
    })
    await EmailService.init()
    EmailService.attachTransport(stubTransport)
}

/** Reset the recorded sends and markers between scenarios.
 * @returns {void} */
function resetSends() {
    sent.length = 0
    markerStore.clear()
    relayExplodes = false
}

const STUCK_TOKENS = { frozen_sensors: 'Gerbera (40%)', frozen_window: '24h' }
const STUCK_MESSAGE = 'Soil probe Gerbera has not moved in 24h.'

try {
    // -----------------------------------------------------------------------
    console.log('\n-- configuration gates --')
    resetSends()
    setConfig({ 'email.enabled': true })
    assert(EmailService.isConfigured() === false, 'no SMTP_HOST means the relay is not configured')
    await EmailService.init()
    assert(EmailService.isReady() === true && EmailService.isEnabled() === false,
        'init() without a relay marks the service ready and disabled')
    assert(await EmailService.notify({ kind: 'sensor_frozen', message: STUCK_MESSAGE }) === false,
        'a disabled channel accepts no notification')
    assert(EmailService.send({ to: 'anna@test.local', subject: 'x', text: 'y' }) === false,
        'a disabled channel queues no message')
    assert(await EmailService.test() === false, 'a disabled channel queues no test mail')

    await useWorkingChannel({ 'email.from': 'not a mail address' })
    assert(EmailService.isEnabled() === false,
        'an email.from that is not an address disables the channel')

    await useWorkingChannel({ 'email.from': '', 'email.enabled': false })
    assert(EmailService.isEnabled() === false, 'email.enabled:false disables the channel even with a relay set')

    await useWorkingChannel({ 'email.from': '' })
    assert(EmailService.isEnabled() === true, 'the SMTP login address is used as the sender when email.from is empty')

    // -----------------------------------------------------------------------
    console.log('\n-- recipients from house_owners --')
    await useWorkingChannel({
        'house_owners': [
            { name: 'Anna', email: 'anna@test.local' },
            { name: '', email: 'jan@test.local' },
            'bozena@test.local',
            { name: 'Broken', email: 'not-an-address' },
            { name: 'Empty', email: '' },
            null,
        ],
    })
    const owners = EmailService.getRecipients()
    assert(owners.length === 3, 'entries without a usable address are dropped')
    assert(owners[1].name === 'jan' && owners[2].name === 'bozena',
        'a missing name falls back to the local part of the address')
    assert(EmailService.getRecipients().length === 3, 'the recipient list is rebuilt on every read')

    // -----------------------------------------------------------------------
    console.log('\n-- notification gating --')
    await useWorkingChannel()
    resetSends()
    assert(await EmailService.notify({ message: STUCK_MESSAGE }) === false, 'notify() without a kind sends nothing')
    assert(sent.length === 0, 'a kindless request queues no mail')
    assert(await EmailService.notify({ kind: 'sensor_frozen', message: '   ' }) === false,
        'notify() with an empty body sends nothing')
    assert(await EmailService.notify({ kind: 'unknown_kind', message: STUCK_MESSAGE }) === true,
        'a kind with no switch set is allowed to mail')

    await useWorkingChannel({ 'email.notify': { sensor_frozen: false } })
    resetSends()
    assert(await EmailService.notify({ kind: 'sensor_frozen', message: STUCK_MESSAGE }) === false,
        'a kind switched off in email.notify never mails')
    assert(sent.length === 0, 'the switched-off kind queued nothing')

    await useWorkingChannel({ 'house_owners': [] })
    resetSends()
    assert(await EmailService.notify({ kind: 'sensor_frozen', message: STUCK_MESSAGE }) === false,
        'an empty owners list notifies nobody')

    // -----------------------------------------------------------------------
    console.log('\n-- template rendering --')
    const bundle = yamlParse(readFileSync(resolve(ROOT, 'etc', 'i18n', 'pl_PL', 'email.yaml'), 'utf8'))
    const expectedSubject = bundle.sensor_frozen.subject.replace('{% frozen_sensors %}', STUCK_TOKENS.frozen_sensors)
    await useWorkingChannel()
    resetSends()
    const accepted = await EmailService.notify({
        kind: 'sensor_frozen',
        tokens: STUCK_TOKENS,
        message: STUCK_MESSAGE,
        meta: { frozen_count: '1' },
    })
    await EmailService.flush()
    assert(accepted === true, 'the stuck notification is accepted')
    assert(sent.length === 2, 'every owner gets exactly one copy')
    const mail = sent[0]
    assert(mail.from === 'automaton@test.local', 'the sender is the configured address')
    assert(mail.to === 'anna@test.local', 'the first copy goes to the first owner')
    assert(mail.subject === `Automaton: ${expectedSubject}`, 'the subject follows the bundle template with the prefix')
    assert(mail.text.includes('Anna'), 'the greeting addresses the owner by name')
    assert(mail.text.includes(STUCK_MESSAGE), 'the body carries the very text the speech used')
    assert(mail.text.includes('--'), 'the body carries the signature marker')
    assert(mail.text.includes('automatyczna obsluga domu'), 'the body carries the bundle signature')
    assert(mail.text.includes(os.hostname()), 'the footer names the machine that generated the mail')
    assert(!mail.text.includes('{%'), 'no unanswered placeholder survives in a mail')

    await useWorkingChannel({ 'email.subject_prefix': '', 'email.cooldown_ms': 0 })
    resetSends()
    await EmailService.notify({ kind: 'sensor_frozen', tokens: STUCK_TOKENS, message: STUCK_MESSAGE })
    await EmailService.flush()
    assert(sent[0].subject === expectedSubject, 'an empty email.subject_prefix drops the prefix from the subject')

    await useWorkingChannel({ 'email.cooldown_ms': 0 })
    resetSends()
    await EmailService.notify({ kind: 'boiler_fault', message: 'Boiler fault.' })
    await EmailService.flush()
    assert(sent[0].subject === 'Automaton: Boiler fault',
        'a kind with no template section gets a subject built from its key')
    assert(sent[0].text === 'Boiler fault.', 'a kind with no template section sends the announcement alone')

    // -----------------------------------------------------------------------
    //  Fresh kinds (cool_a/b/c) are used so the in-memory cooldown map, which
    //  persists across the re-inits this test performs, cannot leak state in.
    console.log('\n-- per-kind cooldown --')
    await useWorkingChannel({ 'email.cooldown_ms': '60m' })
    resetSends()
    assert(await EmailService.notify({ kind: 'cool_a', tokens: STUCK_TOKENS, message: STUCK_MESSAGE }) === true,
        'the first notification of a kind mails')
    assert(markerStore.has('mail:cooldown:cool_a'), 'the notification stores its Redis cooldown marker')
    await EmailService.flush()
    const firstRound = sent.length
    assert(await EmailService.notify({ kind: 'cool_a', tokens: STUCK_TOKENS, message: STUCK_MESSAGE }) === false,
        'the same kind inside the cooldown window stays silent')
    assert(sent.length === firstRound, 'the cooled-down copy is never queued')
    assert(await EmailService.notify({ kind: 'cool_b', message: 'Boiler fault.' }) === true,
        'a different kind is not cooled by the first mail')

    cacheDown = true
    assert(await EmailService.notify({ kind: 'cool_a', tokens: STUCK_TOKENS, message: STUCK_MESSAGE }) === false,
        'a Redis outage falls back to the in-memory cooldown marker')
    cacheDown = false

    await useWorkingChannel({ 'email.cooldown_ms': 0 })
    resetSends()
    await EmailService.notify({ kind: 'cool_c', tokens: STUCK_TOKENS, message: STUCK_MESSAGE })
    assert(await EmailService.notify({ kind: 'cool_c', tokens: STUCK_TOKENS, message: STUCK_MESSAGE }) === true,
        'cooldown_ms 0 mails every event')
    assert(!markerStore.has('mail:cooldown:cool_c'), 'cooldown_ms 0 stores no marker')

    // -----------------------------------------------------------------------
    console.log('\n-- configuration-check mail --')
    await useWorkingChannel()
    resetSends()
    assert(await EmailService.test() === true, 'the test mail is queued for every owner')
    await EmailService.flush()
    assert(sent.length === 2, 'the test mail reaches every owner')
    assert(sent[0].subject === `Automaton: ${bundle.test.subject}`, 'the test mail uses the bundle subject')
    assert(sent[0].text.includes(bundle.test.body.slice(0, 30)), 'the test body comes from the bundle')
    assert(sent[0].text.includes('Anna'), 'the test mail greets the owner by name')

    resetSends()
    assert(await EmailService.test('guest@test.local') === true, 'an explicit address overrides the owners list')
    await EmailService.flush()
    assert(sent.length === 1 && sent[0].to === 'guest@test.local', 'the explicit address is the only recipient')

    await EmailService.notify({ kind: 'cool_d', tokens: STUCK_TOKENS, message: STUCK_MESSAGE })
    resetSends()
    assert(await EmailService.test() === true, 'the cooldown never silences a requested test mail')

    await useWorkingChannel({ 'house_owners': [] })
    assert(await EmailService.test() === false, 'with no owner listed the test mail reports nothing to test')

    // -----------------------------------------------------------------------
    console.log('\n-- queue, counters and failures --')
    await useWorkingChannel({ 'email.cooldown_ms': 0 })
    resetSends()
    const before = EmailService.getStats()
    for (let i = 0; i < 30; i++) EmailService.send({ to: 'anna@test.local', subject: 'x', text: `body ${i}` })
    const mid = EmailService.getStats()
    assert(mid.skipped - before.skipped === 5, 'the queue caps at 25 pending sends')
    await EmailService.flush()
    assert(sent.length === 25, 'the queued sends drain in order')

    relayExplodes = true
    assert(EmailService.send({ to: 'anna@test.local', subject: 'x', text: 'will fail' }) === true,
        'a send is accepted before the relay is known to be down')
    await EmailService.flush()
    const after = EmailService.getStats()
    assert(after.failed - mid.failed === 1, 'a failed delivery is counted and the chain survives')
    relayExplodes = false

    assert(EmailService.send({ to: 'nope', subject: 'x', text: 'y' }) === false, 'an invalid recipient address is refused')
    assert(EmailService.send({ to: 'anna@test.local', subject: 'x', text: '   ' }) === false, 'an empty body is refused')
    assert(EmailService.send({ to: 'anna@test.local', subject: 'x', text: 'a'.repeat(5000) }) === true,
        'an oversized body is accepted, truncated')
    await EmailService.flush()
    const last = sent[sent.length - 1]
    assert(last.text.length <= 4000 && last.text.endsWith('...'), 'the oversized body is truncated at the ceiling')

    // -----------------------------------------------------------------------
    console.log('\n-- shared notify:email channel --')
    await useWorkingChannel({ 'email.cooldown_ms': 0 })
    resetSends()
    EventBus.emit('notify:email', { kind: 'cool_e', message: STUCK_MESSAGE, tokens: STUCK_TOKENS })
    //  The subscription calls notify() fire-and-forget; let those async calls reach
    //  their send() calls (and queue on the chain) before we drain it.
    await new Promise((r) => setTimeout(r, 0))
    await EmailService.flush()
    assert(sent.length >= 2, 'a payload on notify:email reaches the owners')

    // -----------------------------------------------------------------------
    console.log('\n-- cleanup --')
    await EmailService.cleanup()
    assert(EmailService.isEnabled() === false, 'cleanup() disables the channel')
    assert(EmailService.send({ to: 'anna@test.local', subject: 'x', text: 'y' }) === false,
        'no send is accepted after cleanup')
} catch (error) {
    console.error(`\n  FATAL - ${error.stack}`)
    failed++
} finally {
    cfgProto.get = origCfgGet
    cacheProto.get = origCacheGet
    cacheProto.set = origCacheSet
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}



