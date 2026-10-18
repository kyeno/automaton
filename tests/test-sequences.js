/**
 * Tests for the sequence entity -- SequenceBase run engine + loop state machine + container.
 *
 * Covers the approved design (doc/architecture/sequence-entity.md section 8) by driving
 * instances directly against mock devices registered through a stubbed findByName lookup:
 *   - A: simple-form ON run walks the ordered list with inter-step pacing respected;
 *   - B: endpoint mode (no delay) fires all steps back-to-back; OFF sends plain 'OFF';
 *   - C: rich form passes explicit on/off payloads verbatim (hazard-light shape); missing
 *     off: defaults to plain OFF over the on devices;
 *   - D: blocking mutex rejects concurrent runs and loop starts while an instance is busy;
 *   - E: loop cycle once completes ON -> gap -> OFF -> idle with correct state keys, and
 *     stopLoop() during the inter-phase wait cancels cleanly straight to IDLE;
 *   - F: continuous loops oscillate repeatedly until stopLoop(); stopping mid-phase lets that
 *     phase finish, then halts (exact command balance asserted);
 *   - G: missing referenced devices are inert steps -- remaining steps still execute;
 *   - H: container smoke test -- init resolves entries from a config file without crashing and
 *     unknown slugs warn gracefully;
 *   - I: continuous loops honor BOTH inter-phase gaps (off_delay before OFF runs, on_delay
 *     before ON runs) and still halt cleanly; stopping during/after an OFF phase cancels the
 *     pre-ON wait so no next ON is ever issued.
 *   - J: /config reload path -- reloadSequences() rebuilds the live registry from edited disk state:
 *     added entries go live immediately, removed ones vanish with their engaged loop stopped
 *     gracefully, renamed definitions change behavior without a restart, and an unreadable file
 *     keeps the previous registry intact (two-phase safe swap).
 * Uses short real delays (no fake timers); every block restores DeviceContainer before exiting.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import StateService from '../src/service/stateService.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import SequenceBase from '../src/sequence/base/sequenceBase.js'
import SequenceContainer from '../src/sequence/container/sequenceContainer.js'
import DeviceCommandSource from '../src/enum/deviceCommandSource.js'

// Minimal env bootstrap so services can be imported and LoggerService works headless.
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
await LoggerService.init?.()

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  ✓ ${label}`)
        passed++
    } else {
        console.error(`  ✗ ${label}`)
        failed++
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mock device. Commands are recorded verbatim ({cmd, source}); an optional sharedLog receives a
 * "name:payload" line per command so scenarios can assert the GLOBAL cross-device order.
 */
class MockDevice {
    constructor(name, sharedLog = null) {
        this.name = name
        this.commands = []
        this._sharedLog = sharedLog
    }
    receiveCommand(cmd, source) {
        this.commands.push({ cmd, source })
        if (this._sharedLog) this._sharedLog.push(`${this.name}:${typeof cmd === 'string' ? cmd : JSON.stringify(cmd)}`)
        return true
    }
    getStateLast() {
        const last = this.commands[this.commands.length - 1]
        return last ? (typeof last.cmd === 'string' ? { state: last.cmd } : last.cmd) : {}
    }
}

function stubDeviceLookup(table) {
    const proto = Object.getPrototypeOf(DeviceContainer)
    const origFindByName = proto.findByName
    proto.findByName = (name) => table[name] ?? null
    return () => {
        proto.findByName = origFindByName
    }
}

{
    // -- A: simple-form ON run walks the ordered list with pacing --------------
    const log = []
    const alpha = new MockDevice('Alpha', log)
    const beta = new MockDevice('Beta', log)
    const gamma = new MockDevice('Gamma', log)
    const restore = stubDeviceLookup({ 'Alpha': alpha, 'Beta': beta, 'Gamma': gamma })
    try {
        const seq = new SequenceBase('Paced Lights', {
            delay: '40ms',
            devices: ['Alpha', 'Beta', 'Gamma']
        })
        await seq.init()
        const t0 = Date.now()
        const ok = await seq.run('ON')
        const elapsed = Date.now() - t0
        assert(ok === true, 'A: run(ON) accepted and executed')
        assert(log.length === 3 && log[0] === 'Alpha:ON' && log[1] === 'Beta:ON' && log[2] === 'Gamma:ON',
            `A: command order matches config order (got ${JSON.stringify(log)})`)
        assert(alpha.commands.every(c => c.source === DeviceCommandSource.AUTOMATION),
            'A: commands carry AUTOMATION provenance')
        assert(elapsed >= 70 && elapsed < 3000,
            `A: inter-step pacing respected -- two 40ms gaps produced ${elapsed}ms total`)
        seq.cleanup()
    } finally {
        restore()
    }
}

