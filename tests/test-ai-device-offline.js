import { config } from 'dotenv'
config()

'use strict'

/**
 * AI device resolution -- "known but offline" vs "unknown".
 *
 * Regression coverage for the case where a configured Zigbee device drops off the network
 * (e.g., "Salon Wlacznik Swiatlo") and is removed from the live registry on device_leave. The
 * AI tool layer must report such a name as OFFLINE (it will reappear once it reconnects) rather
 * than collapsing it into a generic "not found", while genuinely unconfigured names stay UNKNOWN.
 *
 * Exercises both failure entry points (native execute() and text-intent executeIntent()) plus the
 * diacritic-insensitive path that mirrors the original production report ("Światło" vs "Swiatlo").
 * No MQTT / Redis / LLM required: only the pure resolution-failure paths are exercised.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

process.env['AI_API_URL'] = process.env['AI_API_URL'] || 'http://localhost:11434/v1'

import EventBus from '../src/service/eventBus.js'
import DeviceContainer from '../src/device/container/deviceContainer.js'
import ToolBuilder from '../src/ai/toolBuilder.js'

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

console.log('\n── AI device resolution: known-but-offline vs unknown ──\n')

// Stub the "known" set on the frozen singleton's prototype -- same seam the other tests use for
// findByName. Includes an offline Salon dimmer; excludes anything we treat as "unknown".
const proto = Object.getPrototypeOf(DeviceContainer)
const origGetKnown = proto.getKnownDeviceNames
proto.getKnownDeviceNames = () => ['Salon Wlacznik Swiatlo', 'Salon Roleta Okno Lewe']

const events = []
const unsubEvents = EventBus.subscribe('ai:deviceInteraction', (payload) => events.push(payload))

const parse = (result) => JSON.parse(result)
const callSetState = (name) => ToolBuilder.execute({
    function: { name: 'set_device_state', arguments: JSON.stringify({ device_name: name, action: 'OFF' }) }
})

try {
    // Precondition: the offline name is genuinely absent from the live registry.
    assert(ToolBuilder.resolveDevice({ device_name: 'Salon Wlacznik Swiatlo' }) === null,
        'offline name is not present in the live registry (precondition)')

    // 1) Known-but-offline -> status "offline", explanatory message, ok=false event with status.
    const off = parse(await callSetState('Salon Wlacznik Swiatlo'))
    assert(off.status === 'offline', `known-but-offline device classified as offline (got "${off.status}")`)
    assert(/offline/i.test(off.error), 'offline result explains the device will reappear once it reconnects')
    let ev = events[events.length - 1]
    assert(ev && ev.ok === false && ev.status === 'offline', 'offline failure event carries ok=false + status=offline')

    // 2) Diacritic spelling of the same offline device still resolves to "offline" (not unknown).
    const dia = parse(await callSetState('Salon Włacznik Światło'))
    assert(dia.status === 'offline', 'diacritic-spelled offline name ("Światło") still classifies as offline')

    // 3) Unconfigured name -> status "unknown", original "not found" wording preserved.
    const unk = parse(await callSetState('Kosmos Gniazdo'))
    assert(unk.status === 'unknown', `unconfigured device classified as unknown (got "${unk.status}")`)
    assert(/not found/i.test(unk.error), 'unknown result keeps the original "not found" wording')
    ev = events[events.length - 1]
    assert(ev && ev.ok === false && ev.status === 'unknown', 'unknown failure event carries ok=false + status=unknown')

    // 4) executeIntent() shares the same classification for a known-but-offline device.
    const intent = parse(await ToolBuilder.executeIntent({ device: 'Salon Wlacznik Swiatlo', action: 'OFF' }))
    assert(intent.status === 'offline', 'executeIntent classifies known-but-offline device as offline')
} finally {
    unsubEvents()
    proto.getKnownDeviceNames = origGetKnown
}

console.log(`\n  ${passed}/${passed + failed} passed\n`)
process.exit(failed > 0 ? 1 : 0)
