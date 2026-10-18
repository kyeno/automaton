/**
 * Tests for KitchenCountertopLEDAutomation -- presence-driven countdown controller.
 *
 * Covers the full state machine by driving execute() directly against controllable mock
 * devices registered through DeviceContainer.findByName:
 *   - occupancy:true turns the outlet ON and starts the grace countdown;
 *   - recurrence re-runs the countdown while occupied AND the light is confirmed ON;
 *   - a manual OFF during the window wins over automation intent (noop);
 *   - occupancy cleared turns the outlet OFF;
 *   - two rapid triggers cannot arm two racing timers (slot-count invariant).
 * Uses short real delays (no fake timers); every scenario that would otherwise loop forever
 * is bounded by the mock sensor's read budget or an explicit state override, and each block
 * restores DeviceContainer before exiting.
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
import KitchenCountertopLEDAutomation from '../etc/automation/kitchenCountertopLEDAutomation.js'

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
 * Mock motion sensor. `trueReads` bounds how many getStateLast() calls report occupancy:true;
 * after that the sensor reports false -- this naturally terminates any recurrence loop so a
 * test observes exactly the cycle(s) it intends without timing races. setOccupancy() sets the
 * underlying value but does NOT consume from the read budget (it is a write, not a read).
 */
class MockSensor {
    /** @param {number} trueReads - Number of reads reporting occupancy:true before switching to false */
    constructor(trueReads = 1) {
        this._trueReads = trueReads
        this._reads = 0
    }
    setOccupancy(v) {
        this._occupancy = v
    }
    getStateLast() {
        this._reads++
        return this._reads <= this._trueReads ? { occupancy: true } : { occupancy: false }
    }
}

/**
 * Mock outlet mechanism. Commands are recorded verbatim and reflected back into state (as a
 * real device would via its MQTT echo); setState() lets tests simulate external events such as
 * a manual override.
 */
