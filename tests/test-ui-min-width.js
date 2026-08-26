/**
 * UI minimum render width tests.
 * Verifies that ui.layout.min_width actually drives the layout manager's
 * "terminal too narrow" threshold (previously a hardcoded constant), i.e. that
 * raising or lowering the configured floor changes when rendering is suppressed.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import UiLayoutManager from '../src/ui/layout/uiLayoutManager.js'

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

// Stub terminal exposing only what updateSlots() reads (.width/.height).
const makeTerm = (width, height) => ({ width, height })

console.log('\ntest-ui-min-width\n')

// -- Default floor -----------------------------------------------------------
{
    const lm = new UiLayoutManager(makeTerm(100, 40)) // main slot width == 100
    assertEqual(lm.minSlotWidth, 50, 'default minimum render width is 50')
    assertEqual(lm.isTooNarrow(), false, '100-col terminal renders normally at default floor')
}

// -- Raising the floor suppresses rendering ---------------------------------
{
    const lm = new UiLayoutManager(makeTerm(100, 40))
    lm.setMinWidth(80)
    assertEqual(lm.minSlotWidth, 80, 'setMinWidth(80) updates the floor')
    assertEqual(lm.isTooNarrow(), false, 'still fine when terminal (100) >= floor (80)')

    lm.setMinWidth(120)
    assertEqual(lm.isTooNarrow(), true, 'suppressed when terminal (100) < floor (120)')
}

// -- Lowering the floor allows narrower terminals ----------------------------
{
    const lm = new UiLayoutManager(makeTerm(60, 30)) // main slot width == 60
    assertEqual(lm.isTooNarrow(), false, '60-col terminal OK at default floor (50)')
    lm.setMinWidth(70)
    assertEqual(lm.isTooNarrow(), true, 'raising floor to 70 now suppresses a 60-col terminal')
    lm.setMinWidth(40)
    assertEqual(lm.isTooNarrow(), false, 'lowering floor to 40 re-enables the 60-col terminal')
}

// -- Invalid values are ignored ---------------------------------------------
{
    const lm = new UiLayoutManager(makeTerm(100, 40))
    lm.setMinWidth('wide')   // not a number
    assertEqual(lm.minSlotWidth, 50, 'non-numeric value is ignored')
    lm.setMinWidth(-5)       // non-positive
    assertEqual(lm.minSlotWidth, 50, 'negative value is ignored')
    lm.setMinWidth(NaN)      // NaN
    assertEqual(lm.minSlotWidth, 50, 'NaN is ignored')
    lm.setMinWidth(2.9)      // fractional -> floored
    assertEqual(lm.minSlotWidth, 2, 'fractional width is floored to an integer')
}

console.log('')
if (failed > 0) {
    console.error(`${failed} assertion(s) FAILED`)
    process.exit(1)
} else {
    console.log(`All ${passed} assertions passed`)
}