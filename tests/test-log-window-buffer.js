/**
 * Log window buffer tests.
 * Regression coverage for the live-tail freeze: once a window's ring buffer
 * reaches max_buffer_lines, every new entry trims one oldest entry -- the
 * "rendered up-to" index must shift down by the same amount or incremental
 * renders see zero pending entries and stop updating the screen entirely
 * until a forced full re-render (window switch / PgUp-PgDn).
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

// -- Mock harness --------------------------------------------------------------

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

// -- Buffer cap keeps live tail updating ---------------------------------------

console.log('\n\u2500\u2500 Live tail past buffer cap \u2500\u2500\n')

{
    // Minimum allowed cap is 100 entries; use a short main slot so the content
    // always overflows one screen and renders through the #renderAll path.
    const h = createHarness({ width: 80, height: 24 })
    h.win.setMaxBufferLines(100)
    h.win.show()
    await tick()

    // Fill past the cap in one coalesced burst (throttle merges into one pass).
    for (let i = 1; i <= 105; i++) {
        h.win.print(`line ${i}`)
    }
    await tick()
    assertEqual(h.screenText().includes('line 105'), true, 'burst up to the cap reaches the screen')

    // The regression: with the tracking index pinned at the cap, these single
    // post-cap lines used to be skipped by every render pass until a window
    // switch or PgDn forced a full redraw.
    h.win.print('after-cap marker A')
    await tick()
    assertEqual(h.screenText().includes('after-cap marker A'), true, 'first line after the cap still appears live')

    h.win.print('after-cap marker B')
    await tick()
    assertEqual(h.screenText().includes('after-cap marker B'), true, 'subsequent lines keep appearing without manual refresh')

    // Sanity: explicit scroll-down (the old workaround) still lands on the tail.
    h.win.scrollPageDown()
    await tick()
    assertEqual(h.screenText().includes('after-cap marker B'), true, 'PgDn still snaps back to the live tail')
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)