{
    // -- B: endpoint mode (no delay) fires back-to-back; OFF sends plain OFF --
    const alpha = new MockDevice('Alpha')
    const beta = new MockDevice('Beta')
    const gamma = new MockDevice('Gamma')
    const restore = stubDeviceLookup({ 'Alpha': alpha, 'Beta': beta, 'Gamma': gamma })
    try {
        const seq = new SequenceBase('Endpoint Lights', { devices: ['Alpha', 'Beta', 'Gamma'] })
        await seq.init()
        const t0 = Date.now()
        const okOn = await seq.run('ON')
        const onElapsed = Date.now() - t0
        assert(okOn === true && onElapsed < 100,
            `B: no delay => all steps fired without waiting (${onElapsed}ms)`)
        assert(alpha.commands.length === 1 && alpha.commands[0].cmd === 'ON'
            && beta.commands.length === 1 && gamma.commands.length === 1,
            'B: every device received ON exactly once')
        const okOff = await seq.run('OFF')
        assert(okOff === true
            && alpha.commands.at(-1).cmd === 'OFF'
            && beta.commands.at(-1).cmd === 'OFF'
            && gamma.commands.at(-1).cmd === 'OFF',
            'B: OFF run sends plain OFF to every device')
        seq.cleanup()
    } finally {
        restore()
    }
}

{
    // -- C: rich form payloads pass through verbatim; missing off: defaults ----
    const dimmer = new MockDevice('Salon Dimmer')
    const restore = stubDeviceLookup({ 'Salon Dimmer': dimmer })
    try {
        const hazard = new SequenceBase('Hazard Light', {
            loop: { enabled: true, cycle: 'continuous', off_delay: 'auto' },
            on: [{ device: 'Salon Dimmer', payload: { state: 'ON', brightness: { l1: 1, l2: 25 } } }],
            off: [{ device: 'Salon Dimmer', payload: { state: 'ON', brightness: { l1: 100, l2: 75 } } }]
        })
        await hazard.init()
        assert(await hazard.run('ON') === true, 'C: ON run accepted')
        assert(JSON.stringify(dimmer.commands[0].cmd) === JSON.stringify({ state: 'ON', brightness: { l1: 1, l2: 25 } }),
            `C: on-payload passed verbatim (got ${JSON.stringify(dimmer.commands[0]?.cmd)})`)
        assert(dimmer.commands[0].source === DeviceCommandSource.AUTOMATION, 'C: rich-form command provenance is AUTOMATION')
        assert(await hazard.run('OFF') === true, 'C: OFF run accepted')
        assert(JSON.stringify(dimmer.commands.at(-1).cmd) === JSON.stringify({ state: 'ON', brightness: { l1: 100, l2: 75 } }),
            `C: off-payload passed verbatim (got ${JSON.stringify(dimmer.commands.at(-1)?.cmd)})`)

        //  Missing off: -> plain OFF over the same ordered devices from on.
        const noOff = new SequenceBase('No Off List', {
            on: [{ device: 'Salon Dimmer', payload: { state: 'ON', brightness: { l1: 42 } } }]
        })
        await noOff.init()
        dimmer.commands.length = 0
        assert(await noOff.run('OFF') === true, 'C: default-OFF run accepted when off: absent')
        assert(dimmer.commands.length === 1 && dimmer.commands[0].cmd === 'OFF',
            `C: missing off: defaults to plain OFF over on devices (got ${JSON.stringify(dimmer.commands.map(c => c.cmd))})`)
        hazard.cleanup()
        noOff.cleanup()
    } finally {
        restore()
    }
}

