/**
 * Interactions command tests.
 * Behavioral coverage for the /interactions subcommand dispatcher: GNU-style usage help on
 * bare invocation, tree listing via "list", single-item detail view via "debug" (per-action
 * type/targets/calls rows, config-keys fallback, YAML-shape tolerance), and manual triggering
 * via "run <name> [actionType]" asserting callInteraction() receives the right action payload.
 * Name resolution covers exact, case-insensitive, multi-word, unknown, and missing-name paths.
 * The command is driven through a stub context + container pair that records every printed
 * line and every callInteraction() dispatch, so assertions read what would actually hit the
 * screen and the interaction engine. A minimal container without getSourceInfo() verifies the
 * instance-fallback rendering path still works end to end.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import InteractionsCmd from '../src/ui/commands/interactionsCmd.js'

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

// -- Stub harness --------------------------------------------------------------

/**
 * Fake custom JS interaction -- class name contains "Interaction" so getType()'s
 * prototype-chain walk detects it as a "custom" kind naturally.
 */
class FakeCustomInteraction {
    constructor(name, config = {}) {
        this.name = name
        this.config = config
        this.lastData = null
    }

    async execute(data) { this.lastData = data }
}

/** Plain-object YAML-shaped interaction instance (no named constructor in chain). */
function yamlInstance(name, config = {}) {
    return {
        name,
        config,
        lastData: null,
        async execute(data) { this.lastData = data },
        cleanup() {},
    }
}

/**
 * Build a stub InteractionContainer around fake instances. Mirrors the real API surface
 * the command relies on and records every callInteraction() dispatch for assertions.
 * @param {Array<Object>} interactions - Fake interaction instances
 * @returns {{calls: Array, getAll: Function, getInteraction: Function, callInteraction: Function, getSourceInfo: Function}}
 */
function makeContainer(interactions) {
    const map = new Map(interactions.map((i) => [i.name, i]))
    const calls = []
    return {
        calls,
        getAll: () => map,
        getInteraction: (name) => map.get(name) ?? null,
        callInteraction: async (name, data = {}) => {
            const inst = map.get(name)
            if (!inst || typeof inst.execute !== 'function') return // mirrors container warn path
            calls.push({ name, data })
            await inst.execute(data)
        },
        getSourceInfo: (name) => {
            const inst = map.get(name)
            if (!inst) return null
            return {
                name,
                kind: inst instanceof FakeCustomInteraction ? 'custom' : 'yaml',
                config: inst.config ?? null,
            }
        },
    }
}

/** Minimal container WITHOUT getSourceInfo -- exercises the instance-fallback rendering. */
function makeMinimalContainer(interactions) {
    const map = new Map(interactions.map((i) => [i.name, i]))
    return {
        getAll: () => map,
        getInteraction: (name) => map.get(name) ?? null,
        callInteraction: async (name, data = {}) => {
            const inst = map.get(name)
            if (inst && typeof inst.execute === 'function') await inst.execute(data)
        },
    }
}

/**
 * Instantiate an InteractionsCmd wired to a recording print context.
 * @param {Object|null} container - Stub container; null simulates a missing service
 * @returns {{cmd: Object, printed: string[]}} Command instance plus captured output lines
 */
function createHarness(container) {
    const printed = []
    const ctx = { print: (text) => printed.push(String(text)) }
    if (container) ctx.interactionContainer = container
    return { cmd: new InteractionsCmd(ctx), printed }
}

// -- Fixtures ------------------------------------------------------------------

const doorLockConfig = {
    actions: [
        { type: 'lock', targets: [{ device: 'door_lock', command: 'off' }] },
        { type: 'unlock', calls: 'chime only' },
    ],
}
const doorLock = new FakeCustomInteraction('door lock', doorLockConfig)

const lightScene = yamlInstance('light scene', {
    name: 'light scene',
    actions: [
        { type: 'on', targets: [{ device: 'livingroom', command: 'on' }, { device: 'kitchen', command: 'toggle' }] },
    ],
})

/** YAML interaction with no actions at all -- debug view must fall back to config keys. */
const chimeOnly = yamlInstance('chime only', { name: 'chime only', note: 'plain chime' })

/** Odd YAML shapes that must not break the debug renderer. */
const weird = yamlInstance('weird', {
    name: 'weird',
    actions: [null, 42, { targets: ['notobj', { device: 'a' }], calls: null }],
})

const fixtures = [doorLock, lightScene, chimeOnly]

