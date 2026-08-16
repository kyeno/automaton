/**
 * String utility tests.
 * Behavioral coverage for stripMarkdown(): underscore-identifier safety,
 * image-before-link ordering, and regression guards for all other rules.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import { stripMarkdown } from '../src/lib/string.js'

let passed = 0
let failed = 0

function assertEqual(actual, expected, label) {
    if (actual === expected) {
        console.log(`  ✓ ${label}`)
        passed++
    } else {
        console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
        failed++
    }
}

// -- Passthrough ---------------------------------------------------------------

console.log('\n── Passthrough ──\n')

assertEqual(stripMarkdown(null), null, 'null passthrough')
assertEqual(stripMarkdown(undefined), undefined, 'undefined passthrough')
assertEqual(stripMarkdown(42), 42, 'non-string passthrough')
assertEqual(stripMarkdown(''), '', 'empty string stays empty')
assertEqual(stripMarkdown('plain text'), 'plain text', 'plain text unchanged')

// -- Underscore identifier safety ----------------------------------------------

console.log('\n── Underscore identifier safety ──\n')

assertEqual(stripMarkdown('state_last_updated'), 'state_last_updated', 'snake_case identifier preserved')
assertEqual(stripMarkdown('The key state_last_updated changed'), 'The key state_last_updated changed', 'identifier mid-sentence preserved')
assertEqual(stripMarkdown('snake_case_text'), 'snake_case_text', 'multi-underscore identifier preserved')
assertEqual(stripMarkdown('model_v2_value'), 'model_v2_value', 'digit-bearing identifier preserved')
assertEqual(stripMarkdown('a_b'), 'a_b', 'single underscore with word neighbors preserved')
assertEqual(stripMarkdown('`state_last_updated` works'), 'state_last_updated works', 'inline code around identifier survives stripping intact')

// -- Genuine underscore italics still stripped ----------------------------------

console.log('\n── Genuine underscore italics ──\n')

assertEqual(stripMarkdown('This is _really_ cool'), 'This is really cool', 'mid-sentence underscore italic stripped')
assertEqual(stripMarkdown('_hello_ world'), 'hello world', 'leading underscore italic stripped')
assertEqual(stripMarkdown('end _bye_'), 'end bye', 'trailing underscore italic stripped')
assertEqual(stripMarkdown('(see _docs_) now'), '(see docs) now', 'punctuation-flanked underscore italic stripped')

// -- Images before links ---------------------------------------------------------

console.log('\n── Images before links ──\n')

assertEqual(stripMarkdown('![alt text](http://x/y)'), 'alt text', 'image becomes alt text, no stray "!"')
assertEqual(stripMarkdown('See ![logo](u1) here'), 'See logo here', 'mid-sentence image becomes alt text')
assertEqual(stripMarkdown('![img](u1) and [link](u2)'), 'img and link', 'mixed image + link sentence')

// -- Plain links -----------------------------------------------------------------

console.log('\n── Plain links ──\n')

assertEqual(stripMarkdown('[text](url)'), 'text', 'plain link keeps its label')
assertEqual(stripMarkdown('Visit [site](https://a.b) today'), 'Visit site today', 'mid-sentence plain link kept')

// -- Regression guards for other rules ---------------------------------------------

console.log('\n── Other rule regression guards ──\n')

assertEqual(stripMarkdown('**bold**'), 'bold', 'double-star bold stripped')
assertEqual(stripMarkdown('__bold__'), 'bold', 'underscore bold stripped')
assertEqual(stripMarkdown('*italic*'), 'italic', 'asterisk italic stripped')
assertEqual(stripMarkdown('~~gone~~'), 'gone', 'strikethrough stripped')
assertEqual(stripMarkdown('# Title here'), 'Title here', 'header marker removed')
assertEqual(stripMarkdown('before\n```\ncode block\n```\nafter'), 'before\n\nafter', 'fenced code block removed')
assertEqual(stripMarkdown('> quoted text'), 'quoted text', 'blockquote marker removed')
assertEqual(stripMarkdown('- item one'), 'item one', 'unordered list marker removed')
assertEqual(stripMarkdown('hi \u{1F600} there'), 'hi  there', 'emoji removed')

// -- Summary -----------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)