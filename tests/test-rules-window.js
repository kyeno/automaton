/**
 * Rules window tests.
 *
 * Coverage for the UI window that shows one box per rule-based automation with a compact
 * indented log of its last automation calls:
 *   - call rows arrive on the 'automation:runCompleted' channel published by
 *     RuleBasedAutomationBase, rule matches fold into the call that fired them on
 *     'automation:ruleMatched', and the outcome flips to 'acted' on 'automation:ruleActed',
 *   - each box keeps at most 3 calls, oldest first, newest at the bottom,
 *   - the tab bar lists every automation and the focus shows a single box,
 *   - malformed records are dropped, a forced call is marked with '!',
 *   - the boxes seed from each automation's own call history when the window is opened
 *     after the fact, falling back to the per-match history of older automations.
 *
 * RulesWindow is driven through the same recording virtual-terminal grid harness
 * as test-window-preformatted.js, so assertions read what the user sees.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../src/service/eventBus.js'
import AutomationContainer from '../src/automation/container/automationContainer.js'
import RulesWindow from '../src/ui/windows/rulesWindow.js'

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

/** Wait past BaseWindow's 30 ms render throttle so scheduled passes fire. */
const tick = () => new Promise(resolve => setTimeout(resolve, 80))

// -- Mock harness (same virtual-grid pattern as test-window-preformatted.js) ------

/**
 * Build a RulesWindow wired to a virtual terminal grid. The grid models the main
 * slot cell-for-cell; term.moveTo/term(text) update it exactly like CUP + character
 * writes would on a real tty, and layout.clearSlot blanks rows.
 * @param {{width: number, height: number}} size - Simulated main slot geometry
 * @returns {{win: RulesWindow, screenText: function(): string}}
 */
function createHarness(size) {
    const width = size.width
    const height = size.height
    const grid = Array.from({ length: height }, () => new Array(width).fill(' '))
    let cx = 1
    let cy = 1

    const term = function (text) {
        for (const ch of String(text)) {
            if (cy >= 1 && cy <= height && cx >= 1 && cx <= width) {
                grid[cy - 1][cx - 1] = ch
            }
            cx++
        }
    }
    term.moveTo = (x, y) => { cx = x; cy = y }
    term.hideCursor = () => {}

    const blankRows = (y0, count) => {
        for (let r = y0; r < Math.min(y0 + count, height); r++) {
            grid[r].fill(' ')
        }
    }

    const layout = {
        getSlot: (name) => name === 'main' ? { x: 0, y: 0, width, height } : null,
        isTooNarrow: () => false,
        clearSlot: (name) => {
            const slot = layout.getSlot(name)
            if (slot) blankRows(slot.y, slot.height)
        },
        moveToSlot: () => {},
    }

    const win = new RulesWindow(term, layout, 5)
    return {
        win,
        screenText() {
            return grid.map(row => row.join('')).join('\n')
        },
    }
}

/** Fixed reference instant so rendered timestamps are deterministic. */
const AT = new Date(2026, 9, 6, 7, 30, 0).getTime()

/**
 * Build one automation-call record as the automation base publishes it.
 * @param {Object} [over] - Fields to override
 * @returns {Object} Call record payload
 */
function callRecord(over = {}) {
    return {
        automation: 'Rollers',
        run: 1,
        at: AT,
        trigger: 'timer',
        forced: false,
        outcome: 'acted',
        reason: '',
        rules: ['morning-open'],
        ...over,
    }
}

/**
 * Build one rule-match record as the automation base publishes it.
 * @param {Object} [over] - Fields to override
 * @returns {Object} Match record payload
 */
function matchRecord(over = {}) {
    return { automation: 'Rollers', rule: 'morning-open', at: AT, trigger: 'timer', forced: false, acted: false, run: 1, ...over }
}

// -- Empty state -------------------------------------------------------------------

console.log('\n\u2500\u2500 Empty state \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()
    const screen = h.screenText()
    assert(screen.includes('No automation calls recorded yet'), 'empty window says so')
    assert(screen.includes('[none]'), 'tab bar reports no tabs')
    h.win.destroy()
}

// -- Box rendering -----------------------------------------------------------------

console.log('\n\u2500\u2500 Box rendering \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    EventBus.emit('automation:runCompleted', callRecord())
    await tick()

    const screen = h.screenText()
    assert(screen.includes('Rollers'), 'automation name rendered')
    assert(screen.includes('[Rollers]'), 'tab bar lists the automation')
    assert(screen.includes('last 1 call'), 'box header counts its calls')
    assert(screen.includes('07:30:00'), 'timestamp rendered')
    assert(screen.includes('timer'), 'trigger rendered')
    assert(screen.includes('acted'), 'outcome rendered')
    assert(screen.includes('morning-open'), 'rule the call fired rendered')
    assert(screen.includes('+--'), 'ascii frame drawn')
    assert(screen.includes('Boxes: 1 | calls: 1'), 'footer counts boxes and calls')
    h.win.destroy()
}