// -- Usage help ------------------------------------------------------------------

console.log('\n\u2500\u2500 Usage help \u2500\u2500\n')

{
    // Bare invocation renders GNU-style usage with the registered names listed last
    const bare = createHarness(makeContainer(fixtures))
    await bare.cmd.execute('')
    assertEqual(bare.printed[0].split('\n')[0], 'Usage: /interactions <subcommand> [args]', 'usage header line')
    assertEqual(bare.printed[0].includes('list'), true, 'usage lists "list" subcommand')
    assertEqual(bare.printed[0].includes('debug <name>'), true, 'usage lists "debug" subcommand')
    assertEqual(bare.printed[0].includes('run <name> [actionType]'), true, 'usage lists "run" with optional action type')
    assertEqual(
        bare.printed[0].endsWith('Available: chime only, door lock, light scene'),
        true,
        'usage footer lists available interactions sorted'
    )
}
{
    // Empty registry still prints usage but notes there is nothing loaded
    const empty = createHarness(makeContainer([]))
    await empty.cmd.execute('   ')
    assertEqual(empty.printed[0].startsWith('Usage: /interactions'), true, 'whitespace-only args also show usage')
    assertEqual(empty.printed[0].endsWith('(no interactions loaded)'), true, 'usage notes empty registry')
}
{
    // Unknown subcommand reports the verb then falls back to full usage
    const unknown = createHarness(makeContainer(fixtures))
    await unknown.cmd.execute('frobnicate x')
    assertEqual(unknown.printed[0], 'Unknown subcommand "frobnicate"', 'unknown subcommand error line')
    assertEqual(unknown.printed[1].startsWith('Usage: /interactions'), true, 'unknown subcommand shows usage after error')
}
{
    // Missing service entirely -- graceful note instead of a crash
    const none = createHarness(null)
    await none.cmd.execute('list')
    assertEqual(none.printed[0], '(InteractionContainer not available)', 'missing container noted gracefully')
}

console.log('\n\u2500\u2500 list \u2500\u2500\n')

{
    const h = createHarness(makeContainer(fixtures))
    await h.cmd.execute('list')
    const out = h.printed.join('\n')
    assert(out.includes('door lock'), 'lists custom interaction by name')
    assert(out.includes('light scene'), 'lists yaml interaction by name')
    assert(out.includes('type: custom'), 'reports custom kind for class-backed instance')
    assert(out.includes('type: yaml'), 'reports yaml kind for inline object')
    assert(out.includes('actions: 2'), 'counts actions per interaction')
}
{
    const empty = createHarness(makeContainer([]))
    await empty.cmd.execute('list')
    assertEqual(empty.printed[0], '(no interactions loaded)', 'empty registry notes itself in list view')
}

// -- Debug view ------------------------------------------------------------------

console.log('\n\u2500\u2500 debug \u2500\u2500\n')

{
    // Per-action detail rows: type, device targets with commands, chained calls
    const h = createHarness(makeContainer(fixtures))
    await h.cmd.execute('debug door lock')
    const out = h.printed.join('\n')
    assert(out.includes('type: custom'), 'kind reported from container source info')
    assert(out.includes('actions: 2'), 'action count shown')
    assert(out.includes('action 1'), 'first action gets its own row')
    assert(out.includes('type=lock targets=door_lock:OFF'), 'targets rendered as device:COMMAND')
    assert(out.includes('action 2'), 'second action gets its own row')
    assert(out.includes('type=unlock calls=chime only'), 'chained call target surfaced')
}
{
    // Case-insensitive resolution still dispatches against the canonical registered key
    const c = makeContainer([lightScene])
    const h = createHarness(c)
    await h.cmd.execute('debug LIGHT SCENE')
    assert(h.printed.join('\n').includes('livingroom:ON'), 'case-insensitive name resolves to same entry')
    assertEqual(h.printed[0].includes('light scene'), true, 'tree header shows canonical registered name')
}
{
    // No actions at all -- top-level config keys become the detail rows instead
    const h = createHarness(makeContainer(fixtures))
    await h.cmd.execute('debug chime only')
    const out = h.printed.join('\n')
    assert(out.includes('actions: 0'), 'zero-action count reported')
    assert(out.includes('config keys'), 'config-keys fallback row present')
    assert(out.includes('name, note'), 'top-level config keys listed')
}
{
    // Odd YAML shapes (null entries, scalars, non-object targets) never break rendering
    const h = createHarness(makeContainer([weird]))
    await h.cmd.execute('debug weird')
    const out = h.printed.join('\n')
    assert(out.includes('type=(untyped)'), 'action without a type renders as (untyped)')
    assert(out.includes('targets=a'), 'object target kept; scalar target dropped')
    assert(!out.includes('notobj'), 'non-object target filtered out cleanly')
}
{
    // Unknown and missing names fall back to the available-names listing
    const c = makeContainer(fixtures)
    const h = createHarness(c)
    let before = h.printed.length
    await h.cmd.execute('debug nosuch thing')
    assertEqual(h.printed[before], 'Unknown interaction "nosuch thing"', 'unknown name error line')
    assertEqual(
        h.printed[before + 1],
        'Available: chime only, door lock, light scene',
        'error lists available interactions'
    )
    before = h.printed.length
    await h.cmd.execute('debug')
    assertEqual(h.printed[before], 'Missing interaction name', 'missing debug name hint')
}
{
    // Minimal container without getSourceInfo() -- instance fallback still renders fully
    const h = createHarness(makeMinimalContainer([doorLock]))
    await h.cmd.execute('debug DOOR LOCK')
    const out = h.printed.join('\n')
    assert(out.includes('type: custom'), 'kind inferred from prototype chain when source info absent')
    assert(out.includes('targets=door_lock:OFF'), 'actions derived directly from instance config')
}

