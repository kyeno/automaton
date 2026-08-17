/**
 * Input component tests.
 * Behavioral coverage for the bottom-row command prompt: character insertion,
 * backspace/delete editing, arrow-key navigation, Unicode (astral) safety,
 * control-character rejection, and the sliding-window width bound that long
 * messages must respect.
 *
 * The component is driven through a mock terminal/layout pair that records
 * every rendered frame, so assertions read what would actually hit the screen.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import InputComponent from '../src/ui/widgets/inputComponent.js'

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

// -- Mock harness --------------------------------------------------------------

/**
 * Build an InputComponent wired to a recording mock terminal and layout slot.
 * Each render produces one record { prompt, before, after, col }; press(name)
 * feeds a key event through every registered 'key' listener exactly like
 * terminal-kit would.
 * @param {number} width - Simulated input slot width in columns
 * @returns {{press: function(string): void, buffer: function(): string, lastRender: function(): object}}
 */
function createInput(width) {
    const renders = []
    let pending = null
    const keyListeners = []

    // The terminal is callable: first plain write per frame is the prompt,
    // the second is the text right of the cursor; bold.white carries the text
    // left of the cursor; moveTo finalizes the frame.
    const term = function (text) {
        if (!pending) pending = {}
        if ('prompt' in pending) pending.after = String(text)
        else pending.prompt = String(text)
    }
    term.on = (event, fn) => { if (event === 'key') keyListeners.push(fn) }
    term.hideCursor = () => {}
    term.eraseLineAfter = () => {}
    term.styleReset = () => {}
    term.moveTo = (x) => {
        if (pending) {
            pending.col = x
            renders.push(pending)
            pending = null
        }
    }
    term.bold = {
        white: (t) => { if (pending) pending.before = String(t) },
    }

    const layout = {
        getSlot: (name) => name === 'input' ? { x: 0, y: 23, width, height: 1 } : null,
        moveToSlot: () => {},
    }

    const component = new InputComponent(term, layout)
    component.init()

    return {
        press(name) { for (const fn of keyListeners) fn(name, {}) },
        buffer() {
            const r = renders[renders.length - 1]
            return r ? r.before + r.after : ''
        },
        lastRender() { return renders[renders.length - 1] || null },
    }
}

/**
 * Detect a lone surrogate half anywhere in the string -- the exact corruption
 * that used to leave one invisible replacement glyph on screen.
 * @param {string} str - Buffer content to inspect
 * @returns {boolean} true when any unpaired surrogate unit is present
 */
function hasLoneSurrogate(str) {
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) {
            const n = str.charCodeAt(i + 1)
            if (!(n >= 0xdc00 && n <= 0xdfff)) return true
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            const p = str.charCodeAt(i - 1)
            if (!(p >= 0xd800 && p <= 0xdbff)) return true
        }
    }
    return false
}

// -- Insertion and backspace ----------------------------------------------------

console.log('\n\u2500\u2500 Insertion and backspace \u2500\u2500\n')

{
    const h = createInput(80)
    h.press('a'); h.press('b'); h.press('c')
    assertEqual(h.buffer(), 'abc', 'three characters accumulate in order')
    h.press('backspace')
    assertEqual(h.buffer(), 'ab', 'backspace removes the last character')
    h.press('backspace')
    assertEqual(h.buffer(), 'a', 'second backspace removes the next character')
    h.press('backspace')
    assertEqual(h.buffer(), '', 'third backspace empties the buffer')
    h.press('backspace')
    assertEqual(h.buffer(), '', 'backspace on an empty buffer is a safe no-op')
    // terminal-kit emits UPPERCASE key names over SSH; both spellings must work
    h.press('x')
    h.press('BACKSPACE')
    assertEqual(h.buffer(), '', 'uppercase BACKSPACE name handled identically')
}

// -- Delete key and arrow navigation ---------------------------------------------

console.log('\n\u2500\u2500 Delete key and arrow navigation \u2500\u2500\n')