// -- Indented call log -------------------------------------------------------------

console.log('\n\u2500\u2500 Indented call log \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    EventBus.emit('automation:runCompleted', callRecord({ run: 1, at: AT - 2000, rules: ['older-call'] }))
    EventBus.emit('automation:runCompleted', callRecord({ run: 2, at: AT - 1000, rules: ['middle-call'] }))
    EventBus.emit('automation:runCompleted', callRecord({ run: 3, at: AT, rules: ['newest-call'] }))
    await tick()

    const screen = h.screenText()
    assert(screen.includes('last 3 calls'), 'box header counts three calls')
    const older = screen.indexOf('older-call')
    const middle = screen.indexOf('middle-call')
    const newest = screen.indexOf('newest-call')
    assert(older < middle && middle < newest, 'oldest call first, newest at the bottom')
    assert(/^\| {4}/.test(linesWith(screen, 'newest-call')[0]), 'call line indented inside the frame')
    assert(screen.includes('calls: 3'), 'footer counts the calls')
    h.win.destroy()
}

// -- Three-call cap ----------------------------------------------------------------

console.log('\n\u2500\u2500 Three-call cap \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    for (let i = 1; i <= 5; i++) {
        EventBus.emit('automation:runCompleted', callRecord({ run: i, at: AT + i, rules: [`rule-${i}`] }))
    }
    await tick()

    const screen = h.screenText()
    assert(screen.includes('calls: 3'), 'box keeps at most 3 calls')
    assert(screen.includes('rule-3') && screen.includes('rule-4') && screen.includes('rule-5'),
        'newest three calls kept')
    assert(!screen.includes('rule-1') && !screen.includes('rule-2'), 'oldest calls dropped')
    h.win.destroy()
}


/** Extract the rendered lines that mention a text, so indentation can be inspected.
 * @param {string} screen - Rendered screen text
 * @param {string} needle - Text to look for
 * @returns {Array<string>} Matching lines
 */
function linesWith(screen, needle) {
    return screen.split('\n').filter((line) => line.includes(needle))
}

// -- Matches fold into their call ---------------------------------------------------

console.log('\n\u2500\u2500 Matches fold into their call \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    EventBus.emit('automation:runCompleted', callRecord({ run: 7, outcome: 'noop', rules: [] }))
    await tick()
    assert(h.screenText().includes('noop'), 'call starts as noop')
    assert(!h.screenText().includes('morning-open'), 'no rule listed before the match arrives')

    EventBus.emit('automation:ruleMatched', matchRecord({ run: 7 }))
    await tick()
    let screen = h.screenText()
    assert(screen.includes('morning-open'), 'match folds its rule into the call')
    assert(screen.includes('calls: 1'), 'match does not add a second call')

    EventBus.emit('automation:ruleActed', matchRecord({ run: 7, acted: true }))
    await tick()
    screen = h.screenText()
    assert(screen.includes('acted'), 'outcome flips to acted')
    assert(!screen.includes('noop'), 'no stale noop outcome left')

    // An outcome event for an automation the window never saw is dropped, not rendered.
    EventBus.emit('automation:ruleActed', matchRecord({ automation: 'Ghost', rule: 'ghost-rule', run: 99, acted: true }))
    await tick()
    assert(!h.screenText().includes('Ghost'), 'orphan acted event ignored')
    h.win.destroy()
}

// -- Matches without a call record ---------------------------------------------------

console.log('\n\u2500\u2500 Matches without a call record \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    EventBus.emit('automation:ruleMatched', matchRecord({ run: null, rule: 'legacy-rule' }))
    await tick()

    const screen = h.screenText()
    assert(screen.includes('legacy-rule'), 'bare match shown as a call of its own')
    assert(screen.includes('Boxes: 1 | calls: 1'), 'bare match counted as one call')
    h.win.destroy()
}

// -- Forced calls and malformed records ----------------------------------------------

