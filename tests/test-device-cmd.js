/**
 * Devices command tests.
 * Behavioral coverage for the /device subcommand dispatcher: registry counts + usage help on
 * bare invocation, "list" with both/one-registry filters (including invalid-filter handling),
 * and cross-registry "debug <name>" covering exact, case-insensitive, ambiguous (present in
 * BOTH registries), unknown, and missing-name paths -- plus presence rendering from a fake
 * network source (online/offline/cold-cache) so no live MQTT or Redis is required. The command
 * reads DeviceContainer and NetworkPresence through ctx exactly like its sibling commands, so
 * fakes injected into the context are what gets exercised end to end. Also asserts that the
 * real NetworkPresence singleton exposes the additive getNetworkDevices()/getPresence() view.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DeviceCmd from '../src/ui/commands/deviceCmd.js'
import NetworkPresence from '../src/monitor/networkPresence.js'

let passed = 0
let failed = 0

function assertEqual(actual, expected, label) {
    if (actual === expected) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
        failed++
    }
}

function assert(condition, label) {
    if (condition) {
        console.log(`  \u2713 ${label}`)
        passed++
    } else {
        console.error(`  \u2717 ${label}`)
        failed++
    }
}

// -- Fakes ---------------------------------------------------------------------

/** Fake Zigbee sensor instance shaped like the accessors /device reads. */
class Sensor {
    constructor(name, id, stateLast = {}) {
        this.name = name
        this.id = id
        this.stateLast = stateLast
    }

    getId() { return this.id }

    getStateLast() { return this.stateLast }

    getStateOrigin() { return 'mqtt' }
}

/** Fake mechanism with an active kind to exercise the optional "active" row. */
class Mechanism {
    constructor(name, id) {
        this.name = name
        this.id = id
    }

    getId() { return this.id }

    getStateLast() { return {} }

    hasActive() { return true }

    getActiveKind() { return 'on' }
}

const zigbeeDevices = {
    sensor_a: new Sensor('sensor_a', '0x0001', { temperature: 21.5, humidity: 48 }),
    gateway: new Mechanism('gateway', '0x00ff'),
}

/** Network devices include "gateway" on purpose -- it collides with a Zigbee name. */
const networkEntries = [
    { name: 'router', category: 'routers', ip: '192.168.1.1' },
    { name: 'gateway', category: 'computers', ip: '192.168.1.50' },
]

/**
 * Build a fake NetworkPresence source around flat entries plus a presence map keyed by
 * lower-cased device name (missing keys simulate cold/expired cache -> null).
 * @param {Array<Object>} entries - Flat listing entries
 * @param {Record<string, string|null>} [presence={}] - Presence labels per lower-cased name
 * @returns {{getNetworkDevices: Function, getPresence: Function}}
 */
function makeNetworkSource(entries, presence = {}) {
    return {
        getNetworkDevices: () => [...entries].sort((a, b) => a.name.localeCompare(b.name)),
        getPresence: async (name) => presence[String(name ?? '').toLowerCase()] ?? null,
    }
}

/** Minimal network source WITHOUT getPresence -- forces the "unknown" fallback path. */
function makeBareNetworkSource(entries) {
    return { getNetworkDevices: () => [...entries].sort((a, b) => a.name.localeCompare(b.name)) }
}

// -- Harness ---------------------------------------------------------------------

/**
 * Instantiate a DeviceCmd wired to a recording print context and optional registry fakes.
 * @param {{deviceContainer?: Object, networkPresence?: Object}} registries - Fakes or omissions
 * @returns {{cmd: Object, printed: string[]}} Command instance plus captured output lines
 */
function createHarness({ deviceContainer, networkPresence } = {}) {
    const printed = []
    const ctx = { print: (text) => printed.push(String(text)) }
    if (deviceContainer !== undefined) ctx.deviceContainer = deviceContainer
    if (networkPresence !== undefined) ctx.networkPresence = networkPresence
    return { cmd: new DeviceCmd(ctx), printed }
}

const zigbeeContainer = { getAll: ({ includeBridge = true } = {}) => (includeBridge ? zigbeeDevices : zigbeeDevices) }

console.log('\n\u2500\u2500 Bare invocation \u2500\u2500\n')

{
    // Counts line, blank separator, usage help and de-duplicated union of names from both registries
    const h = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await h.cmd.execute('')
    assertEqual(h.printed[0], 'Zigbee devices: 2 | Network devices: 2', 'counts reported per registry')
    const out = h.printed.join('\n')
    assert(
        out.startsWith('Zigbee devices: 2 | Network devices: 2\n\nUsage: /device <subcommand> [args]'),
        true,
        'usage header follows counts after a blank line'
    )
    assert(
        out.endsWith('Available: gateway, router, sensor_a'),
        true,
        'available footer unions both registries, sorted, deduped'
    )
}
{
    // Unknown subcommand reports the verb then falls back to full usage
    const h = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await h.cmd.execute('frobnicate x')
    assertEqual(h.printed[0], 'Unknown subcommand "frobnicate"', 'unknown subcommand error line')
    assertEqual(h.printed[1].startsWith('Usage: /device'), true, 'fallback shows usage after error')
}

console.log('\n\u2500\u2500 list \u2500\u2500\n')