{
    const h = createInput(80)
    for (const ch of ['a', 'b', 'c']) h.press(ch)
    h.press('left')
    assertEqual(h.lastRender().before, 'ab', 'left arrow moves the cursor one position left')
    assertEqual(h.lastRender().after, 'c', 'text right of the cursor stays in the after segment')
    h.press('home')
    assertEqual(h.lastRender().before, '', 'home jumps to the start of the line')
    assertEqual(h.lastRender().after, 'abc', 'entire text sits right of the cursor at home')
    h.press('right')
    assertEqual(h.lastRender().before, 'a', 'right arrow steps back into the text')
    h.press('end')
    assertEqual(h.lastRender().before, 'abc', 'end jumps to the end of the line')
    // delete removes forward from the cursor
    h.press('home')
    h.press('delete')
    assertEqual(h.buffer(), 'bc', 'delete removes the character under the cursor')
    h.press('delete')
    assertEqual(h.buffer(), 'c', 'second delete removes the next character')
    h.press('delete')
    assertEqual(h.buffer(), '', 'delete empties the buffer and stops safely')
}

{
    const h = createInput(80)
    for (const ch of ['a', 'b', 'c', 'd']) h.press(ch)
    h.press('left')       // cursor now between c and d
    h.press('backspace')  // must remove c, not d
    assertEqual(h.buffer(), 'abd', 'mid-buffer backspace removes the character left of the cursor')
}

// -- Unicode safety ---------------------------------------------------------------

console.log('\n\u2500\u2500 Unicode safety \u2500\u2500\n')

{
    const EMOJI = '\u{1F44D}'
    const h = createInput(80)
    h.press('a'); h.press(EMOJI); h.press('b')
    assertEqual(h.buffer(), `a${EMOJI}b`, 'astral character inserts as a single unit')
    assertEqual(hasLoneSurrogate(h.buffer()), false, 'no lone surrogates after astral insertion')
    h.press('backspace')
    assertEqual(h.buffer(), `a${EMOJI}`, 'trailing ASCII removed before touching the glyph')
    h.press('backspace')
    assertEqual(h.buffer(), 'a', 'next backspace removes the whole astral glyph, never half of it')
    assertEqual(hasLoneSurrogate(h.buffer()), false, 'buffer stays surrogate-clean after full deletion')
}

{
    const EMOJI = '\u{1F44D}'
    const h = createInput(80)
    h.press('a'); h.press('b'); h.press(EMOJI)
    h.press('left')
    assertEqual(h.lastRender().before, 'ab', 'left arrow lands before the astral glyph in one step')
    assertEqual(h.lastRender().after, EMOJI, 'glyph sits intact right of the cursor')
    h.press('left')
    assertEqual(h.lastRender().before, 'a', 'further left steps cross exactly one code point each')
}

// -- Control character rejection ---------------------------------------------------

console.log('\n\u2500\u2500 Control character rejection \u2500\u2500\n')

{
    const h = createInput(80)
    h.press('x')
    h.press('\u007f')
    assertEqual(h.buffer(), 'x', 'raw DEL control byte is rejected by the insert guard')
    h.press('\u0001')
    assertEqual(h.buffer(), 'x', 'other control characters are rejected too')
}

// -- Sliding window width bound ------------------------------------------------------

console.log('\n\u2500\u2500 Sliding window width bound \u2500\u2500\n')

{
    // prompt '> ' takes 2 columns, leaving 17 for text plus 1 reserved cursor cell
    const h = createInput(20)
    const message = 'abcdefghijklmnopqrstuvwxyzabcd'   // 30 chars > 18 visible
    let maxVisible = 0
    for (const ch of message) {
        h.press(ch)
        const r = h.lastRender()
        maxVisible = Math.max(maxVisible, [...r.prompt].length + [...r.before].length + [...r.after].length)
    }
    assertEqual(maxVisible <= 20, true, `long message never overflows the slot (${maxVisible}/20 cols used)`)
    assertEqual(h.buffer(), 'nopqrstuvwxyzabcd', 'window scrolls to keep the newest characters visible')
    h.press('backspace')
    assertEqual(h.buffer(), 'mnopqrstuvwxyzabc', 'backspace works while scrolled inside the window')
    h.press('home')
    assertEqual(h.lastRender().after, 'abcdefghijklmnopq', 'home re-renders from the start of the buffer')
    assertEqual(h.lastRender().col, 3, 'cursor column accounts for the prompt width only when cursor is at start')
}

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)