console.log('\n\u2500\u2500 Forced calls and malformed records \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    EventBus.emit('automation:runCompleted', callRecord({ run: 4, trigger: 'manual', forced: true }))
    await tick()
    assert(h.screenText().includes('manual!'), 'forced call marked with !')

    EventBus.emit('automation:runCompleted', null)
    EventBus.emit('automation:runCompleted', {})
    EventBus.emit('automation:runCompleted', { automation: 'X', run: 1, at: 'nope', outcome: 'acted', rules: [] })
    EventBus.emit('automation:runCompleted', { automation: 'X', run: 1, at: AT, outcome: '', rules: [] })
    EventBus.emit('automation:ruleMatched', { automation: 'X', rule: '', at: AT })
    await tick()
    assert(h.screenText().includes('Boxes: 1 | calls: 1'), 'malformed records dropped')
    h.win.destroy()
}


// -- Tab focus ----------------------------------------------------------------------

console.log('\n\u2500\u2500 Tab focus \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    EventBus.emit('automation:runCompleted', callRecord({ automation: 'Rollers', run: 1 }))
    EventBus.emit('automation:runCompleted', callRecord({ automation: 'Lights', run: 1, rules: ['dim-evening'] }))
    await tick()

    let screen = h.screenText()
    assert(screen.includes('[Lights] [Rollers]'), 'tab bar lists both automations')
    assert(screen.includes('dim-evening'), 'second automation box rendered')

    assert(h.win.setFocus('lights') === true, 'known automation focused case-insensitively')
    await tick()
    screen = h.screenText()
    assert(screen.includes('[Lights*]'), 'focused tab starred')
    assert(!screen.includes('morning-open'), 'unfocused box hidden')
    assert(screen.includes('focused: Lights'), 'footer names the focus')
    assert(screen.includes('shown: 1'), 'title counts the shown box')

    assert(h.win.setFocus('Nope') === false, 'unknown automation not focused')

    h.win.clearFocus()
    await tick()
    screen = h.screenText()
    assert(screen.includes('morning-open'), 'clear focus shows every box')
    assert(screen.includes('[Lights]') && !screen.includes('[Lights*]'), 'star removed after clear')
    assert(h.win.getFocus() === null, 'focus cleared')
    assert(JSON.stringify(h.win.getAutomationNames()) === '["Lights","Rollers"]', 'names sorted')
    h.win.destroy()
}

// -- Seeding from automation histories ---------------------------------------------

console.log('\n\u2500\u2500 Seeding from automation histories \u2500\u2500\n')

{
    AutomationContainer.registerInstance('Seeded', {
        name: 'Seeded',
        getRecentAutomationCalls() {
            return [
                { automation: 'Seeded', run: 2, at: AT, trigger: 'sensor', forced: false, outcome: 'acted', reason: '', rules: ['newer-close'] },
                { automation: 'Seeded', run: 1, at: AT - 1000, trigger: 'timer', forced: false, outcome: 'no-match', reason: '', rules: [] },
            ]
        },
        getRecentRuleMatches() { return [] },
    })

    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    const screen = h.screenText()
    assert(screen.includes('[Seeded]'), 'seeded automation tabbed')
    assert(screen.includes('newer-close'), 'seeded newest call rendered')
    assert(screen.includes('no-match'), 'seeded older call rendered')
    assert(screen.indexOf('no-match') < screen.indexOf('newer-close'), 'seeded newest call at the bottom')
    assert(screen.includes('Boxes: 1 | calls: 2'), 'seeded calls counted')
    h.win.destroy()
}

// -- Fallback seeding from rule matches --------------------------------------------

console.log('\n\u2500\u2500 Fallback seeding from rule matches \u2500\u2500\n')

{
    AutomationContainer.registerInstance('Legacy', {
        name: 'Legacy',
        getRecentRuleMatches() {
            return [
                { automation: 'Legacy', rule: 'late-rule', at: AT, trigger: 'timer', forced: false, acted: true, run: 5 },
                { automation: 'Legacy', rule: 'early-rule', at: AT, trigger: 'timer', forced: false, acted: false, run: 5 },
                { automation: 'Legacy', rule: 'solo-rule', at: AT - 1000, trigger: 'sensor', forced: false, acted: false, run: 4 },
            ]
        },
    })

    const h = createHarness({ width: 100, height: 40 })
    h.win.show()
    await tick()

    const screen = h.screenText()
    assert(screen.includes('late-rule, early-rule'), 'same-run matches grouped into one call')
    assert(screen.includes('solo-rule'), 'older run rendered as its own call')
    assert(screen.includes('Boxes: 2 | calls: 4'), 'grouped calls counted alongside the seeded box')
    assert(screen.includes('acted'), 'acted match marks its call acted')
    h.win.destroy()
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\nResults: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}\n`)

process.exit(failed > 0 ? 1 : 0)

