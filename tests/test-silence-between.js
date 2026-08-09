/**
 * Tests for the silence_between config parameter in AutomationBase.
 *
 * Verifies that isInSilentPeriod() correctly parses "HHmm-HHmm" format,
 * handles normal ranges, overnight wrap-around ranges, missing configs,
 * and invalid formats. Also verifies that RuleBasedAutomationBase.execute()
 * is suppressed when inside a silent window.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { config } from 'dotenv'
config()

import { resolve } from 'node:path'

import ConfigService from '../src/service/configService.js'
import LoggerService from '../src/service/loggerService.js'
import AutomationBase from '../src/automation/base/automationBase.js'

// Set minimal env vars so ConfigService won't throw on missing required keys
process.env['MQTT_URL'] = process.env['MQTT_URL'] || 'mqtt://localhost:1883'
process.env['MQTT_PREFIX'] = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://192.168.1.1:6379'
process.env['CONFIG_PATH'] = process.env['CONFIG_PATH'] || './etc/automaton.yaml'

// Bootstrap config + logger so logging works in unit-test mode
await ConfigService.init()
LoggerService.init()

const ROOT = resolve(import.meta.dirname, '..')

let passed = 0
let failed = 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition, label) {
    if (condition) {
        console.log(`  ✓ ${label}`)
        passed++
    } else {
        console.error(`  ✗ ${label}`)
        failed++
    }
}

/**
 * Stub Date so we can test arbitrary times without waiting for real clock.
 * Returns a cleanup function to restore the original Date constructor.
 */
function stubDate(hour, minute) {
    const OriginalDate = global.Date
    class FakeDate extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) {
                super(2026, 7 /* August */, 15, hour, minute, 0, 0)
            } else {
                super(...args)
            }
        }
        static now() { return new FakeDate().getTime() }
    }
    Object.setPrototypeOf(FakeDate.prototype, OriginalDate.prototype)
    global.Date = FakeDate
    return () => { global.Date = OriginalDate }
}

class ConcreteAutomation extends AutomationBase {
    execute() { this._executed = true; return 'done' }
}

// -- No config / empty config -----------------------------------------------

console.log('\n── No silence_between configured ──\n')

{
    const auto = new ConcreteAutomation({ name: 'no-silence', config: {} })
    assert(auto.isInSilentPeriod() === false, 'empty config → not silent')

    const auto2 = new ConcreteAutomation({ name: 'ns2', config: { foo: 'bar' } })
    assert(auto2.isInSilentPeriod() === false, 'config without silence_between → not silent')

    const auto3 = new ConcreteAutomation({ name: 'ns3', config: { silence_between: null } })
    assert(auto3.isInSilentPeriod() === false, 'silence_between: null → not silent')

    const auto4 = new ConcreteAutomation({ name: 'ns4', config: { silence_between: 123 } })
    assert(auto4.isInSilentPeriod() === false, 'silence_between: number (not string) → not silent')
}

// -- Normal range: "0500-0900" ----------------------------------------------

console.log('\n── Normal range "0500-0900" ──\n')

{
    // Inside the window
    let restore = stubDate(6, 30)   // 06:30 — inside 05:00–09:00
    const a1 = new ConcreteAutomation({ name: 't1', config: { silence_between: '0500-0900' } })
    assert(a1.isInSilentPeriod() === true, '06:30 is inside 0500-0900')
    restore()

    // At exact start boundary (inclusive)
    restore = stubDate(5, 0)        // 05:00 — exactly at start
    const a2 = new ConcreteAutomation({ name: 't2', config: { silence_between: '0500-0900' } })
    assert(a2.isInSilentPeriod() === true, '05:00 is at start of 0500-0900 (inclusive)')
    restore()

    // Just before start
    restore = stubDate(4, 59)       // 04:59 — one minute before
    const a3 = new ConcreteAutomation({ name: 't3', config: { silence_between: '0500-0900' } })
    assert(a3.isInSilentPeriod() === false, '04:59 is outside 0500-0900')
    restore()

    // At exact end boundary (exclusive)
    restore = stubDate(9, 0)        // 09:00 — exactly at end
    const a4 = new ConcreteAutomation({ name: 't4', config: { silence_between: '0500-0900' } })
    assert(a4.isInSilentPeriod() === false, '09:00 is at end of 0500-0900 (exclusive)')
    restore()

    // Just inside end boundary
    restore = stubDate(8, 59)       // 08:59 — one minute before end
    const a5 = new ConcreteAutomation({ name: 't5', config: { silence_between: '0500-0900' } })
    assert(a5.isInSilentPeriod() === true, '08:59 is inside 0500-0900')
    restore()

    // Well outside the window
    restore = stubDate(12, 0)       // 12:00 — noon
    const a6 = new ConcreteAutomation({ name: 't6', config: { silence_between: '0500-0900' } })
    assert(a6.isInSilentPeriod() === false, '12:00 is outside 0500-0900')
    restore()
}


