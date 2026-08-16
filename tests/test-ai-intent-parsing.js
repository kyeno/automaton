/**
 * AI intent parsing regression test.
 *
 * Verifies that ToolBuilder.parseJsonIntent() recovers tool-call intents from the loose
 * pseudo-call syntax emitted by small local models (e.g. gemma-4-E2B-it), which does not
 * produce valid JSON or native function calling. Covers the strict-JSON path, the lenient
 * pseudo-call rescue path, position handling, and negative cases where no intent must be
 * inferred from plain prose. This is a pure unit test -- no services are initialised.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import ToolBuilder from '../src/ai/toolBuilder.js'

let passed = 0
let failed = 0

/**
 * Compare two parsed intents field-by-field; absent fields read as undefined on both sides.
 * @param {Object|undefined} a - Actual intent
 * @param {Object|undefined} b - Expected intent
 * @returns {boolean} True when device/action/position all match
 */
function sameIntent(a, b) {
    if (!a || !b) return a === b
    return a.device === b.device && a.action === b.action && a.position === b.position
}

function pass(label) {
    console.log(`  ✓ ${label}`)
    passed++
}

function fail(label, detail) {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
}

/**
 * Assert that parseJsonIntent(input) yields exactly the expected intents (or null), and does
 * not throw. A throwing parser would otherwise surface only much later in processMessage().
 * @param {string} label - Human-readable case name
 * @param {*} input - Raw assistant content to parse
 * @param {Array|null} expected - Expected intent array, or null for "no intent"
 */
function expectIntents(label, input, expected) {
    let actual
    try {
        actual = ToolBuilder.parseJsonIntent(input)
    } catch (e) {
        fail(label, `threw: ${e.message}`)
        return
    }

    if (expected === null) {
        if (actual === null) pass(label)
        else fail(label, `expected null, got ${JSON.stringify(actual)}`)
        return
    }

    if (!Array.isArray(actual)) {
        fail(label, `expected an array of intents, got ${JSON.stringify(actual)}`)
        return
    }
    if (actual.length !== expected.length) {
        fail(label, `expected ${expected.length} intent(s), got ${actual.length}: ${JSON.stringify(actual)}`)
        return
    }
    const mismatchIdx = actual.findIndex((it, i) => !sameIntent(it, expected[i]))
    if (mismatchIdx === -1) pass(label)
    else fail(label, `intent[${mismatchIdx}] expected ${JSON.stringify(expected[mismatchIdx])}, got ${JSON.stringify(actual[mismatchIdx])}`)
}

console.log('\n── AI intent parsing ──\n')

// --- The exact regression from the field log (two unquoted pseudo-calls) --------
expectIntents(
    'observed log: two set_device_state pseudo-calls',
    'set_device_state{action: "OPEN", device_name: "Salon Roleta Okno Lewe"}\n' +
    'set_device_state{action: "OPEN", device_name: "Salon Roleta Okno Prawe"}',
    [
        { device: 'Salon Roleta Okno Lewe', action: 'OPEN' },
        { device: 'Salon Roleta Okno Prawe', action: 'OPEN' }
    ]
)

// --- Lenient pseudo-call rescue path --------------------------------------------
expectIntents('get_device_state pseudo-call (device only)', 'get_device_state{device_name: "Balkon Temperatura"}', [{ device: 'Balkon Temperatura' }])
expectIntents('prose prefix before a single call', 'Jasne, otwieram:\nset_device_state{action:"CLOSE", device_name:"Sypialnia Roleta"}', [{ device: 'Sypialnia Roleta', action: 'CLOSE' }])
expectIntents('paren-style arguments with = separators', 'set_device_state(device_name="Kuchnia Gniazdo", action="ON")', [{ device: 'Kuchnia Gniazdo', action: 'ON' }])
expectIntents('unquoted numeric position', 'set_device_state { device_name: "Salon Roleta", position: 40 }', [{ device: 'Salon Roleta', position: 40 }])
expectIntents('string-valued position', 'set_device_state{device_name: "X", position: "55"}', [{ device: 'X', position: 55 }])
expectIntents('bare unquoted braces without tool name', '{action:"CLOSE", device_name:"Sypialnia Roleta"}', [{ device: 'Sypialnia Roleta', action: 'CLOSE' }])

// --- Strict JSON path (well-formed output) --------------------------------------
expectIntents('strict flat JSON object', '{"device_name":"X","action":"ON"}', [{ device: 'X', action: 'ON' }])
expectIntents('strict wrapped parameters array', '[{"name":"set_device_state","parameters":{"device_name":"Y","position":50}}]', [{ device: 'Y', position: 50 }])
expectIntents('markdown fenced strict JSON', '```json\n{"device_name":"Z","action":"OFF"}\n```', [{ device: 'Z', action: 'OFF' }])
expectIntents('multiple strict objects in one message', '[{"device_name":"A","action":"ON"},{"device_name":"B","action":"OFF"}]', [
    { device: 'A', action: 'ON' },
    { device: 'B', action: 'OFF' }
])

// --- Negative cases: no intent must be inferred from prose -----------------------
expectIntents('plain prose with no call syntax', 'Jasne, otwieram rolety w salonie. Miłego dnia!', null)
expectIntents('empty string', '', null)
expectIntents('null input', null, null)
expectIntents('non-string input', 12345, null)

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)