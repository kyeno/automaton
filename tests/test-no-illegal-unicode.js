#!/usr/bin/env node
/**
 * Illegal Unicode punctuation check.
 *
 * Scans source files under src/ and etc/ for decorative Unicode characters
 * that have no place in code, comments, or log messages per CONTRIBUTING.md:
 *   - Arrows (U+2192 U+21D2 U+27A1 U+27A4 U+2190 U+21D0) -- use "->" / "<-"
 *   - Em/en dashes (U+2014 U+2013) -- use regular dash "-"
 *   - Curly/smart quotes (U+201C U+201D U+2018 U+2019 ...) -- use straight '"'/'"'
 *   - Ellipsis (U+2026) -- use three dots "..."
 *   - Bullets (U+2022 U+2023 U+25AA U+25AB) -- use "-" or "*"
 *
 * Natural language diacritics are allowed (Polish accented chars, Cyrillic, etc.)
 * since they appear in i18n strings inside source code. Only decorative
 * punctuation is flagged.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

var ROOT = resolve(import.meta.dirname, '..');
var SRC_DIR = join(ROOT, 'src');
var ETC_DIR = join(ROOT, 'etc');

// Decorative Unicode characters that must not appear in JS source files.
// Each entry stores the character as an escape sequence and a label for reports.
var ILLEGAL_CHARS = [
    // Arrows
    { char: '\u2192', name: 'right arrow' },
    { char: '\u21D2', name: 'implies' },
    { char: '\u27A1', name: 'black right arrow' },
    { char: '\u27A4', name: 'white arrow head' },
    { char: '\u2190', name: 'left arrow' },
    { char: '\u21D0', name: 'implied by' },
    // Em/en dashes
    { char: '\u2014', name: 'em dash' },
    { char: '\u2013', name: 'en dash' },
    // Curly/smart quotes
    { char: '\u201C', name: 'left double quote' },
    { char: '\u201D', name: 'right double quote' },
    { char: '\u2018', name: 'left single quote' },
    { char: '\u2019', name: 'right single quote' },
    { char: '\u201E', name: 'low-900 double quote' },
    { char: '\u201A', name: 'single low-9 quote' },
    { char: '\u203A', name: 'single high-reversed quote' },
    { char: '\u2039', name: 'single high quote' },
    // Ellipsis
    { char: '\u2026', name: 'horizontal ellipsis' },
    // Bullets and list markers
    { char: '\u2022', name: 'bullet' },
    { char: '\u2023', name: 'triangular bullet' },
    { char: '\u25AA', name: 'black small square' },
    { char: '\u25AB', name: 'white small square' },
];

/** Build a Set of illegal Unicode code points for O(1) lookups. */
var ILLEGAL_CODEPOINTS = new Set();
for (var i = 0; i < ILLEGAL_CHARS.length; i++) {
    ILLEGAL_CODEPOINTS.add(ILLEGAL_CHARS[i].char.charCodeAt(0));
}

/** Map from single-char string to its human-readable label. */
var CHAR_LABELS = {};
for (var j = 0; j < ILLEGAL_CHARS.length; j++) {
    CHAR_LABELS[ILLEGAL_CHARS[j].char] = ILLEGAL_CHARS[j].name;
}

/* ------------------------------------------------------------------ */
/* File collection                                                    */
/* ------------------------------------------------------------------ */

function shouldExclude(relPath) {
    var parts = relPath.split('/');
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].startsWith('_')) return true;
    }
    if (/node_modules/.test(relPath)) return true;
    if (/\.dist$/.test(relPath)) return true;
    return false;
}

function collectJsFiles(dir) {
    var results = [];
    try {
        var entries = readdirSync(dir);
    } catch (e) {
        return results; // directory doesn't exist or unreadable -- skip silently
    }
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var full = join(dir, entry);
        if (entry.startsWith('.')) continue;
        var rel = relative(ROOT, full).replace(/\\/g, '/');
        if (shouldExclude(rel)) continue;
        var st = statSync(full);
        if (st.isDirectory()) {
            var sub = collectJsFiles(full);
            for (var j = 0; j < sub.length; j++) results.push(sub[j]);
        } else if (entry.endsWith('.js')) {
            results.push(full);
        }
    }
    return results;
}

/* ------------------------------------------------------------------ */
/* Scan                                                               */
/* ------------------------------------------------------------------ */

console.log('');
console.log('-- Illegal Unicode Punctuation Check --');
console.log('');

var files = collectJsFiles(SRC_DIR).concat(collectJsFiles(ETC_DIR));
var violations = [];

for (var fi = 0; fi < files.length; fi++) {
    var filePath = files[fi];
    var relPath = relative(ROOT, filePath).replace(/\\/g, '/');
    var content = readFileSync(filePath, 'utf8');
    var lines = content.split('\n');

    for (var li = 0; li < lines.length; li++) {
        var lineText = lines[li];
        for (var ci = 0; ci < lineText.length; ci++) {
            var cp = lineText.charCodeAt(ci);
            if (!ILLEGAL_CODEPOINTS.has(cp)) continue;
            var ch = lineText[ci];
            violations.push({
                file: relPath,
                line: li + 1,          // 1-based
                char: ch,
                label: CHAR_LABELS[ch] || ('unknown U+' + cp.toString(16).toUpperCase()),
                snippet: lineText.trim().substring(Math.max(0, ci - 20), Math.min(lineText.trim().length, ci + 21))
            });
        }
    }
}

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

if (violations.length > 0) {
    console.log(violations.length + ' violation(s) found:\n');
    for (var vi = 0; vi < violations.length; vi++) {
        var v = violations[vi];
        console.log('  ' + v.file + ':' + v.line);
        console.log('    Found "' + v.char + '" (' + v.label + ') in: ...' + v.snippet + '...');
    }
    console.log('');
    console.log('Replace with ASCII equivalents per CONTRIBUTING.md.');
    console.log('');
    var sep = '';
    for (var si = 0; si < 50; si++) sep += '-';
    console.log(sep);
    console.log('  Result: FAIL -- illegal Unicode punctuation detected');
    console.log(sep);
    console.log('');
    process.exit(1);
} else {
    console.log('No illegal Unicode punctuation found in ' + files.length + ' file(s).');
    console.log('');
    var sep2 = '';
    for (var si2 = 0; si2 < 50; si2++) sep2 += '-';
    console.log(sep2);
    console.log('  Result: PASS');
    console.log(sep2);
    console.log('');
    process.exit(0);
}
