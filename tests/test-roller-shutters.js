/**
 * Roller shutter interaction tests.
 *
 * Behavioral coverage for the shared travel logic in RollerShuttersBase and the
 * two concrete groups (Salon, Bedroom), driven by calling execute() directly
 * against mock shutters resolved through DeviceContainer.findByName:
 *   - single press runs the group fully OPEN/CLOSE, unchanged;
 *   - double press steps every shutter by 20% from its cached position, with
 *     the result clamped at 0 and 100;
 *   - when EVERY shutter of a group already sits at the requested end stop, the
 *     command is dropped and notifyAtLimit() beeps instead;
 *   - a partially-open group is still commanded (the gate needs all shutters);
 *   - an unknown cached position never blocks a real command: singles fail open,
 *     doubles skip that shutter instead of guessing a target;
 *   - the Bedroom outlet side effects fire on a real open/close but not on a
 *     double press and not when the end-stop gate swallowed the command;
 *   - Salon carries no outlet side effects.
 *
 * Uses short real delays (no fake timers) and always restores DeviceContainer
 * and the patched prototype method on exit.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import RollerShuttersBase from '../src/interaction/base/rollerShuttersBase.js'
import BedroomRollersInteraction from '../etc/interaction/bedroomRollersInteraction.js'
import SalonRollersInteraction from '../etc/interaction/salonRollersInteraction.js'

// Minimal env bootstrap so services import cleanly and LoggerService works headless.
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

await ConfigService.init()
await LoggerService.init?.()

let passed = 0
let failed = 0

/**
 * Record a passing assertion.
 * @param {boolean} condition - Assertion outcome
 * @param {string} label - Human readable description
 */
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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const SALON = ['Salon Roleta Okno Lewe', 'Salon Roleta Okno Prawe']
const BEDROOM = [
    'Sypialnia Roleta Okno Lewe Lewa',
    'Sypialnia Roleta Okno Lewe Prawa',
    'Sypialnia Roleta Okno Prawe Lewa',
    'Sypialnia Roleta Okno Prawe Prawa'
]
const OUTLETS = ['Sypialnia Gniazdo', 'Sypialnia Gniazdo Lustro']

/**
 * Mock roller shutter. Records every command verbatim and reports a fixed
 * cached position; `position` may be null to model "no data in cache".
 */
class MockShutter {
    /**
     * @param {number|null} position - Cached position reported by getStateLast()
     */
    constructor(position) {
        this.position = position
        this.commands = []
    }

    /**
     * @param {string|Object} command - Command as issued by the interaction
     * @param {string} source - Provenance tag
     */
    receiveCommand(command, source) {
        this.commands.push({ command, source })
    }

    /**
     * @returns {{position: (number|null)}} Cached state payload
     */
    getStateLast() {
        return { position: this.position }
    }
}

/**
 * Mock outlet. Records commands without touching shutter logic.
 */
class MockOutlet {
    /** Records every command issued to this outlet. */
    constructor() {
        this.commands = []
    }

    /**
     * @param {string} command - Command as issued by the interaction
     */
    receiveCommand(command) {
        this.commands.push(command)
    }

    /**
     * @returns {Object} Cached state payload
     */
    getStateLast() {
        return { state: 'OFF' }
    }
}

/** Mock illuminance sensor returning a fixed lux value. */
class MockSensor {
    /**
     * @param {number} illuminance - Lux value to report
     */
    constructor(illuminance) {
        this.illuminance = illuminance
    }

    /**
     * @returns {{illuminance: number}} Cached state payload
     */
    getStateLast() {
        return { illuminance: this.illuminance }
    }
}

/**
 * Swap DeviceContainer.findByName for a lookup table during a test block. The
 * container instance is frozen, so the method is patched on its (extensible)
 * prototype -- the same approach test-kitchen-countertop-led.js uses. Always
 * restored via the returned function.
 *
 * @param {Object<string, Object>} table - Device name to mock instance
 * @returns {Function} Restore callback
 */
function stubDeviceLookup(table) {
    const proto = Object.getPrototypeOf(DeviceContainer)
    const original = proto.findByName
    proto.findByName = (name) => table[name] ?? null
    return () => { proto.findByName = original }
}