{
    // -- D: blocking mutex rejects concurrent runs and loop starts -------------
    const alpha = new MockDevice('Alpha')
    const beta = new MockDevice('Beta')
    const restore = stubDeviceLookup({ 'Alpha': alpha, 'Beta': beta })
    try {
        const seq = new SequenceBase('Busy Loop Seq', {
            loop: { enabled: true, cycle: 'once', off_delay: 'auto' },
            devices: [{ device: 'Alpha', delay: '80ms' }, { device: 'Beta' }]
        })
        await seq.init()
        const firstRun = seq.run('ON')   // in flight for >= 80ms; #busy set synchronously
        const rejectedRun = await seq.run('OFF')
        assert(rejectedRun === false, 'D: second concurrent run() while active is rejected (returns false)')
        const rejectedLoop = await seq.startLoop()
        assert(rejectedLoop === false, 'D: startLoop() during an active run is rejected too')
        const okFirst = await firstRun
        assert(okFirst === true, 'D: the original run completed successfully')
        assert(alpha.commands.length === 1 && beta.commands.length === 1
            && alpha.commands[0].cmd === 'ON' && beta.commands[0].cmd === 'ON',
            `D: only the accepted run issued commands (${alpha.commands.length}+${beta.commands.length})`)
        seq.cleanup()
    } finally {
        restore()
    }
}

{
    // -- E1: loop cycle once completes ON -> gap -> OFF -> idle -----------------
    const a = new MockDevice('Alpha')
    const b = new MockDevice('Beta')
    const restore = stubDeviceLookup({ 'Alpha': a, 'Beta': b })
    try {
        const slug = 'loop_once_seq'
        const seq = new SequenceBase('Loop Once Seq', {
            loop: { enabled: true, cycle: 'once', off_delay: '60ms' },
            devices: [{ device: 'Alpha', delay: '60ms' }, { device: 'Beta' }]
        })
        await seq.init()
        assert(seq.getSlug() === slug, 'E1: slug derived with slugify()')
        const started = await seq.startLoop()
        assert(started === true, 'E1: startLoop() engaged the session')
        let sawOnPhase = false
        let sawOffPhase = false
        let sawLoopKey = false
        for (let i = 0; i < 400 && seq.isLoopActive(); i++) {
            const phase = StateService.get(`sequence.${slug}.phase`)
            if (phase === 'on') sawOnPhase = true
            if (phase === 'off') sawOffPhase = true
            if (StateService.get(`sequence.${slug}.loop.active`) === true) sawLoopKey = true
            await sleep(3)
        }
        assert(sawOnPhase && sawOffPhase, `E1: phase key walked on -> off (on=${sawOnPhase} off=${sawOffPhase})`)
        assert(sawLoopKey, 'E1: loop.active state key was set during the session')
        assert(!seq.isActive() && !seq.isLoopActive(), 'E1: instance idle after a single ON->OFF pass')
        assert(a.commands.map(c => c.cmd).join(',') === 'ON,OFF'
            && b.commands.map(c => c.cmd).join(',') === 'ON,OFF',
            `E1: exact command sequence per device (a=[${a.commands.map(c => c.cmd)}] b=[${b.commands.map(c => c.cmd)}])`)
        assert(StateService.get(`sequence.${slug}.active`) === undefined
            && StateService.get(`sequence.${slug}.phase`) === undefined
            && StateService.get(`sequence.${slug}.loop.active`) === undefined,
            'E1: all state keys cleared at IDLE')
        seq.cleanup()
    } finally {
        restore()
    }
}

