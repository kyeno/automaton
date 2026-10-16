/**
 * Rules command tests.
 *
 * Behavioral coverage for the /rules command that drives the rules window's tab focus:
 * bare invocation lists the automations the window knows and reports the focus,
 * `/rules <name>` focuses one automation (case-insensitively, refusing unknown names),
 * `/rules all` clears the focus, the command switches to the rules window when it was
 * typed in another window, it degrades to a plain note when no rules window exists, and
 * tab completion offers 'all' plus every automation name.
 *
 * The command is driven through a stub context that records every printed line and every
 * window switch, so assertions read what would actually hit the screen.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import RulesCmd from '../src/ui/commands/rulesCmd.js'

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

function assert(cond, label) {
    assertEqual(cond === true, true, label)
}

// -- Stub harness --------------------------------------------------------------

/**
 * Fake rules window exposing the tab API the command relies on.
 */
class FakeRulesWindow {
    constructor(names = [], focus = null) {
        this.names = names
        this.focus = focus
        this.focusCalls = []
        this.clearCalls = 0
    }

    setFocus(name) {
        const hit = this.names.find((n) => n.toLowerCase() === String(name).toLowerCase())
        this.focusCalls.push(name)
        if (!hit) return false
        this.focus = hit
        return true
    }

    clearFocus() {
        this.clearCalls++
        this.focus = null
    }

    getFocus() { return this.focus }

    getAutomationNames() { return [...this.names].sort() }
}

/**
 * Build a stub UI context wired to a rules window, recording prints and switches.
 * @param {Object|null} win - Rules window instance; null simulates no rules window
 * @param {Array<string>} containerNames - Automation names the container reports
 * @returns {{ctx: Object, printed: Array<string>, switches: Array<string>}}
 */
function makeCtx(win, containerNames = []) {
    const printed = []
    const switches = []
    const map = new Map(containerNames.map((n) => [n, { name: n }]))
    const ctx = {
        activeWindow: win,
        print(...args) { printed.push(args.join(' ')) },
        printPreformatted(text) { printed.push(text) },
        switchWindow(id) { switches.push(String(id)); ctx.activeWindow = win },
        automationContainer: { getAll: () => map },
    }
    return { ctx, printed, switches }
}

// -- Bare invocation lists the automations ------------------------------------------

console.log('\n\u2500\u2500 Bare invocation \u2500\u2500\n')

{
    const win = new FakeRulesWindow(['Rollers', 'Lights'], null)
    const { ctx, printed, switches } = makeCtx(win)
    const cmd = new RulesCmd(ctx)

    await cmd.execute('')

    assertEqual(printed[0], 'Automations: Lights, Rollers', 'bare invocation lists sorted names')
    assert(printed[1].includes('Focus one automation with /rules <name>'), 'usage hint shown when unfocused')
    assertEqual(switches.length, 0, 'no window switch when already in the rules window')
}

// -- Focusing one automation ---------------------------------------------------------

console.log('\n\u2500\u2500 Focusing one automation \u2500\u2500\n')

{
    const win = new FakeRulesWindow(['Rollers'], null)
    const { ctx, printed } = makeCtx(win)
    const cmd = new RulesCmd(ctx)

    await cmd.execute('rollers')

    assertEqual(win.focus, 'Rollers', 'name resolved case-insensitively')
    assert(printed[0].includes('focused on "Rollers"'), 'focus confirmed on screen')

    await cmd.execute('Nope')
    assert(printed[1].includes('No automation "Nope"'), 'unknown name refused')
    assert(printed[2].includes('Automations: Rollers'), 'known names listed after refusal')
    assertEqual(win.focus, 'Rollers', 'refused name leaves the focus untouched')
}

// -- Clearing the focus --------------------------------------------------------------

console.log('\n\u2500\u2500 Clearing the focus \u2500\u2500\n')

{
    const win = new FakeRulesWindow(['Rollers'], 'Rollers')
    const { ctx, printed } = makeCtx(win)
    const cmd = new RulesCmd(ctx)

    await cmd.execute('ALL')

    assertEqual(win.clearCalls, 1, 'clear focus invoked (case-insensitive)')
    assertEqual(win.focus, null, 'focus dropped')
    assert(printed[0].includes('every automation box again'), 'clearing confirmed on screen')
    assertEqual(win.focusCalls.length, 0, 'clear token never treated as a name')
}

// -- Typed in another window ---------------------------------------------------------

console.log('\n\u2500\u2500 Typed in another window \u2500\u2500\n')

{
    const win = new FakeRulesWindow(['Rollers'], null)
    const { ctx, switches } = makeCtx(null)
    ctx.activeWindow = { print() {} }
    ctx.switchWindow = (id) => { switches.push(String(id)); ctx.activeWindow = win }
    const cmd = new RulesCmd(ctx)

    await cmd.execute('Rollers')

    assertEqual(switches[0], 'rules', 'command switches to the rules window')
    assertEqual(win.focus, 'Rollers', 'focus applied after switching')
}

// -- No rules window ------------------------------------------------------------------

console.log('\n\u2500\u2500 No rules window \u2500\u2500\n')

{
    const { ctx, printed } = makeCtx(null)
    ctx.switchWindow = () => {}
    const cmd = new RulesCmd(ctx)

    await cmd.execute('Rollers')

    assertEqual(printed[0], '(Rules window not available)', 'missing window reported')
}

// -- Container fallback and tab completion ---------------------------------------------

console.log('\n\u2500\u2500 Container fallback and tab completion \u2500\u2500\n')

{
    const win = new FakeRulesWindow([], null)
    const { ctx, printed } = makeCtx(win, ['Lights', 'Rollers'])
    const cmd = new RulesCmd(ctx)

    await cmd.execute('')
    assertEqual(printed[0], 'Automations: Lights, Rollers', 'container names used when the window knows none')

    const completions = cmd.completeNextToken([])
    assertEqual(JSON.stringify(completions), '["all","Lights","Rollers"]', 'completion offers all plus automation names')
    assertEqual(cmd.completeNextToken(['Rollers']), null, 'no completion for a second token')
}

// -- Container getNames() view ---------------------------------------------------------

console.log('\n\u2500\u2500 Container getNames() view \u2500\u2500\n')

{
    const win = new FakeRulesWindow([], null)
    const { ctx } = makeCtx(win)
    ctx.automationContainer = { getNames: () => ['Twilight', 'Rollers'] }
    const cmd = new RulesCmd(ctx)

    assertEqual(JSON.stringify(cmd.completeNextToken([])), '["all","Rollers","Twilight"]',
        'completion reads the container getNames() view')
}

// -- Summary -------------------------------------------------------------------------

const total = passed + failed
console.log(`\nResults: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}\n`)

process.exit(failed > 0 ? 1 : 0)

