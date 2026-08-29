/**
 * JSDoc completeness check.
 *
 * Complements test-jsdoc-coverage.js (which verifies that public members have
 * some documentation at all) by enforcing exact mechanical rules on every
 * method defined directly in a class body under src/ and etc/:
 *   C1 - a JSDoc block must sit immediately above the method definition --
 *        this covers ES-private (#) methods and constructors, which the
 *        coverage check deliberately skips
 *   C2 - the number of top-level parameters in the signature must equal the
 *        number of top-level @param tags; subfield-style entries such as
 *        "@param {string} [opts.endpoint]" document nested fields of an
 *        already-counted parameter and do not count toward the total
 *   C3 - ES-private (#) methods must carry an @private tag inside their block
 *
 * Any violation fails the check -- there is intentionally no threshold: these
 * are exact rules, so partial compliance is reported per file:line instead of
 * being averaged away.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { accessSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

var ROOT = resolve(import.meta.dirname, '..');
var SCAN_DIRS = ['src', 'etc/automation', 'etc/interaction'];

// Control-flow / statement keywords that can look like "name (" at method indent
var KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function',
    'new', 'do', 'else', 'typeof', 'yield', 'await', 'class'
]);

/**
 * Recursively collect .js files under a directory. Skips dot-dirs and
 * distribution templates (.dist), mirroring test-jsdoc-coverage.js exclusions.
 * @param {string} dir - Absolute directory to scan
 * @returns {Array<string>} Collected file paths
 */
function collectJs(dir) {
    var results = [];
    var entries;
    try {
        entries = readdirSync(dir);
    } catch (e) {
        return results; // directory may not exist in minimal setups
    }
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.startsWith('.')) continue;
        var full = join(dir, entry);
        var st = statSync(full);
        if (st.isDirectory()) {
            var sub = collectJs(full);
            for (var j = 0; j < sub.length; j++) results.push(sub[j]);
        } else if (entry.endsWith('.js') && !entry.endsWith('.dist')) {
            results.push(full);
        }
    }
    return results;
}

/**
 * Extract the argument list of the first balanced (...) group on a line.
 * Brackets and braces are tracked so default values like f({a: [1]}) parse cleanly.
 * @param {string} line - Source line containing the signature
 * @returns {?string} Text between the matching parens, or null when unbalanced
 */
function argList(line) {
    var start = line.indexOf('(');
    if (start === -1) return null;
    var depth = 0;
    for (var p = start; p < line.length; p++) {
        var ch = line[p];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            if (depth === 0) return line.slice(start + 1, p);
        }
    }
    return null;
}

/**
 * Count top-level parameters in an argument-list string. Destructuring
 * objects/arrays and default values count as one parameter each.
 * @param {string} inner - Text inside the signature parens
 * @returns {number} Parameter count (0 when empty)
 */
function paramCount(inner) {
    var trimmed = inner.trim();
    if (trimmed === '') return 0;
    var depth = 0;
    var count = 1;
    for (var i = 0; i < trimmed.length; i++) {
        var c = trimmed[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) count++;
    }
    return count;
}

/**
 * Locate the JSDoc block immediately above a declaration line: blank lines may
 * separate them, but nothing else may intervene (same contract as
 * hasJSDocAbove() in test-jsdoc-coverage.js).
 * @param {Array<string>} lines - File content split into lines
 * @param {number} declLine - 0-based index of the method definition
 * @returns {?Array<string>} The comment lines including both markers, or null
 */
function docBlockAbove(lines, declLine) {
    var cursor = declLine - 1;
    while (cursor >= 0 && lines[cursor].trim() === '') cursor--;
    if (cursor < 0 || !lines[cursor].trim().endsWith('*/')) return null;
    var end = cursor;
    while (cursor >= 0) {
        var t = lines[cursor].trim();
        if (t === '') { cursor--; continue; }   // blank lines inside a block are legal
        if (t.startsWith('/**') || t.startsWith('/*')) return lines.slice(cursor, end + 1);
        if (!t.startsWith('*')) return null;
        cursor--;
    }
    return null;
}

/**
 * Count @param tags by kind. Subfield entries whose name contains a dot
 * (e.g., opts.endpoint) are tallied separately because they document nested
 * fields rather than additional signature parameters.
 * @param {Array<string>} blockLines - Lines of one JSDoc block
 * @returns {{top: number, subfields: number}} Tag counts by kind
 */