/**
 * Capture end-stop beeps instead of spawning the system `beep` binary. Patches
 * the prototype method for the duration of a test block.
 *
 * @returns {{count: () => number, restore: Function}} Counter and restore callback
 */
function captureBeeps() {
    // Patch RollerShuttersBase's OWN prototype -- notifyAtLimit is defined
    // there, so a patch on the inherited InteractionBase.prototype would be
    // shadowed and never observed.
    const proto = RollerShuttersBase.prototype
    const original = proto.notifyAtLimit
    let count = 0
    proto.notifyAtLimit = function () { count++ }
    return { count: () => count, restore: () => { proto.notifyAtLimit = original } }
}

/**
 * Build a shutter group whose members all report the same cached position.
 *
 * @param {string[]} names - Shutter friendly names
 * @param {number|null} position - Cached position for each shutter
 * @returns {{table: Object<string, MockShutter>, shutters: MockShutter[]}} Lookup table and the mocks
 */
function group(names, position) {
    const shutters = names.map(name => new MockShutter(position))
    const table = Object.fromEntries(names.map((name, i) => [name, shutters[i]]))
    return { table, shutters }
}

/**
 * Collect the command payloads issued to a shutter.
 *
 * @param {MockShutter} shutter - Mock to inspect
 * @returns {Array<string|Object>} Commands in issue order
 */
const cmds = (shutter) => shutter.commands.map(c => c.command)

console.log('\n── Salon: single press (unchanged full travel) ──\n')

{
    const { table, shutters } = group(SALON, 40)
    const restore = stubDeviceLookup(table)
    try {
        new SalonRollersInteraction().execute({ action: '1_single' })
        assert(cmds(shutters[0])[0] === 'OPEN' && cmds(shutters[1])[0] === 'OPEN',
            '1_single sends OPEN to every salon shutter')

        new SalonRollersInteraction().execute({ action: '3_single' })
        assert(cmds(shutters[0])[1] === 'CLOSE' && cmds(shutters[1])[1] === 'CLOSE',
            '3_single sends CLOSE to every salon shutter')
        assert(shutters[0].commands[0].source === 'human',
            'commands are tagged with human provenance')
    } finally {
        restore()
    }
}

console.log('\n── Double press: 20% step with clamping ──\n')

{
    const { table, shutters } = group(SALON, 30)
    const restore = stubDeviceLookup(table)
    try {
        new SalonRollersInteraction().execute({ action: '1_double' })
        assert(JSON.stringify(cmds(shutters[0])) === JSON.stringify([{ position: 50 }]),
            '1_double at 30% moves to 50%')

        new SalonRollersInteraction().execute({ action: '3_double' })
        assert(JSON.stringify(cmds(shutters[1])) === JSON.stringify([{ position: 50 }, { position: 10 }]),
            '3_double steps down 20% from the cached position')
    } finally {
        restore()
    }
}

{
    const { table, shutters } = group(SALON, 90)
    const restore = stubDeviceLookup(table)
    try {
        new SalonRollersInteraction().execute({ action: '1_double' })
        assert(JSON.stringify(cmds(shutters[0])) === JSON.stringify([{ position: 100 }]),
            '1_double at 90% is capped at 100%')
    } finally {
        restore()
    }
}

{
    const { table, shutters } = group(SALON, 10)
    const restore = stubDeviceLookup(table)
    try {
        new SalonRollersInteraction().execute({ action: '3_double' })
        assert(JSON.stringify(cmds(shutters[0])) === JSON.stringify([{ position: 0 }]),
            '3_double at 10% is floored at 0% (no negative value)')
    } finally {
        restore()
    }
}

{
    // Mixed positions: each shutter steps from its OWN cached position.
    const { table, shutters } = group(SALON, null)
    shutters[0].position = 0
    shutters[1].position = 50
    const restore = stubDeviceLookup(table)
    try {
        new SalonRollersInteraction().execute({ action: '1_double' })
        assert(JSON.stringify(cmds(shutters[0])) === JSON.stringify([{ position: 20 }]),
            'a shutter at 0% steps up to 20%')
        assert(JSON.stringify(cmds(shutters[1])) === JSON.stringify([{ position: 70 }]),
            'a shutter at 50% steps up to 70% (independent per shutter)')
    } finally {
        restore()
    }
}

