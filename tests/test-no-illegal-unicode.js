#!/usr/bin/env node
/**
 * Illegal Unicode punctuation check.
 *
 * Scans JavaScript and YAML files under src/ and etc/ -- including *.dist
 * templates -- for decorative Unicode characters that have no place in code,
 * comments, config values, or log messages per CONTRIBUTING.md:
 *   - Arrows (U+2192 U+21D2 U+27A1 U+27A4 U+2190 U+21D0) -- use "->" / "<-"
 *   - Em/en dashes (U+2014 U+2013) -- use regular dash "-"
 *   - Curly/smart quotes (U+201C U+201D U+2018 U+2019 ...) -- use straight '"'/'"'
 *   - Ellipsis (U+2026) -- use three dots "..."
 *   - Bullets (U+2022 U+2023 U+25AA U+25AB) -- use "-" or "*"
 *   - Warning sign (U+26A0), circles (U+25CF U+25CB) -- use ASCII "[!]", "*", "o",
 *     or "\uXXXX" escapes inside string literals
 *   - Math relational symbols (U+2264 U+2265) -- use "<=" / ">="
 *   - Degree sign (U+00B0) -- spell it out ("deg", "degrees")
 *   - Box-drawing characters (U+2500-U+257F) -- use ASCII "-","+","|" or
 *     "\uXXXX" escapes inside string literals
 *
 * Natural language diacritics are allowed (Polish accented chars, Cyrillic, etc.)
 * since they appear in i18n strings and config content. Only decorative
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
    // Warning / status glyphs
    { char: '\u26A0', name: 'warning sign' },
    // Circles used as decorative icons (use ASCII or \uXXXX escapes in strings)
    { char: '\u25CF', name: 'black circle' },
    { char: '\u25CB', name: 'white circle' },
    // Math relational symbols -- use "<=" / ">="
    { char: '\u2264', name: 'less-than or equal to' },
    { char: '\u2265', name: 'greater-than or equal to' },
    // Degree sign -- spell it out ("deg", "degrees")
    { char: '\u00B0', name: 'degree sign' },
];

// Ranges of illegal code points (inclusive). Covers whole blocks that are
// always decorative, e.g. box-drawing characters used for tree diagrams.
var ILLEGAL_RANGES = [
    { from: 0x2500, to: 0x257F, name: 'box-drawing character' },
];

/**
 * Look up the label for an illegal code point, or null when it is legal.
 * Checks single-character entries first, then inclusive ranges.
 * @param {number} cp - Unicode code point
 * @returns {?string} Human-readable label when the code point is illegal
 */
function findIllegalLabel(cp) {
    for (var i = 0; i < ILLEGAL_CHARS.length; i++) {
        if (ILLEGAL_CHARS[i].char.codePointAt(0) === cp) return ILLEGAL_CHARS[i].name;
    }
    for (var r = 0; r < ILLEGAL_RANGES.length; r++) {
        if (cp >= ILLEGAL_RANGES[r].from && cp <= ILLEGAL_RANGES[r].to) return ILLEGAL_RANGES[r].name;
    }
    return null;
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
    // Note: *.dist templates are intentionally NOT excluded -- they are committed
    // source content and must follow the same conventions as active files.
    return false;
}

// File extensions scanned by this check. Templates named "<name>.<ext>.dist"
// are matched on their base extension so they get the same treatment.
var SCANNED_EXTENSIONS = ['.js', '.yaml', '.yml'];

/** @returns {boolean} true when the entry name matches a scanned extension */
function hasScannedExtension(entryName) {
    var base = entryName.replace(/\.dist$/, '');
    for (var k = 0; k < SCANNED_EXTENSIONS.length; k++) {
        if (base.endsWith(SCANNED_EXTENSIONS[k])) return true;
    }
    return false;
}

function collectSourceFiles(dir) {
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
            var sub = collectSourceFiles(full);
            for (var j = 0; j < sub.length; j++) results.push(sub[j]);
        } else if (hasScannedExtension(entry)) {
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

var files = collectSourceFiles(SRC_DIR).concat(collectSourceFiles(ETC_DIR));
var violations = [];

for (var fi = 0; fi < files.length; fi++) {
    var filePath = files[fi];
    var relPath = relative(ROOT, filePath).replace(/\\/g, '/');
    var content = readFileSync(filePath, 'utf8');
    var lines = content.split('\n');

    for (var li = 0; li < lines.length; li++) {
        var lineText = lines[li];
        for (var ci = 0; ci < lineText.length;) {
            var cp = lineText.codePointAt(ci);
            var label = findIllegalLabel(cp);
            if (label !== null) {
                violations.push({
                    file: relPath,
                    line: li + 1,          // 1-based
                    char: String.fromCodePoint(cp),
                    label: label,
                    snippet: lineText.substring(Math.max(0, ci - 25), Math.min(lineText.length, ci + 26)).trim()
                });
            }
            ci += cp > 0xFFFF ? 2 : 1;     // astral chars occupy two UTF-16 units
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
