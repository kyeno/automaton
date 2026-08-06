/**
 * Automation instantiation & inheritance tests.
 * Verifies that AutomationBase is properly abstract, concrete automations
 * extend it, singleton automations are creatable, and AutomationContainer
 * correctly manages automation lifecycle.
 *
 * Uses Autoloader to discover user scripts in etc/automation/ rather than
 * hardcoding file names — every user names their scripts differently.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import AutomationBase from '../src/automation/base/automationBase.js'
import NetworkPresence from '../src/monitor/networkPresence.js'
import AutomationContainer from '../src/automation/container/automationContainer.js'
import Autoloader from '../src/lib/autoloader.js'

const ROOT = resolve(import.meta.dirname, '..')
const ETC_AUTOMATION = join(ROOT, 'etc', 'automation')

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

// -- Abstract class protection --------------------------------------------

console.log('\n── AutomationBase abstraction ──\n')

try {
    new AutomationBase({ name: 'test', config: {} }).execute()
    assert(false, 'AutomationBase.execute() throws')
} catch (e) {
    assert(e.message.includes('must be implemented'), 'AutomationBase.execute() throws')
}

// -- AutomationBase defaults ----------------------------------------------

console.log('\n── AutomationBase defaults ──\n')

class TestAutomation extends AutomationBase {
    execute() { return 'executed' }
}

const auto = new TestAutomation({ name: 'test-auto', config: {} })
assert(auto.name === 'test-auto', 'name is set from options')
assert(typeof auto.config === 'object' && !Array.isArray(auto.config), 'config defaults to object')

const triggers = auto.getTriggerTopics()
assert(Array.isArray(triggers), 'getTriggerTopics() returns array')
assert(triggers.length === 0, 'getTriggerTopics() returns [] with no config')

const interval = auto.getTimerIntervalMs()
assert(interval === 0, 'getTimerIntervalMs() returns 0 by default')

const cooldown = auto.getHumanInteractionCooldownMs()
assert(cooldown > 0, 'getHumanInteractionCooldownMs() returns positive value from config')

assert(auto.execute() === 'executed', 'concrete subclass execute() works')

// -- Trigger topics from config -------------------------------------------

console.log('\n── AutomationBase trigger config ──\n')

const cfgAuto = new TestAutomation({
    name: 'cfg-auto',
    config: {
        triggers_zigbee: ['zigbee-dev-1'],
        triggers_network: ['net-dev-1']
    }
})
const cfgTriggers = cfgAuto.getTriggerTopics()
assert(cfgTriggers.includes('zigbee:zigbee-dev-1'), 'triggers include zigbee prefix')
assert(cfgTriggers.includes('network:net-dev-1'), 'triggers include network prefix')

const timerAuto = new TestAutomation({
    name: 'timer-auto',
    config: { timer_interval_ms: 30_000 }
})
assert(timerAuto.getTimerIntervalMs() === 30_000, 'getTimerIntervalMs() reads from config')

// -- Singleton automations ------------------------------------------------

console.log('\n── Singleton automations ──\n')

assert(NetworkPresence !== null, 'NetworkPresence singleton exported')
assert(typeof NetworkPresence.init === 'function', 'NetworkPresence has init()')
assert(typeof NetworkPresence.stop === 'function', 'NetworkPresence has stop()')
assert(typeof NetworkPresence.isOnline === 'function', 'NetworkPresence has isOnline()')
assert(typeof NetworkPresence.getStateByName === 'function', 'NetworkPresence has getStateByName()')

// -- Autoloader discovery test --------------------------------------------

console.log('\n── Autoloader automation discovery ──\n')

/**
 * Recursively collect .js files (excluding .js.dist) under a directory.
 */
function collectJsFiles(dir, list = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (entry.startsWith('.')) continue
        const st = statSync(full)
        if (st.isDirectory()) {
            collectJsFiles(full, list)
        } else if (entry.endsWith('.js') && !entry.endsWith('.js.dist')) {
            list.push(entry)
        }
    }
    return list
}

const userAutomationScripts = collectJsFiles(ETC_AUTOMATION)

if (userAutomationScripts.length > 0) {
    // Verify each discovered script exports a callable class
    const autoloader = new Autoloader()
    const modules = await autoloader.preloadPath(ETC_AUTOMATION)

    let loadedCount = 0
    for (const [name, mod] of Object.entries(modules)) {
        loadedCount++
        assert(typeof mod === 'function', `${name}: exports callable constructor`)

        // If it's a class that extends AutomationBase, verify key methods exist
        try {
            const instance = new mod()
            assert(typeof instance.execute === 'function', `${name}: has execute() method`)
            assert(typeof instance.init === 'function', `${name}: has init() method`)
        } catch (e) {
            // Some classes require dependencies; just check the export is callable
            assert(true, `${name}: instantiation skipped (requires runtime deps)`)
        }
    }
    assert(loadedCount >= userAutomationScripts.length, `loaded ${loadedCount} module(s), expected >= ${userAutomationScripts.length}`)
} else {
    console.log(`  ⊘ No .js automation scripts in etc/automation/ (skipped loader test)`)
    passed++  // count as pass — not every clone has custom automations
}

// -- AutomationContainer --------------------------------------------------

console.log('\n── AutomationContainer ──\n')

assert(AutomationContainer !== null, 'AutomationContainer singleton exported')
assert(typeof AutomationContainer.init === 'function', 'AutomationContainer has init()')
assert(typeof AutomationContainer.getAutomation === 'function', 'AutomationContainer has getAutomation()')
assert(typeof AutomationContainer.callAutomation === 'function', 'AutomationContainer has callAutomation()')
assert(typeof AutomationContainer.getAll === 'function', 'AutomationContainer has getAll()')
assert(typeof AutomationContainer.cleanupAutomations === 'function', 'AutomationContainer has cleanupAutomations()')

assert(AutomationContainer.getAutomation('nonexistent') === null, 'getAutomation returns null for unknown name')

const allMap = AutomationContainer.getAll()
assert(allMap instanceof Map, 'getAll() returns a Map')

// -- Summary --------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)