console.log('\n── End-stop gate: beep instead of a doomed command ──\n')

{
    // Every shutter already closed -> CLOSE (single and double) must only beep.
    const { table, shutters } = group(SALON, 0)
    const restore = stubDeviceLookup(table)
    const beeps = captureBeeps()
    try {
        new SalonRollersInteraction().execute({ action: '3_single' })
        new SalonRollersInteraction().execute({ action: '3_double' })

        assert(shutters.every(s => s.commands.length === 0),
            '3_single and 3_double at 0% send no command at all')
        assert(beeps.count() === 2,
            'each refused press at the closed end stop beeps once')
    } finally {
        beeps.restore()
        restore()
    }
}

{
    // Every shutter already open -> OPEN (single and double) must only beep.
    const { table, shutters } = group(SALON, 100)
    const restore = stubDeviceLookup(table)
    const beeps = captureBeeps()
    try {
        new SalonRollersInteraction().execute({ action: '1_single' })
        new SalonRollersInteraction().execute({ action: '1_double' })

        assert(shutters.every(s => s.commands.length === 0),
            '1_single and 1_double at 100% send no command at all')
        assert(beeps.count() === 2,
            'each refused press at the open end stop beeps once')
    } finally {
        beeps.restore()
        restore()
    }
}

{
    // Tolerance band: +/-2% still counts as "at the limit".
    const { table, shutters } = group(SALON, 1)
    const restore = stubDeviceLookup(table)
    const beeps = captureBeeps()
    try {
        new SalonRollersInteraction().execute({ action: '3_single' })
        assert(shutters.every(s => s.commands.length === 0) && beeps.count() === 1,
            'a shutter at 1% still counts as closed for the gate')
    } finally {
        beeps.restore()
        restore()
    }
}

{
    // The gate needs ALL shutters: one still-open shutter keeps the group moving.
    const { table, shutters } = group(SALON, 0)
    shutters[1].position = 30
    const restore = stubDeviceLookup(table)
    const beeps = captureBeeps()
    try {
        new SalonRollersInteraction().execute({ action: '3_single' })
        assert(cmds(shutters[0])[0] === 'CLOSE' && cmds(shutters[1])[0] === 'CLOSE',
            'a partly-open group is still commanded (no beep)')
        assert(beeps.count() === 0, 'no beep while the group can still move')
    } finally {
        beeps.restore()
        restore()
    }
}

{
    // Wrong-direction presses are never gated: fully closed + OPEN must move.
    const { table, shutters } = group(SALON, 0)
    const restore = stubDeviceLookup(table)
    const beeps = captureBeeps()
    try {
        new SalonRollersInteraction().execute({ action: '1_single' })
        assert(cmds(shutters[0])[0] === 'OPEN' && beeps.count() === 0,
            'opening a fully closed group is not gated by the closed-end stop')
    } finally {
        beeps.restore()
        restore()
    }
}

console.log('\n── Unknown cached position fails open ──\n')

{
    const { table, shutters } = group(SALON, null)
    const restore = stubDeviceLookup(table)
    const beeps = captureBeeps()
    try {
        new SalonRollersInteraction().execute({ action: '3_single' })
        assert(cmds(shutters[0])[0] === 'CLOSE' && beeps.count() === 0,
            'a single press with no cached position still sends the command')
    } finally {
        beeps.restore()
        restore()
    }
}

{
    const { table, shutters } = group(SALON, null)
    shutters[0].position = 40
    const restore = stubDeviceLookup(table)
    try {
        new SalonRollersInteraction().execute({ action: '1_double' })
        assert(JSON.stringify(cmds(shutters[0])) === JSON.stringify([{ position: 60 }]),
            'the shutter with a cached position still steps normally')
        assert(shutters[1].commands.length === 0,
            'a double press skips a shutter with no cached position (never guesses)')
    } finally {
        restore()
    }
}

