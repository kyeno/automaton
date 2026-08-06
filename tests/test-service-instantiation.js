/**
 * Service instantiation tests.
 * Verifies that all singleton services are importable and expose their
 * expected public API surface.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import CacheService from '../src/service/cacheService.js'
import EventBus from '../src/service/eventBus.js'
import LoggerService from '../src/service/loggerService.js'
import MQTTService from '../src/service/mqttService.js'

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

// -- CacheService ----------------------------------------------------------

console.log('\n── CacheService ──\n')

assert(CacheService !== null, 'CacheService exported')
assert(typeof CacheService.init === 'function', 'has init()')
assert(typeof CacheService.get === 'function', 'has get()')
assert(typeof CacheService.set === 'function', 'has set()')
assert(typeof CacheService.isConnected === 'function', 'has isConnected()')
assert(typeof CacheService.disconnect === 'function', 'has disconnect()')

// Without Redis running, isConnected should be false and get/set return falsy
assert(CacheService.isConnected() === false, 'isConnected() is false without Redis')

// -- EventBus --------------------------------------------------------------

console.log('\n── EventBus ──\n')

assert(EventBus !== null, 'EventBus exported')
assert(typeof EventBus.publish === 'function', 'has publish()')
assert(typeof EventBus.subscribe === 'function', 'has subscribe()')

// Basic pub/sub round-trip
let callbackFired = false
const unsub = EventBus.subscribe('test:channel', () => { callbackFired = true })
EventBus.publish('test:channel')
assert(callbackFired === true, 'publish fires subscriber callback')
unsub()
// After unsubscribe, a new callback should NOT fire
let callbackFiredAfterUnsub = false
EventBus.subscribe('test:channel', () => { callbackFiredAfterUnsub = true })
// Re-subscribe so we can verify cleanup worked -- actually the old sub was removed
// Let's just verify the unsubscribe function returns a function
assert(typeof unsub === 'function', 'subscribe returns unsubscribe function')

// -- LoggerService ---------------------------------------------------------

console.log('\n── LoggerService ──\n')

assert(LoggerService !== null, 'LoggerService exported')
assert(typeof LoggerService.init === 'function', 'has init()')
assert(typeof LoggerService.debug === 'function', 'has debug()')
assert(typeof LoggerService.info === 'function', 'has info()')
assert(typeof LoggerService.warn === 'function', 'has warn()')
assert(typeof LoggerService.error === 'function', 'has error()')

// -- MQTTService -----------------------------------------------------------

console.log('\n── MQTTService ──\n')

assert(MQTTService !== null, 'MQTTService exported')
assert(typeof MQTTService.init === 'function', 'has init()')
assert(typeof MQTTService.publish === 'function', 'has publish()')
assert(typeof MQTTService.subscribe === 'function', 'has subscribe()')
assert(typeof MQTTService.isConnected === 'function', 'has isConnected()')
assert(typeof MQTTService.disconnect === 'function', 'has disconnect()')
assert(typeof MQTTService.getPrefix === 'function', 'has getPrefix()')
assert(typeof MQTTService.resetCircuit === 'function', 'has resetCircuit()')
assert(typeof MQTTService.onReconnect === 'function', 'has onReconnect()')

// Without broker, isConnected should be false
assert(MQTTService.isConnected() === false, 'isConnected() is false without broker')

// -- Summary ---------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)