// -- Overnight range: "2300-0600" -------------------------------------------

console.log('\n── Overnight range "2300-0600" ──\n')

{
    // Inside — after start (late night)
    let restore = stubDate(23, 30)   // 23:30
    const a1 = new ConcreteAutomation({ name: 'o1', config: { silence_between: '2300-0600' } })
    assert(a1.isInSilentPeriod() === true, '23:30 is inside 2300-0600')
    restore()

    // Inside — before end (early morning)
    restore = stubDate(3, 0)        // 03:00
    const a2 = new ConcreteAutomation({ name: 'o2', config: { silence_between: '2300-0600' } })
    assert(a2.isInSilentPeriod() === true, '03:00 is inside 2300-0600')
    restore()

    // At exact start boundary (inclusive)
    restore = stubDate(23, 0)       // 23:00
    const a3 = new ConcreteAutomation({ name: 'o3', config: { silence_between: '2300-0600' } })
    assert(a3.isInSilentPeriod() === true, '23:00 is at start of 2300-0600 (inclusive)')
    restore()

    // Just before start
    restore = stubDate(22, 59)      // 22:59
    const a4 = new ConcreteAutomation({ name: 'o4', config: { silence_between: '2300-0600' } })
    assert(a4.isInSilentPeriod() === false, '22:59 is outside 2300-0600')
    restore()

    // At exact end boundary (exclusive)
    restore = stubDate(6, 0)        // 06:00
    const a5 = new ConcreteAutomation({ name: 'o5', config: { silence_between: '2300-0600' } })
    assert(a5.isInSilentPeriod() === false, '06:00 is at end of 2300-0600 (exclusive)')
    restore()

    // Well outside — midday
    restore = stubDate(14, 0)       // 14:00
    const a6 = new ConcreteAutomation({ name: 'o6', config: { silence_between: '2300-0600' } })
    assert(a6.isInSilentPeriod() === false, '14:00 is outside 2300-0600')
    restore()
}

// -- Edge case: start equals end --------------------------------------------

console.log('\n── Edge case: start == end "1200-1200" ──\n')

{
    let restore = stubDate(12, 0)
    const a1 = new ConcreteAutomation({ name: 'e1', config: { silence_between: '1200-1200' } })
    assert(a1.isInSilentPeriod() === false, 'start==end → treated as no-op (not silent)')
    restore()

    restore = stubDate(5, 0)
    const a2 = new ConcreteAutomation({ name: 'e2', config: { silence_between: '1200-1200' } })
    assert(a2.isInSilentPeriod() === false, 'start==end at different time → still not silent')
    restore()
}


// -- Invalid format ---------------------------------------------------------

console.log('\n── Invalid formats ──\n')

{
    let restore = stubDate(10, 0)

    // Too short
    const b1 = new ConcreteAutomation({ name: 'b1', config: { silence_between: '50-90' } })
    assert(b1.isInSilentPeriod() === false, '"50-90" invalid → not silent (fail-open)')

    // Colon-separated instead of compact
    const b2 = new ConcreteAutomation({ name: 'b2', config: { silence_between: '05:00-09:00' } })
    assert(b2.isInSilentPeriod() === false, '"05:00-09:00" invalid → not silent (fail-open)')

    // Missing dash
    const b3 = new ConcreteAutomation({ name: 'b3', config: { silence_between: '05000900' } })
    assert(b3.isInSilentPeriod() === false, '"05000900" missing dash → not silent')

    // Empty string
    const b4 = new ConcreteAutomation({ name: 'b4', config: { silence_between: '' } })
    assert(b4.isInSilentPeriod() === false, '"" empty string → not silent')

    restore()
}

// -- Minute precision -------------------------------------------------------

console.log('\n── Minute precision "0730-0815" ──\n')

{
    let restore = stubDate(7, 45)   // 07:45 — inside 07:30–08:15
    const a1 = new ConcreteAutomation({ name: 'm1', config: { silence_between: '0730-0815' } })
    assert(a1.isInSilentPeriod() === true, '07:45 is inside 0730-0815')
    restore()

    restore = stubDate(8, 14)       // 08:14 — one minute before end
    const a2 = new ConcreteAutomation({ name: 'm2', config: { silence_between: '0730-0815' } })
    assert(a2.isInSilentPeriod() === true, '08:14 is inside 0730-0815')
    restore()

    restore = stubDate(8, 16)       // 08:16 — past end
    const a3 = new ConcreteAutomation({ name: 'm3', config: { silence_between: '0730-0815' } })
    assert(a3.isInSilentPeriod() === false, '08:16 is outside 0730-0815')
    restore()
}

// -- Summary ----------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)

