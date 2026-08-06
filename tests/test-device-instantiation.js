/**
 * Device instantiation & inheritance tests.
 * Verifies type classes extend DeviceBase, instances are creatable,
 * abstract class is protected, and DeviceContainer loads correctly.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import DeviceContainer from '../src/device/container/deviceContainer.js'
import DeviceBase from '../src/device/base/deviceBase.js'
import Remote from '../src/device/type/remote.js'
import Mechanism from '../src/device/type/mechanism.js'
import Sensor from '../src/device/type/sensor.js'
import Bridge from '../src/device/type/bridge.js'
import Dummy from '../src/device/type/dummy.js'

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

// -- Type class inheritance -----------------------------------------------

console.log('\n── Type class inheritance ──\n')

assert(Remote.prototype instanceof DeviceBase, 'Remote extends DeviceBase')
assert(Mechanism.prototype instanceof DeviceBase, 'Mechanism extends DeviceBase')
assert(Sensor.prototype instanceof DeviceBase, 'Sensor extends DeviceBase')
assert(Bridge.prototype instanceof DeviceBase, 'Bridge extends DeviceBase')
assert(Dummy.prototype instanceof DeviceBase, 'Dummy extends DeviceBase')

// -- Instance creation ----------------------------------------------------

console.log('\n── Instance creation ──\n')

const remote = new Remote('test-remote', '0x1234', {})
assert(remote instanceof Remote, 'Remote instance is instance of Remote')
assert(remote instanceof DeviceBase, 'Remote instance is instance of DeviceBase')
assert(remote.getName() === 'test-remote', 'Remote getName() returns name')
assert(remote.getId() === '0x1234', 'Remote getId() returns id')

const mechanism = new Mechanism('test-mechanism', '0x5678', {})
assert(mechanism instanceof Mechanism, 'Mechanism instance is instance of Mechanism')
assert(mechanism instanceof DeviceBase, 'Mechanism instance is instance of DeviceBase')

const sensor = new Sensor('test-sensor', '0xabcd', {})
assert(sensor instanceof Sensor, 'Sensor instance is instance of Sensor')
assert(sensor instanceof DeviceBase, 'Sensor instance is instance of DeviceBase')

const bridge = new Bridge('test-bridge', '0xeeee', {})
assert(bridge instanceof Bridge, 'Bridge instance is instance of Bridge')
assert(bridge instanceof DeviceBase, 'Bridge instance is instance of DeviceBase')

const dummy = new Dummy('test-dummy', '0xdddd', {})
assert(dummy instanceof Dummy, 'Dummy instance is instance of Dummy')
assert(dummy instanceof DeviceBase, 'Dummy instance is instance of DeviceBase')

// -- Abstract class protection --------------------------------------------

console.log('\n── Abstract class protection ──\n')

try {
    // @ts-ignore - intentionally testing instantiation of abstract class
    new DeviceBase('abstract-test', '0x0000', {})
    assert(false, 'DeviceBase throws on direct instantiation')
} catch (e) {
    assert(e.message.includes('Abstract'), 'DeviceBase throws on direct instantiation')
}

// -- DeviceContainer ------------------------------------------------------

console.log('\n── DeviceContainer ──\n')

assert(typeof DeviceContainer.findByName === 'function', 'findByName method exists')
assert(typeof DeviceContainer.findByID === 'function', 'findByID method exists')

// -- Summary --------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)