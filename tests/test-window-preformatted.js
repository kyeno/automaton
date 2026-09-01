/**
 * BaseWindow preformatted-entry tests.
 * Regression coverage for the /config debug indentation mangling: whitespace-
 * significant output (box-drawing trees) used to be word-reflowed by the prose
 * wrapper (wrapAnsi), which dropped leading whitespace and collapsed multiple
 * spaces, turning "│   ├─" into "│ ├─". printPreformatted() buffers lines
 * untrimmed and the render path hard-wraps them with wrapPreformatted() instead,
 * so indentation reaches the screen intact.
 *
 * BaseWindow is driven through a recording virtual terminal grid so
 * assertions read exactly what would appear on the user's display.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import BaseWindow from '../src/ui/windows/baseWindow.js'

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

/** Wait past BaseWindow's 30 ms render throttle so scheduled passes fire. */
const tick = () => new Promise(resolve => setTimeout(resolve, 80))

// -- Mock harness (same virtual-grid pattern as test-log-window-buffer.js) ------

/**
 * Build a visible BaseWindow wired to a virtual terminal grid. The grid models
 * the main slot cell-for-cell; term.moveTo/term(text) update it exactly like
 * CUP + character writes would on a real tty, and layout.clearSlot blanks rows.
 * @param {{width: number, height: number}} size - Simulated main slot geometry
 * @returns {{win: BaseWindow, screenText: function(): string}}
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

    const win = new BaseWindow('Logs', term, layout)
    return {
        win,
        screenText() {
            return grid.map(row => row.join('')).join('\n')
        },
    }
}

// -- Tree indentation survives the render path ----------------------------------

console.log('\n\u2500\u2500 printPreformatted: tree indentation stays intact on screen \u2500\u2500\n')

{
    const h = createHarness({ width: 80, height: 24 })
    h.win.show()
    await tick()

    const tree = [
        '\u251c\u2500 ui',
        '\u2502   \u251c\u2500 status_bar',
        '\u2502   \u2502   \u2514\u2500 lines[2]',
        '\u2502   \u2514\u2500 windows[4]',
        '\u2514\u2500 logger',
    ]
    h.win.printPreformatted(tree.join('\n'))
    await tick()

    const screen = h.screenText()
    for (const line of tree) {
        assertEqual(screen.includes(line), true, `on screen intact: ${line}`)
    }
    // The regression: prose wrapping collapsed '│   ├─' into '│ ├─'
    assertEqual(screen.includes('\u2502 \u251c\u2500'), false, 'no collapsed-indent artifact (│ ├─)')
}

// -- Over-long lines hard-break with the indent carried -------------------------

console.log('\n\u2500\u2500 printPreformatted: over-long lines hard-break, re-indented \u2500\u2500\n')

{
    const h = createHarness({ width: 80, height: 24 })
    h.win.show()
    await tick()

    // 4-space indent + 100 chars at an 80-wide slot: first line 80 visible
    // (4 spaces + 76 chars), continuation re-indented 4 spaces + 24 chars.
    h.win.printPreformatted('    ' + 'A'.repeat(100))
    await tick()

    const rows = h.screenText().split('\n').map(r => r.replace(/\s+$/, ''))
    assertEqual(rows.some(r => r === '    ' + 'A'.repeat(76)), true, 'first line fills the slot width')
    assertEqual(rows.some(r => r === '    ' + 'A'.repeat(24)), true, 'continuation is a separate re-indented line')
    const aCount = (h.screenText().match(/A/g) || []).length
    assertEqual(aCount, 100, 'no characters lost across the hard break')
}

// -- Summary ---------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)