{
    // -- E2: stopLoop() DURING the inter-phase wait goes straight to IDLE ------
    const a = new MockDevice('Alpha')
    const b = new MockDevice('Beta')
    const restore = stubDeviceLookup({ 'Alpha': a, 'Beta': b })
    try {
        const slug = 'stop_during_wait_seq'
        const seq = new SequenceBase('Stop During Wait Seq', {
            loop: { enabled: true, cycle: 'once', off_delay: '400ms' },
            devices: [{ device: 'Alpha', delay: '60ms' }, { device: 'Beta' }]
        })
        await seq.init()
        await seq.startLoop()
        await sleep(150)   // past ON completion (>=60ms), well inside the 400ms gap
        assert(seq.isActive(), 'E2: instance stays busy through the inter-phase window')
        const stopped = seq.stopLoop()
        assert(stopped === true, 'E2: stopLoop() accepted during WAITING_OFF')
        await sleep(30)
        assert(!seq.isActive() && !seq.isLoopActive(), 'E2: went straight to IDLE after cancelling the timer')
        assert(a.commands.length === 1 && b.commands.length === 1
            && a.commands[0].cmd === 'ON' && b.commands[0].cmd === 'ON',
            `E2: OFF phase never started (${a.commands.map(c => c.cmd)} / ${b.commands.map(c => c.cmd)})`)
        assert(StateService.get(`sequence.${slug}.loop.active`) === undefined, 'E2: loop state key cleared at IDLE')
        seq.cleanup()
    } finally {
        restore()
    }
}

{
    // -- F: continuous loops oscillate until stopLoop(); mid-phase stop finishes --
    const omega = new MockDevice('Omega')
    const restore = stubDeviceLookup({ 'Omega': omega })
    try {
        const seq = new SequenceBase('Continuous Oscillator', {
            loop: { enabled: true, cycle: 'continuous', off_delay: 'auto' },
            devices: ['Omega']
        })
        await seq.init()
        const started = await seq.startLoop()
        assert(started === true, 'F: continuous loop started')
        let total = 0
        for (let i = 0; i < 600 && total < 6; i++) {
            total = omega.commands.length
            if (total >= 6) break
            await sleep(5)
        }
        assert(total >= 6, `F: oscillated repeatedly before stopping (${total} commands in the window)`)
        const stopped = seq.stopLoop()
        assert(stopped === true, 'F: stopLoop() accepted while looping')
        //  Mid-phase stop lets that phase finish -> ON/OFF counts stay balanced.
        await sleep(120)
        const finalTotal = omega.commands.length
        const onCount = omega.commands.filter(c => c.cmd === 'ON').length
        const offCount = omega.commands.filter(c => c.cmd === 'OFF').length
        assert(!seq.isActive() && !seq.isLoopActive(), 'F: halted after the in-flight phase finished')
        assert(Math.abs(onCount - offCount) <= 1,
            `F: no half-configured device -- phases completed whole (on=${onCount} off=${offCount})`)
        await sleep(150)
        assert(omega.commands.length === finalTotal, 'F: no further commands after halt')
        seq.cleanup()
    } finally {
        restore()
    }
}

{
    // -- G: missing referenced devices are inert steps --------------------------
    const alpha = new MockDevice('Alpha')
    const beta = new MockDevice('Beta')
    const restore = stubDeviceLookup({ 'Alpha': alpha, 'Beta': beta })   // "Ghost" absent on purpose
    try {
        const seq = new SequenceBase('Missing Device Seq', { devices: ['Alpha', 'Ghost', 'Beta'] })
        await seq.init()
        const ok = await seq.run('ON')
        assert(ok === true, 'G: run succeeds despite a missing device (warns, does not crash)')
        assert(alpha.commands.length === 1 && beta.commands.length === 1
            && alpha.commands[0].cmd === 'ON' && beta.commands[0].cmd === 'ON',
            'G: remaining steps still executed in order around the inert step')
        seq.cleanup()
    } finally {
        restore()
    }
}