{
    // Both registries render under labelled section headers with a blank separator
    const h = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await h.cmd.execute('list')
    const out = h.printed.join('\n')
    assert(out.includes('-- Zigbee devices (2) --'), 'zigbee section header with count')
    assert(out.includes('-- Network devices (2) --'), 'network section header with count')
    assert(out.includes('sensor_a') && out.includes('type: Sensor'), 'zigbee entries carry type rows')
    assert(out.includes('id: 0x0001'), 'zigbee entries carry id rows when available')
    assert(out.includes('category: routers') && out.includes('ip: 192.168.1.1'), 'network entries show category + ip')
    assert(/-- Zigbee devices \(2\) --\n[\s\S]*\n\n-- Network devices/.test(out), 'blank line separates the two sections')
}
{
    // Filter restricts to one registry; token matching is case-insensitive
    const onlyZ = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await onlyZ.cmd.execute('list ZIGBEE')
    const zOut = onlyZ.printed.join('\n')
    assert(zOut.includes('-- Zigbee devices (2) --'), 'zigbee filter renders zigbee section')
    assert(!zOut.includes('-- Network devices'), 'network section suppressed under zigbee filter')

    const onlyN = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await onlyN.cmd.execute('list NETWORK')
    const nOut = onlyN.printed.join('\n')
    assert(nOut.includes('-- Network devices (2) --'), 'network filter renders network section')
    assert(!nOut.includes('-- Zigbee devices'), 'zigbee section suppressed under network filter')
}
{
    // Invalid filters are reported with the valid options instead of guessing
    const h = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await h.cmd.execute('list bluetooth')
    assertEqual(h.printed[0], 'Unknown filter "bluetooth"', 'invalid filter named verbatim')
    assertEqual(h.printed[1], 'Valid filters: zigbee | network   (omit to list both)', 'valid options listed')
}
{
    // Missing registries degrade to explicit notes rather than crashes or empty output
    const none = createHarness({})
    await none.cmd.execute('list')
    assertEqual(none.printed[0], '(no zigbee devices registered)', 'missing container noted in list view')
    assertEqual(none.printed[1], '(no network devices configured)', 'missing presence source noted in list view')

    const bare = createHarness({})
    await bare.cmd.execute('')
    assertEqual(bare.printed[0], 'Zigbee devices: 0 | Network devices: 0', 'counts stay honest when nothing is wired')
    assert(bare.printed.join('\n').includes('(no devices registered)'), 'empty union footer rendered')
}

console.log('\n\u2500\u2500 debug \u2500\u2500\n')

{
    // Zigbee hit renders full detail rows including last-state dump and origin
    const h = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await h.cmd.execute('debug sensor_a')
    const out = h.printed.join('\n')
    assert(out.includes('registry: zigbee'), 'registry labelled in the view')
    assert(out.includes('type: Sensor'), 'class-derived type row present')
    assert(out.includes('id: 0x0001'), 'zigbee id surfaced')
    assert(out.includes('"temperature":21.5') && out.includes('"humidity":48'), 'last state dumped as JSON')
    assert(out.includes('origin: mqtt'), 'state origin surfaced when available')
}
{
    // Case-insensitive resolution still addresses the canonical registered key
    const h = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await h.cmd.execute('debug SENSOR_A')
    assertEqual(h.printed[0].includes('sensor_a'), true, 'tree header shows canonical name after case fold')
}
{
    // Optional accessors (active kind) appear only when the instance reports them
    const h = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    await h.cmd.execute('debug gateway')
    const out = h.printed.join('\n')
    assert(out.includes('Ambiguous name "gateway" -- found in BOTH registries:'), 'collision reported explicitly')
    assert(out.includes('-- Zigbee --') && out.includes('-- Network --'), 'both registry blocks labelled and rendered')
    assert(out.includes('type: Mechanism') && out.includes('active: on'), 'zigbee block carries mechanism detail rows')
    assert(out.includes('ip: 192.168.1.50'), 'network block carries its ip row')
}
{
    // Network-only hit with live presence from the source map
    const online = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries, { router: 'online' }) })
    await online.cmd.execute('debug ROUTER')
    let out = online.printed.join('\n')
    assert(out.includes('registry: network'), 'network view labelled')
    assert(out.includes('category: routers'), 'category surfaced')
    assert(out.includes('presence: online'), 'online state rendered when cache is warm')

    const offline = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries, { router: 'offline' }) })
    await offline.cmd.execute('debug router')
    assert(offline.printed.join('\n').includes('presence: offline'), 'offline state rendered when cached')
}
{
    // Cold cache (null) and missing getPresence both degrade to "unknown", never crash
    const cold = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries, {}) })
    await cold.cmd.execute('debug router')
    assert(cold.printed.join('\n').includes('presence: unknown'), 'cold cache renders as unknown')

    const bare = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeBareNetworkSource(networkEntries) })
    await bare.cmd.execute('debug router')
    assert(bare.printed.join('\n').includes('presence: unknown'), 'missing lookup API degrades gracefully')
}
{
    // Unknown names fall back to the union listing; missing name gets its own hint
    const h = createHarness({ deviceContainer: zigbeeContainer, networkPresence: makeNetworkSource(networkEntries) })
    let before = h.printed.length
    await h.cmd.execute('debug nosuch-thing')
    assertEqual(h.printed[before], 'Unknown device "nosuch-thing"', 'unknown device named verbatim')
    assertEqual(
        h.printed[before + 1],
        'Available: gateway, router, sensor_a',
        'fallback lists the cross-registry union'
    )
    before = h.printed.length
    await h.cmd.execute('debug')
    assertEqual(h.printed[before], 'Missing device name', 'missing debug name hint')
}

console.log('\n\u2500\u2500 NetworkPresence additive API \u2500\u2500\n')

assertEqual(typeof NetworkPresence.getNetworkDevices, 'function', 'real singleton exposes getNetworkDevices()')
assertEqual(typeof NetworkPresence.getPresence, 'function', 'real singleton exposes getPresence()')

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)