class MockOutlet {
    constructor(state = 'OFF') {
        this._state = state
        this.commands = []
        this.stateReads = 0
    }
    setState(s) {
        this._state = s
    }
    receiveCommand(cmd, source) {
        this.commands.push({ cmd, source })
        if (cmd === 'ON') this._state = 'ON'
        else if (cmd === 'OFF') this._state = 'OFF'
        return true
    }
    getStateLast() {
        this.stateReads++
        return { state: this._state }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Swap DeviceContainer.findByName for a lookup table during a test block. The container
 * instance itself is non-extensible, so we patch the method on its (extensible) prototype --
 * exactly how test-tts-gardener.js stubs the same resolver. Always restored via restore().
 */
function stubDeviceLookup(table) {
    const proto = Object.getPrototypeOf(DeviceContainer)
    const origFindByName = proto.findByName
    proto.findByName = (name) => table[name] ?? null
    return () => {
        proto.findByName = origFindByName
    }
}

console.log('\n── KitchenCountertopLEDAutomation ──\n')

{
    // -- A: occupancy:true turns the outlet ON and starts the countdown --------
    const sensor = new MockSensor(1)
    const outlet = new MockOutlet('OFF')
    const restore = stubDeviceLookup({ 'Kitchen Motion Sensor': sensor, 'Kitchen LED Outlet': outlet })
    try {
        const auto = new KitchenCountertopLEDAutomation(50)
        await auto.init()
        sensor.setOccupancy(true)
        outlet.setState('OFF')
        auto.execute()
        assert(outlet.commands.length === 1 && outlet.commands[0].cmd === 'ON', 'occupancy:true dispatches ON to the outlet')
        await sleep(20)   // still inside the 50ms window -> callback has not fired yet
        assert(outlet.stateReads === 0, 'countdown callback has not fired before its delay elapses')
        auto.cleanup()
    } finally {
        restore()
    }
}

{
    // -- B: recurrence while occupied AND light confirmed ON ------------------
    const sensor = new MockSensor(4)   // execute#1 + 3 recurrences stay "occupied"; read #5 -> false
    const outlet = new MockOutlet('ON')
    const restore = stubDeviceLookup({ 'Kitchen Motion Sensor': sensor, 'Kitchen LED Outlet': outlet })
    try {
        const auto = new KitchenCountertopLEDAutomation(50)
        await auto.init()
        sensor.setOccupancy(true)
        outlet.setState('ON')
        auto.execute()                 // cmd[0] = ON from the trigger; arms timer #1
        assert(auto.countdownActive === true, 'trigger armed exactly one countdown')
        await sleep(80)                // past cycle #1 (fires t=50) so its recurrence branch ran
        assert(outlet.commands.length >= 2 && outlet.commands[1].cmd === 'ON',
            `recurrence re-asserted ON after first cycle (got ${outlet.commands.length} cmds)`);
        assert(auto.countdownActive === true, 'recurrence armed a REAL second countdown');
        await sleep(80)                // past cycle #2 (fires t=100) so ITS recurrence also ran
        assert(auto.countdownActive === true, 'recurrence chained again -- timers survive the race guard');
        assert(outlet.commands.length >= 3 && outlet.commands[2].cmd === 'ON',
            `second recurrence also re-asserted ON (got ${outlet.commands.length} cmds)`);
        auto.cleanup()
    } finally {
        restore()
    }
}

{
    // -- C: manual OFF during the window wins over automation intent ----------
    const sensor = new MockSensor(1)   // execute reads #1 true; callback reads #2 false
    const outlet = new MockOutlet('OFF')
    const restore = stubDeviceLookup({ 'Kitchen Motion Sensor': sensor, 'Kitchen LED Outlet': outlet })
    try {
        const auto = new KitchenCountertopLEDAutomation(50)
        await auto.init()
        sensor.setOccupancy(true)
        outlet.setState('OFF')
        auto.execute()                 // turns it back ON...
        outlet.setState('OFF')         // ...then someone physically switches it off mid-window
        await sleep(150)               // callback fires, sees occupancy:false + outlet:OFF -> noop
        assert(outlet.commands.length === 1 && outlet.commands[0].cmd === 'ON',
            'manual OFF is respected: no command issued when the light is already off')
        auto.cleanup()
    } finally {
        restore()
    }
}

{
    // -- D: occupancy cleared turns the outlet OFF ----------------------------
    const sensor = new MockSensor(1)   // execute reads #1 true; callback reads #2 false
    const outlet = new MockOutlet('ON')
    const restore = stubDeviceLookup({ 'Kitchen Motion Sensor': sensor, 'Kitchen LED Outlet': outlet })
    try {
        const auto = new KitchenCountertopLEDAutomation(50)
        await auto.init()
        sensor.setOccupancy(true)
        outlet.setState('ON')
        auto.execute()                 // occupancy true at trigger time -> ON + countdown
        sensor.setOccupancy(false)      // someone leaves while the window is running
        await sleep(150)               // callback fires, sees occupancy:false + outlet:ON -> OFF
        assert(outlet.commands.length === 2 && outlet.commands[1].cmd === 'OFF',
            `occupancy cleared after trigger -> outlet turned OFF (got ${outlet.commands.length} cmds)`)
        auto.cleanup()
    } finally {
        restore()
    }
}

{
    // -- E: two rapid triggers cannot arm two racing timers -------------------
    // outlet.stateReads counts callback invocations exactly (execute() never reads it), so a
    // value of 1 proves only one timer survived the race; trueReads=2 keeps the single callback
    // on the "not occupied" branch so no recurrence loop can spawn extra callbacks.
    const sensor = new MockSensor(2)   // execute#1 read #1 true; execute#2 read #2 true; callback read #3 false
    const outlet = new MockOutlet('OFF')
    const restore = stubDeviceLookup({ 'Kitchen Motion Sensor': sensor, 'Kitchen LED Outlet': outlet })
    try {
        const auto = new KitchenCountertopLEDAutomation(50)
        await auto.init()
        sensor.setOccupancy(true)
        outlet.setState('OFF')
        auto.execute()                 // arms timer A
        auto.execute()                 // must be ignored by the race guard, not arm timer B
        await sleep(150)               // both would have fired without the guard; the OFF override stops any loop
        assert(outlet.stateReads === 1, `race guard kept exactly one countdown alive (got ${outlet.stateReads} callbacks)`)
        auto.cleanup()
    } finally {
        restore()
    }
}

{
    // -- F: missing devices keep the automation inert -------------------------
    const restore = stubDeviceLookup({})
    try {
        const auto = new KitchenCountertopLEDAutomation(50)
        await auto.init()
        let threw = false
        try {
            auto.execute()              // optional chaining must make this a safe no-op
        } catch (_) {
            threw = true
        }
        assert(threw === false, 'execute() no-ops safely when devices are unresolved')
        auto.cleanup()
    } finally {
        restore()
    }
}

// -- Summary --------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)