{
    // -- H: container smoke test -- init from config file; unknown slugs warn ---
    const tmpPath = path.join(os.tmpdir(), `sequences-test-${process.pid}.yaml`)
    fs.writeFileSync(tmpPath, [
        'sequences:',
        "  - name: 'Smoke Simple'",
        '    devices:',
        "      - 'Smoke A'",
        "  - name: 'Smoke Loop'",
        '    loop:',
        '      enabled: true',
        '      cycle: once',
        '      off_delay: auto',
        '    on:',
        "      - device: 'Smoke B'",
        '        payload: { state: ON, brightness: { l1: 50 } }',
        ''
    ].join('\n'))
    const mockA = new MockDevice('Smoke A')
    const mockB = new MockDevice('Smoke B')
    const restoreLookup = stubDeviceLookup({ 'Smoke A': mockA, 'Smoke B': mockB })
    const cfgProto = Object.getPrototypeOf(ConfigService)
    const origGetConfigPath = cfgProto.getConfigPath
    try {
        cfgProto.getConfigPath = (name) => (name === 'sequence' ? tmpPath : origGetConfigPath.call(cfgProto, name))
        await SequenceContainer.init()

        assert(SequenceContainer.getNames().includes('smoke_simple'), 'H: init registered the simple-form entry')
        assert(SequenceContainer.getNames().includes('smoke_loop'), 'H: init registered the rich-form entry')
        assert((SequenceContainer.getAll() ?? []).length === 2, `H: exactly two instances loaded (${(SequenceContainer.getAll() ?? []).length})`)

        //  Friendly-name resolution + a real run through the container API.
        const byName = SequenceContainer.resolveSequence('Smoke Loop')
        assert(byName !== null && byName.getSlug() === 'smoke_loop', 'H: resolveSequence accepts friendly names case-insensitively')
        assert(await SequenceContainer.callCommand('smoke_simple', 'ON') === true, 'H: callCommand by slug executed')
        assert(mockA.commands.length === 1 && mockA.commands[0].cmd === 'ON', 'H: command reached the device via the container path')
        assert(await SequenceContainer.callCommand('SMOKE LOOP', 'OFF') === true, 'H: callCommand resolves multi-word friendly names')

        //  Unknown slugs warn gracefully -- no crash, false returns.
        assert(await SequenceContainer.callCommand('does_not_exist', 'ON') === false, 'H: unknown-slug callCommand warns and returns false')
        assert(await SequenceContainer.startLoop('nope') === false, 'H: unknown-slug startLoop warns and returns false')
        assert(SequenceContainer.stopLoop('nope') === false, 'H: unknown-slug stopLoop warns and returns false')
        assert(SequenceContainer.isLoopActive('nope') === false, 'H: unknown-slug isLoopActive is false')

        await SequenceContainer.cleanupSequences()
    } finally {
        cfgProto.getConfigPath = origGetConfigPath
        restoreLookup()
        try { fs.unlinkSync(tmpPath) } catch { /* best effort */ }
    }
}