function paramTags(blockLines) {
    var top = 0;
    var subfields = 0;
    for (var i = 0; i < blockLines.length; i++) {
        var idx = blockLines[i].indexOf('@param');
        if (idx === -1) continue;
        var rest = blockLines[i].slice(idx + '@param'.length).replace(/^\s+/, '');
        // Skip the type annotation -- braces may be nested (union types with
        // inline object literals), so consume them by depth counting instead
        // of stopping at the first closing brace.
        if (rest.charAt(0) === '{') {
            var depth = 0;
            var closeBrace = -1;
            for (var q = 0; q < rest.length; q++) {
                if (rest[q] === '{') depth++;
                else if (rest[q] === '}') {
                    depth--;
                    if (depth === 0) { closeBrace = q; break; }
                }
            }
            if (closeBrace === -1) continue; // malformed type -- no name to count
            rest = rest.slice(closeBrace + 1).replace(/^\s+/, '');
        }
        // Optional parameters are written as [name] or [name=default]
        var name = '';
        if (rest.charAt(0) === '[') {
            var closeBracket = rest.indexOf(']');
            if (closeBracket === -1) continue;
            name = rest.slice(1, closeBracket);
            // [name=default] -- the default value may contain dots (this.#x); only
            // the identifier part decides whether this is a subfield entry.
            var eq = name.indexOf('=');
            if (eq !== -1) name = name.slice(0, eq);
        } else {
            var m = /^[\w$]+(?:\.[\w$]+)*/.exec(rest);
            if (!m) continue;
            name = m[0];
        }
        if (name.indexOf('.') !== -1) subfields++;
        else top++;
    }
    return { top: top, subfields: subfields };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

var files = [];
for (var di = 0; di < SCAN_DIRS.length; di++) {
    var dirPath = join(ROOT, SCAN_DIRS[di]);
    try {
        accessSync(dirPath);
    } catch (e) {
        continue; // directory may not exist in minimal setups
    }
    var found = collectJs(dirPath);
    for (var fi2 = 0; fi2 < found.length; fi2++) files.push(found[fi2]);
}

var totalMethods = 0;
/** @type {Array<{file: string, line: number, rule: string, message: string}>} */
var violations = [];

function addViolation(relFile, lineNo, rule, message) {
    violations.push({ file: relFile, line: lineNo, rule: rule, message: message });
}

for (var f = 0; f < files.length; f++) {
    var filePath = files[f];
    var relFile = relative(ROOT, filePath).replace(/\\/g, '/');
    var lines = readFileSync(filePath, 'utf8').split('\n');

    for (var i = 0; i < lines.length; i++) {
        // Method definitions sit at exactly four-space class-body indent with an
        // optional modifier run before the name. Control-flow keywords are
        // excluded so "if (...)" style statements can never match.
        var m = /^    (?:(?:async|static)\s+)*(?:get\s+|set\s+)?(#?\w+)\s*\(/.exec(lines[i]);
        if (!m || KEYWORDS.has(m[1])) continue;
        // Definition lines open the method body on the same line; bare call sites
        // at four-space indent (e.g., printHelp(x)) must not count as methods.
        if (!lines[i].trim().endsWith('{')) continue;
        var name = m[1];
        totalMethods++;

        // C1 -- JSDoc block immediately above
        var block = docBlockAbove(lines, i);
        if (!block) {
            addViolation(relFile, i + 1, 'C1', 'method "' + name + '" has no JSDoc block above it');
            continue;
        }

        // C2 -- top-level @param tags must match signature parameters
        var args = argList(lines[i]);
        if (args !== null) {
            var expected = paramCount(args);
            var tags = paramTags(block);
            if (tags.top !== expected) {
                addViolation(
                    relFile, i + 1, 'C2',
                    'method "' + name + '" declares ' + expected + ' parameter(s)'
                    + ' but documents ' + tags.top + ' via @param'
                    + (tags.subfields > 0 ? ' (' + tags.subfields + ' subfield tag(s) ignored)' : '')
                );
            }
        }

        // C3 -- ES-private methods carry the @private descriptor
        if (name.charAt(0) === '#' && !/@private\b/.test(block.join('\n'))) {
            addViolation(relFile, i + 1, 'C3', 'ES-private method "#' + name.slice(1) + '" lacks an @private tag');
        }
    }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('');
console.log('-- JSDoc Completeness --');
console.log('');
console.log('Scanned: ' + files.length + ' file(s), ' + totalMethods + ' class-body method(s)');
console.log('Rules:   C1 block present | C2 @param count matches signature | C3 #methods tagged @private');
console.log('');

if (violations.length > 0) {
    console.log(violations.length + ' violation(s):');
    console.log('');
    var byFile = {};
    for (var v = 0; v < violations.length; v++) {
        var item = violations[v];
        if (!byFile[item.file]) byFile[item.file] = [];
        byFile[item.file].push(item);
    }
    var fileKeys = Object.keys(byFile).sort();
    for (var fk = 0; fk < fileKeys.length; fk++) {
        console.log('  ' + fileKeys[fk] + ':');
        var items = byFile[fileKeys[fk]];
        for (var ii = 0; ii < items.length; ii++) {
            console.log('    line ' + items[ii].line + ': [' + items[ii].rule + '] ' + items[ii].message);
        }
    }
    console.log('');
}

var passed = violations.length === 0;
var sep = '';
for (var si = 0; si < 50; si++) sep += '-';
console.log(sep);
if (passed) {
    console.log('  Result: PASS (' + totalMethods + ' method(s), all rules satisfied)');
} else {
    console.log('  Result: FAIL (' + violations.length + ' violation(s))');
}
console.log(sep);
console.log('');

process.exit(passed ? 0 : 1);