/**
 * Rules window tests.
 *
 * Coverage for the UI window listing the most recent automation rule matches:
 * rows arrive on the 'automation:ruleMatched' / 'automation:ruleActed' EventBus
 * channels published by RuleBasedAutomationBase, the outcome flag flips from
 * 'matched' to 'acted' on the identity (automation, rule, timestamp) the two
 * events share, the table is capped, malformed records are dropped, a forced run
 * is marked with '!', and the table seeds from each automation's own history
 * when the window is opened after the fact.
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
 * Build one match record as the automation base publishes it.
 * @param {Object} [over] - Fields to override
 * @returns {Object} Match record payload
 */
function matchRecord(over = {}) {
    return { automation: 'Rollers', rule: 'morning-open', at: AT, trigger: 'timer', forced: false, acted: false, ...over }
}

// -- Empty state -------------------------------------------------------------------

console.log('\n\u2500\u2500 Empty state \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 24 })
    h.win.show()
    await tick()
    assert(h.screenText().includes('No rule matches recorded yet'), 'empty window says so')
    h.win.destroy()
}

// -- Match row rendering -----------------------------------------------------------

console.log('\n\u2500\u2500 Match row rendering \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 24 })
    h.win.show()
    await tick()

    EventBus.emit('automation:ruleMatched', matchRecord())
    await tick()

    const screen = h.screenText()
    assert(screen.includes('Automation'), 'header row rendered')
    assert(screen.includes('Rollers'), 'automation column rendered')
    assert(screen.includes('morning-open'), 'rule column rendered')
    assert(screen.includes('timer'), 'trigger column rendered')
    assert(screen.includes('matched'), 'outcome column shows matched')
    assert(screen.includes('07:30:00'), 'timestamp column rendered')
    h.win.destroy()
}

// -- Outcome flips on the matching identity ----------------------------------------

console.log('\n\u2500\u2500 Matched to acted \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 24 })
    h.win.show()
    await tick()

    EventBus.emit('automation:ruleMatched', matchRecord())
    await tick()
    assert(h.screenText().includes('matched'), 'row starts as matched')

    EventBus.emit('automation:ruleActed', matchRecord({ acted: true }))
    await tick()

    const screen = h.screenText()
    assert(screen.includes('acted'), 'outcome flips to acted')
    assert(!screen.includes('matched'), 'no stale matched row left')
    assert(screen.includes('Matches: 1'), 'acted event does not duplicate the row')

    // An outcome event for a row the window never saw is dropped, not rendered.
    EventBus.emit('automation:ruleActed', matchRecord({ rule: 'ghost-rule', acted: true }))
    await tick()
    assert(!h.screenText().includes('ghost-rule'), 'orphan acted event ignored')
    h.win.destroy()
}

// -- Forced runs and malformed records ---------------------------------------------

console.log('\n\u2500\u2500 Forced runs and malformed records \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 24 })
    h.win.show()
    await tick()

    EventBus.emit('automation:ruleMatched', matchRecord({ forced: true, trigger: 'manual' }))
    await tick()
    assert(h.screenText().includes('manual!'), 'forced run marked with !')

    EventBus.emit('automation:ruleMatched', null)
    EventBus.emit('automation:ruleMatched', {})
    EventBus.emit('automation:ruleMatched', { automation: 'X', rule: 'r', at: 'nope' })
    await tick()
    assert(h.screenText().includes('Matches: 1'), 'malformed records dropped')
    h.win.destroy()
}

// -- History cap -------------------------------------------------------------------

console.log('\n\u2500\u2500 History cap \u2500\u2500\n')

{
    const h = createHarness({ width: 100, height: 24 })
    h.win.show()
    await tick()

    for (let i = 0; i < 70; i++) {
        EventBus.emit('automation:ruleMatched', matchRecord({ at: AT + i, rule: `rule-${i}` }))
    }
    await tick()

    const screen = h.screenText()
    assert(screen.includes('Matches: 60'), 'table capped at 60 rows')
    assert(screen.includes('rule-69'), 'newest match kept')
    assert(!screen.includes('rule-0'), 'oldest match dropped')
    h.win.destroy()
}

// -- Seeding from automation histories ---------------------------------------------

console.log('\n\u2500\u2500 Seeding from automation histories \u2500\u2500\n')

{
    AutomationContainer.registerInstance('Seeded', {
        name: 'Seeded',
        getRecentRuleMatches() {
            return [
                { automation: 'Seeded', rule: 'old-open', at: AT - 1000, trigger: 'timer', forced: false, acted: true },
                { automation: 'Seeded', rule: 'newer-close', at: AT, trigger: 'sensor', forced: false, acted: false },
            ]
        },
    })

    const h = createHarness({ width: 100, height: 24 })
    h.win.show()
    await tick()

    const screen = h.screenText()
    assert(screen.includes('old-open'), 'seeded older match rendered')
    assert(screen.includes('newer-close'), 'seeded newer match rendered')
    assert(screen.includes('Matches: 2'), 'seeded rows counted')
    const newerAt = screen.indexOf('newer-close')
    const olderAt = screen.indexOf('old-open')
    assert(newerAt > olderAt, 'newest seeded row rendered last (window tail)')
    h.win.destroy()
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\nResults: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}\n`)

process.exit(failed > 0 ? 1 : 0)