console.log('\n\u2500\u2500 run \u2500\u2500\n')

{
    // "<name> <actionType>" split dispatches with the action payload for YAML selection
    const c = makeContainer(fixtures)
    const h = createHarness(c)
    await h.cmd.execute('run light scene on')
    assertEqual(c.calls.length, 1, 'exactly one dispatch recorded')
    assertEqual(c.calls[0].name, 'light scene', 'dispatch uses canonical registered key')
    assertEqual(JSON.stringify(c.calls[0].data), JSON.stringify({ action: 'on' }), 'action type passed as {action}')
    assert(h.printed.join('\n').includes('(action: on)'), 'confirmation names the selected action')
    assert(h.printed.join('\n').endsWith('Done -- see log window for details.'), 'completion line printed')
    assertEqual(lightScene.lastData.action, 'on', 'execute() received the action selector')
}
{
    // Whole-string match wins over splitting -- multi-word name without an explicit action
    const c = makeContainer([doorLock])
    const h = createHarness(c)
    await h.cmd.execute('run DOOR LOCK')
    assertEqual(c.calls.length, 1, 'case-insensitive whole-name run dispatched once')
    assertEqual(JSON.stringify(c.calls[0].data), '{}', 'no action payload when no selector given')
    assert(h.printed.join('\n').includes('Running "door lock"...'), 'running line shows canonical name')
}
{
    // When the whole string misses, the trailing word becomes the action selector of the
    // longest resolvable prefix -- here name "a b" runs with action type "c"
    const both = [new FakeCustomInteraction('a b', {})]
    const c = makeContainer(both)
    const h = createHarness(c)
    await h.cmd.execute('run a b c')
    assertEqual(c.calls.length, 1, 'three-token input dispatched once')
    assertEqual(c.calls[0].name, 'a b', 'longest resolvable prefix used as the name')
    assertEqual(JSON.stringify(c.calls[0].data), JSON.stringify({ action: 'c' }), 'trailing word selected as action type')
}
{
    // Unknown names (with or without a would-be action) list what IS available
    const c = makeContainer(fixtures)
    const h = createHarness(c)
    let before = h.printed.length
    await h.cmd.execute('run nosuch x')
    assertEqual(h.printed[before], 'Unknown interaction "nosuch x"', 'unknown run target reported verbatim')
    assertEqual(h.printed[before + 1], 'Available: chime only, door lock, light scene', 'error lists available interactions')
    assertEqual(c.calls.length, 0, 'no dispatch happens for unknown targets')
    before = h.printed.length
    await h.cmd.execute('run')
    assertEqual(h.printed[before], 'Missing interaction name', 'missing run name hint')
}
{
    // Execution errors are surfaced, never thrown out of the command
    const boom = yamlInstance('boom', { actions: [{ type: 'x' }] })
    boom.execute = async () => { throw new Error('kaboom') }
    const c = makeContainer([boom])
    const h = createHarness(c)
    await h.cmd.execute('run boom x')
    assert(h.printed.join('\n').includes('Execution failed: kaboom'), 'failure message printed with cause')
    assert(!h.printed.join('\n').includes('Done --'), 'no completion line after a failure')
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)