{
    // -- J: /config reload path -- reloadSequences() rebuilds the live registry from disk --------
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-seq-reload-'))
    const seqFile = path.join(dir, 'sequences.yaml')
    const jlog = []
    const jalpha = new MockDevice('JAlpha', jlog)
    const jbeta = new MockDevice('JBeta', jlog)
    const jloop = new MockDevice('JLoopDev', jlog)
    const jgamma = new MockDevice('JGammaDev', jlog)
    const restoreLookup = stubDeviceLookup({ 'JAlpha': jalpha, 'JBeta': jbeta, 'JLoopDev': jloop, 'JGammaDev': jgamma })
    const cfgProto = Object.getPrototypeOf(ConfigService)
    const origGetConfigPath = cfgProto.getConfigPath
    try {
        fs.writeFileSync(seqFile, [
            'sequences:',
            "  - name: 'Reload Alpha'",
            "    delay: '30ms'",
            '    devices:',
            "      - 'JAlpha'",
            "      - 'JBeta'",
            "  - name: 'Reload Beta Loop'",
            '    loop:',
            '      enabled: true',
            '      cycle: continuous',
            '      off_delay: auto',
            '      on_delay: auto',
            '    devices:',
            "      - 'JLoopDev'",
            ''
        ].join('\n'))
        cfgProto.getConfigPath = (name) => (name === 'sequence' ? seqFile : origGetConfigPath.call(cfgProto, name))

        //  First rebuild replaces whatever scenario H left behind -- stale slugs must be reported removed.
        let r0 = await SequenceContainer.reloadSequences()
        assert(r0.ok === true, 'J: first rebuild reports ok')
        assert(SequenceContainer.isInitialized() === true, 'J: container reports initialized after a build attempt')
        assert(SequenceContainer.getNames().includes('reload_alpha'), 'J: added simple-form entry registered')
        assert(SequenceContainer.getNames().includes('reload_beta_loop'), 'J: added looping entry registered')
        assert(!SequenceContainer.getNames().includes('smoke_simple'), 'J: scenario-H slug gone after the rebuild')
        assert(r0.removed.includes('smoke_simple') && r0.removed.includes('smoke_loop'), `J: stale slugs named in the report (${r0.removed.join(', ')})`)
        assert(r0.added.includes('reload_alpha') && r0.added.includes('reload_beta_loop'), `J: new slugs named as added (${r0.added.join(', ')})`)

        //  The v1 definition is live immediately -- original step order honored through the container.
        const markV1 = jlog.length
        assert(await SequenceContainer.callCommand('Reload Alpha', 'ON') === true, 'J: freshly built entry runs through the container')
        assert(jlog.slice(markV1).join('|') === 'JAlpha:ON|JBeta:ON',
            `J: v1 step order executed (got ${JSON.stringify(jlog.slice(markV1))}))`)
        //  Engage a continuous loop on the OLD instance, then reload with an edited file mid-oscillation.
        const betaLoop = SequenceContainer.resolveSequence('Reload Beta Loop')
        assert(betaLoop !== null && await betaLoop.startLoop() === true, 'J: pre-reload loop engaged on the old instance')
        let sawOscillation = false
        for (let i = 0; i < 200 && !sawOscillation; i++) {
            sawOscillation = jloop.commands.some(c => c.cmd === 'OFF')
            if (!sawOscillation) await sleep(5)
        }
        assert(sawOscillation, 'J: loop was actually oscillating before the reload')

        fs.writeFileSync(seqFile, [
            'sequences:',
            "  - name: 'Reload Alpha'",
            "    delay: '80ms'",
            '    devices:',
            "      - 'JBeta'",     // order flipped vs v1 -- must be visible in command order after reload
            "      - 'JAlpha'",
            "  - name: 'Reload Gamma'",
            '    devices:',
            "      - 'JGammaDev'",
            ''
        ].join('\n'))

        const r1 = await SequenceContainer.reloadSequences()
        assert(r1.ok === true, 'J: mid-loop rebuild reports ok')
        assert(r1.added.includes('reload_gamma'), `J: newly added slug reported (${r1.added.join(', ')})`)
        assert(r1.removed.includes('reload_beta_loop'), `J: removed slug reported (${r1.removed.join(', ')})`)
        assert(!SequenceContainer.getNames().includes('reload_beta_loop'), 'J: removed sequence no longer resolvable by slug')
        assert(SequenceContainer.resolveSequence('Reload Beta Loop') === null, 'J: friendly-name lookup for the removed entry returns null')

        //  Graceful stop: let any in-flight phase finish, then nothing may fire on the old loop device.
        await sleep(300)
        const settledLoopCount = jloop.commands.length
        await sleep(250)
        assert(jloop.commands.length === settledLoopCount, 'J: engaged loop halted -- no further commands after teardown')
        assert(StateService.get('sequence.reload_beta_loop.loop.active') === undefined, 'J: stale loop state key cleared by teardown')

        //  The edited definition is live: flipped step order now executes JBeta before JAlpha.
        const markV2 = jlog.length
        assert(await SequenceContainer.callCommand('Reload Alpha', 'ON') === true, 'J: surviving entry re-runnable after rebuild')
        assert(jlog.slice(markV2).join('|') === 'JBeta:ON|JAlpha:ON',
            `J: v2 step order executed without a restart (got ${JSON.stringify(jlog.slice(markV2))}))`)

        const markGamma = jlog.length
        assert(await SequenceContainer.callCommand('Reload Gamma', 'ON') === true, 'J: added sequence runnable through the container')
        assert(jlog.slice(markGamma).join('|') === 'JGammaDev:ON',
            `J: new entry reached its device (got ${JSON.stringify(jlog.slice(markGamma))}))`)

        //  Safe-swap negative case: an unreadable file keeps the current registry intact instead of wiping it.
        cfgProto.getConfigPath = (name) => (name === 'sequence' ? path.join(dir, 'missing.yaml') : origGetConfigPath.call(cfgProto, name))
        const r2 = await SequenceContainer.reloadSequences()
        assert(r2.ok === false, 'J: unreadable config reports not-ok instead of crashing')
        assert(SequenceContainer.getNames().includes('reload_alpha') && SequenceContainer.getNames().includes('reload_gamma'),
            'J: previous registry kept intact when the fresh read fails')

        await SequenceContainer.cleanupSequences()
    } finally {
        cfgProto.getConfigPath = origGetConfigPath
        restoreLookup()
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
}

{
    // -- I1: continuous loop honors BOTH inter-phase gaps; still stops cleanly -------
    const omega = new MockDevice('Omega')
    const restore = stubDeviceLookup({ 'Omega': omega })
    try {
        const seq = new SequenceBase('Dual Gap Oscillator', {
            loop: { enabled: true, cycle: 'continuous', off_delay: '120ms', on_delay: '120ms' },
            devices: ['Omega']
        })
        await seq.init()
        assert(await seq.startLoop() === true, 'I1: continuous loop with both gaps started')
        let total = 0
        for (let i = 0; i < 400 && total < 8; i++) {
            total = omega.commands.length
            if (total >= 8) break
            await sleep(5)
        }
        assert(total >= 8, `I1: oscillated repeatedly despite the configured gaps (${total} commands in window)`)
        const stopped = seq.stopLoop()
        assert(stopped === true, 'I1: stopLoop() accepted while looping')
        await sleep(300)   // past any in-flight phase + remaining gap so the driver has exited
        const finalTotal = omega.commands.length
        const onCount = omega.commands.filter(c => c.cmd === 'ON').length
        const offCount = omega.commands.filter(c => c.cmd === 'OFF').length
        assert(!seq.isActive() && !seq.isLoopActive(), 'I1: halted after the in-flight work finished')
        assert(Math.abs(onCount - offCount) <= 1,
            `I1: phases completed whole -- no half-configured device (on=${onCount} off=${offCount})`)
        await sleep(200)
        assert(omega.commands.length === finalTotal, 'I1: no further commands after halt')
        seq.cleanup()
    } finally {
        restore()
    }
}

{
    // -- I2: stop during/after an OFF phase cancels the pre-ON wait; next ON never issued
    const alpha = new MockDevice('Alpha')
    const beta = new MockDevice('Beta')
    const restore = stubDeviceLookup({ 'Alpha': alpha, 'Beta': beta })
    try {
        const slug = 'stop_during_on_wait_seq'
        const seq = new SequenceBase('Stop During On Wait Seq', {
            loop: { enabled: true, cycle: 'continuous', off_delay: 'auto', on_delay: '400ms' },
            devices: [{ device: 'Alpha', delay: '60ms' }, { device: 'Beta' }]
        })
        await seq.init()
        await seq.startLoop()
        //  Each phase takes >=60ms (paced two steps). Once Alpha's first OFF lands we are inside a
        //  safe zone of ~460ms before any next ON could arrive -- enough to stop and assert.
        let sawOff = false
        for (let i = 0; i < 1000 && !sawOff; i++) {
            sawOff = alpha.commands.some(c => c.cmd === 'OFF')
            if (!sawOff) await sleep(5)
        }
        assert(sawOff, 'I2: reached the first OFF phase')
        const stopped = seq.stopLoop()
        assert(stopped === true, 'I2: stopLoop() accepted during/after the OFF phase')
        await sleep(80)    // lets an in-flight Beta-OFF land if that step-list was still running
        const settledTotal = alpha.commands.length + beta.commands.length
        await sleep(250)   // well inside the uncancelled 400ms pre-ON window -> nothing may fire
        assert(alpha.commands.length + beta.commands.length === settledTotal,
            `I2: no further commands after halt (${settledTotal} total)`)
        assert(alpha.commands.filter(c => c.cmd === 'ON').length === 1
            && beta.commands.filter(c => c.cmd === 'ON').length === 1,
            'I2: next ON run never issued -- pre-ON wait cancelled (or loop exited before it)')
        assert(!seq.isActive() && !seq.isLoopActive(), 'I2: went straight to IDLE')
        assert(StateService.get(`sequence.${slug}.loop.active`) === undefined, 'I2: loop state key cleared at IDLE')
        seq.cleanup()
    } finally {
        restore()
    }
}

console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1