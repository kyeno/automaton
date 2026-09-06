/**
 * Integration tests for the opt-in react-on-change gate and the
 * state-changed-ago-minutes recency condition in RuleBasedAutomationBase.
 *
 * Uses a real DatabaseService (temp SQLite file) plus a minimal automation subclass
 * whose buildContext() records whether execution got past the gate -- a clean, async-safe
 * observable of "did this run proceed" without needing live devices.
 *
 * Proves:
 *   - A scheduled ('timer') tick is SKIPPED when no monitored subject changed since last eval,
 *     PROCEEDS once a transition occurs, then SKIPS again until another change; event-driven runs
 *     always proceed regardless. (trigger_on_change_only)
 *   - The recency condition fails while a subject changed recently, passes with no history, and
 *     ignores malformed bounds instead of failing closed. (state-changed-ago-minutes)
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DatabaseService from '../src/service/databaseService.js'
import RuleBasedAutomationBase from '../src/automation/base/ruleBasedAutomationBase.js'

process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'
await ConfigService.init()
LoggerService.init()

let passed = 0, failed = 0
function assert(cond, label) {
    if (cond) { console.log(`  ok - ${label}`); passed += 1 }
    else { console.error(`  FAIL - ${label}`); failed += 1 }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Isolated temp database + a config that monitors one video-player subject.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-rule-gate-'))
const dbFile = path.join(dir, 'state.db')
const cfgPath = path.join(dir, 'probe.yaml')
fs.writeFileSync(cfgPath, [
    'trigger_on_change_only: true',
    'rules:',
    "  - name: probe",
    '    conditions:',
    '      video-player: { htpc: [playing] }',
].join('\n'), 'utf8')

/** Minimal automation whose buildContext() flags whether execution got past the gate. */
class ProbeAuto extends RuleBasedAutomationBase {
    built = false
    async buildContext() { this.built = true; return {} }
    loadDevices() { return new Map() }   // empty -> execute stops right after context build
    resolveCommand() { return null }
}

async function main() {
    assert(await DatabaseService.init(dbFile), 'database available for rule tests')
    const auto = new ProbeAuto({ name: 'Probe', configPath: cfgPath })
    await sleep(25)   // ensure any later Date.now() is strictly greater than the construction baseline

    // -- Gate: skip when nothing changed since last evaluation --------------
    auto.built = false
    await auto.execute({ trigger: 'timer' })
    assert(auto.built === false, 'gate SKIPS a timer tick with no monitored change yet')

    // A real transition now occurs (recorded by the monitor in production).
    const rec = await DatabaseService.recordTransition({ domain: 'videoPlayer', subject: 'htpc', toState: 'playing' })
    assert(rec.changed === true, 'transition recorded as a genuine change')

    // -- Gate: proceed once a change occurred -------------------------------
    auto.built = false
    await auto.execute({ trigger: 'timer' })
    assert(auto.built === true, 'gate PROCEEDS on the next timer tick after a change')

    // ...and stays quiet again until another change happens.
    auto.built = false
    await auto.execute({ trigger: 'timer' })
    assert(auto.built === false, 'gate SKIPS subsequent ticks until a new change occurs')

    // Event-driven runs always proceed regardless of recent changes.
    auto.built = false
    await auto.execute({ trigger: 'videoPlayer:htpc' })
    assert(auto.built === true, 'event-driven run bypasses the gate and proceeds')

    // Forced runs also always proceed.
    auto.built = false
    await auto.execute({ trigger: 'timer', force: true })
    assert(auto.built === true, 'forced run bypasses the gate and proceeds')

    // -- Recency condition (state-changed-ago-minutes) ----------------------
    const ctx = {}
    assert(await auto.conditionsMatch({ 'state-changed-ago-minutes': { 'videoPlayer:bedroom': 5 } }, ctx),
        'recency PASSES when the subject has no recorded history')

    await DatabaseService.recordTransition({ domain: 'videoPlayer', subject: 'bedroom', toState: 'paused' })
    assert(!(await auto.conditionsMatch({ 'state-changed-ago-minutes': { 'videoPlayer:bedroom': 5 } }, ctx)),
        'recency FAILS while a change is more recent than the bound')

    assert(await auto.conditionsMatch({ 'state-changed-ago-minutes': { 'weird-ref': 'not-a-number' } }, ctx),
        'recency ignores malformed bounds instead of failing closed')
}

main()
    .then(() => {
        console.log(`\n${passed}/${passed + failed} rule react-on-change checks passed`)
        process.exit(failed > 0 ? 1 : 0)
    })
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