{
    // A missing device must not crash the group: the rest still gets commanded.
    const { table, shutters } = group(SALON, 50)
    delete table[SALON[1]]
    const restore = stubDeviceLookup(table)
    try {
        new SalonRollersInteraction().execute({ action: '1_single' })
        assert(cmds(shutters[0])[0] === 'OPEN',
            'an unresolvable shutter is skipped without aborting the group')
    } finally {
        restore()
    }
}

console.log('\n── Bedroom: outlet side effects only on a real travel ──\n')

{
    // Dark evening: closing turns the bedroom outlets ON.
    const { table, shutters } = group(BEDROOM, 60)
    const outlets = OUTLETS.map(() => new MockOutlet())
    Object.assign(table, Object.fromEntries(OUTLETS.map((n, i) => [n, outlets[i]])))
    table['Balkon Swiatlo'] = new MockSensor(400)

    const restore = stubDeviceLookup(table)
    const interaction = new BedroomRollersInteraction()
    try {
        interaction.execute({ action: '3_single' })
        assert(outlets.every(o => o.commands[0] === 'ON'),
            '3_single in the dark turns both bedroom outlets ON')
        assert(cmds(shutters[0])[0] === 'CLOSE',
            '3_single still closes all four shutters')
    } finally {
        restore()
    }
}

{
    // A 20% nudge is not a "closing up for the night" signal.
    const { table } = group(BEDROOM, 60)
    const outlets = OUTLETS.map(() => new MockOutlet())
    Object.assign(table, Object.fromEntries(OUTLETS.map((n, i) => [n, outlets[i]])))
    table['Balkon Swiatlo'] = new MockSensor(400)

    const restore = stubDeviceLookup(table)
    try {
        new BedroomRollersInteraction().execute({ action: '3_double' })
        assert(outlets.every(o => o.commands.length === 0),
            '3_double steps the shutters without touching the outlets')
    } finally {
        restore()
    }
}

{
    // Gated press -> nothing moved -> outlets must stay as they were.
    const { table } = group(BEDROOM, 0)
    const outlets = OUTLETS.map(() => new MockOutlet())
    Object.assign(table, Object.fromEntries(OUTLETS.map((n, i) => [n, outlets[i]])))
    table['Balkon Swiatlo'] = new MockSensor(400)

    const restore = stubDeviceLookup(table)
    const beeps = captureBeeps()
    try {
        new BedroomRollersInteraction().execute({ action: '3_single' })
        assert(outlets.every(o => o.commands.length === 0) && beeps.count() === 1,
            'a beep-gated close leaves the outlets untouched')
    } finally {
        beeps.restore()
        restore()
    }
}

{
    // Bright daylight: opening schedules the delayed OFF.
    const { table } = group(BEDROOM, 30)
    const outlets = OUTLETS.map(() => new MockOutlet())
    Object.assign(table, Object.fromEntries(OUTLETS.map((n, i) => [n, outlets[i]])))
    table['Balkon Swiatlo'] = new MockSensor(4000)

    const restore = stubDeviceLookup(table)
    const interaction = new BedroomRollersInteraction()
    try {
        interaction.execute({ action: '1_single' })
        assert(outlets.every(o => o.commands.length === 0),
            'bright daylight does not switch outlets immediately on open')
        assert(interaction.getShutters().length === 4,
            'bedroom group drives four shutters')

        await sleep(5200) // OPEN_OUTLET_OFF_DELAY_MS is 5000ms
        assert(outlets.every(o => o.commands[0] === 'OFF'),
            'the scheduled OFF reaches both outlets after the delay')
    } finally {
        interaction.cleanup()
        restore()
    }
}

console.log('\n── Base class contract ──\n')

{
    let threw = false
    try {
        new RollerShuttersBase({ name: 'NoShutters' })
    } catch {
        threw = true
    }
    assert(threw, 'constructing without a shutter list fails fast')

    const table = {}
    const restore = stubDeviceLookup(table)
    const beeps = captureBeeps()
    try {
        const bare = new RollerShuttersBase({ name: 'Bare', shutters: ['Ghost Device'] })
        bare.execute({ action: '2_single' })
        assert(bare.getShutters().length === 1,
            'getShutters() exposes the configured group')
    } finally {
        beeps.restore()
        restore()
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)
