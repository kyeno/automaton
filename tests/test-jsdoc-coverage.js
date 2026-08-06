#!/usr/bin/env node
/**
 * JSDoc coverage test.
 *
 * Scans all source files under src/ and checks that public classes, methods,
 * and top-level functions are documented with JSDoc comments.
 *
 * Emits warnings for _prefix naming (should use # per ES6 private convention).
 *
 * Fails if overall documentation coverage falls below a configurable threshold
 * (default 80%, overridable via JSDOC_MIN_COVERAGE environment variable).
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
var MIN_COVERAGE = parseInt(process.env.JSDOC_MIN_COVERAGE, 10) || 80;

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
    var entries = readdirSync(dir);
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

/**
 * Check if there is a JSDoc block comment above the given line index.
 * @param {string[]} lines
 * @param {number} declLine - 0-based line index of declaration
 * @returns {boolean}
 */
function hasJSDocAbove(lines, declLine) {
    var cursor = declLine - 1;

    // Skip blank lines above
    while (cursor >= 0 && lines[cursor].trim() === '') {
        cursor--;
    }
    if (cursor < 0) return false;

    var trimmed = lines[cursor].trim();
    if (!trimmed.endsWith('*/')) return false;

    // Scan upward to find /**
    while (cursor >= 0) {
        var t = lines[cursor].trim();
        if (t.startsWith('/**')) return true;
        if (t.startsWith('*')) { cursor--; continue; }
        return false;
    }
    return false;
}

/**
 * Extract public members from source content.
 * @param {string} _filePath
 * @param {string} content
 * @returns {Array} Array of member objects
 */
function parseDeclarations(_filePath, content) {
    var lines = content.split('\n');
    var members = [];
    var inClass = false;
    var braceDepth = 0;

    for (var i = 0; i < lines.length; i++) {
        var rawLine = lines[i];
        var trimmed = rawLine.trim();

        // Skip comments and blanks
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            continue;
        }

        // Class declaration
        var classMatch = trimmed.match(/^(export\s+)?class\s+(\w+)/);
        if (classMatch && !inClass) {
            var className = classMatch[2];
            if (!className.startsWith('_') && !className.startsWith('#')) {
                members.push({ name: className, line: i + 1, type: 'class' });
            }
            inClass = true;
            braceDepth = 0;
            var opens = (rawLine.match(/{/g) || []).length;
            var closes = (rawLine.match(/}/g) || []).length;
            braceDepth += opens - closes;
            continue;
        }

        if (inClass) {
            var o2 = (rawLine.match(/{/g) || []).length;
            var c2 = (rawLine.match(/}/g) || []).length;
            braceDepth += o2 - c2;

            if (braceDepth <= 0) {
                inClass = false;
                braceDepth = 0;
                continue;
            }

            // Detect methods at depth 1
            if (braceDepth === 1) {
                var methodMatch = trimmed.match(/^(?:static\s+)?(?:async\s+)?(#?[\w]+)\s*\(/);
                if (methodMatch) {
                    var methodName = methodMatch[1];
                    if (methodName !== 'constructor') {
                        members.push({ name: methodName, line: i + 1, type: 'method' });
                    }
                }
            }
            continue;
        }

        // Top-level function declaration (only at module scope, not nested inside classes)
        if (!inClass) {
            var funcDeclMatch = trimmed.match(/^(export\s+)?(?:async\s+)?function\s+(\w+)/);
            if (funcDeclMatch) {
                members.push({ name: funcDeclMatch[2], line: i + 1, type: 'function' });
            }
        }

        // Const arrow/function expressions (only at top-level module scope)
        // Skip if inside a class body OR nested inside any function (braceDepth > 0)
        if (!inClass && braceDepth === 0) {
            var constFuncMatch = trimmed.match(
                /^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/
            );
            if (!constFuncMatch) {
                constFuncMatch = trimmed.match(/^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/);
            }
            if (constFuncMatch) {
                members.push({ name: constFuncMatch[2], line: i + 1, type: 'function' });
            }
        }
    }

    return members;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

var files = collectJsFiles(SRC_DIR);
var totalMembers = 0;
var documentedMembers = 0;
var warnings = [];
var missingDocs = [];

for (var fi = 0; fi < files.length; fi++) {
    var filePath = files[fi];
    var relPath = relative(ROOT, filePath).replace(/\\/g, '/');
    var content = readFileSync(filePath, 'utf8');
    var lines = content.split('\n');
    var memList = parseDeclarations(filePath, content);

    for (var mi = 0; mi < memList.length; mi++) {
        var member = memList[mi];
        totalMembers++;

        // Warn on _prefix naming
        if (member.name.startsWith('_')) {
            warnings.push({
                file: relPath,
                line: member.line,
                name: member.name,
                message: 'Private-ish "' + member.name + '" uses _ prefix; consider #' + member.name.slice(1) + ' (ES6 private)'
            });
            documentedMembers++;
            continue;
        }

        // Skip true ES6 private
        if (member.name.startsWith('#')) {
            documentedMembers++;
            continue;
        }

        // Check JSDoc above declaration
        if (hasJSDocAbove(lines, member.line - 1)) {
            documentedMembers++;
        } else {
            missingDocs.push({
                file: relPath,
                line: member.line,
                name: member.name,
                type: member.type
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Output report
// ---------------------------------------------------------------------------

console.log('');
console.log('-- JSDoc Coverage --');
console.log('');

var coveragePct = totalMembers > 0 ? ((documentedMembers / totalMembers) * 100).toFixed(1) : '100.0';

if (warnings.length > 0) {
    console.log('[WARN] ' + warnings.length + ' naming warning(s):');
    for (var wi = 0; wi < warnings.length; wi++) {
        var w = warnings[wi];
        console.log('   WARNING  ' + w.file + ':' + w.line + '  ' + w.message);
    }
    console.log('');
}

if (missingDocs.length > 0) {
    console.log(missingDocs.length + ' undocumented public member(s):');
    console.log('');
    var byFile = {};
    for (var di = 0; di < missingDocs.length; di++) {
        var m = missingDocs[di];
        if (!byFile[m.file]) byFile[m.file] = [];
        byFile[m.file].push(m);
    }
    var fileKeys = Object.keys(byFile);
    for (var fk = 0; fk < fileKeys.length; fk++) {
        var fKey = fileKeys[fk];
        console.log('  ' + fKey + ':');
        var items = byFile[fKey];
        for (var ii = 0; ii < items.length; ii++) {
            var item = items[ii];
            console.log('    line ' + item.line + ': ' + item.type + ' "' + item.name + '"');
        }
    }
    console.log('');
}

console.log('Coverage: ' + documentedMembers + '/' + totalMembers + ' members documented (' + coveragePct + '%)');
console.log('Threshold: ' + MIN_COVERAGE + '%');
console.log('');

var passed = parseFloat(coveragePct) >= MIN_COVERAGE;
var sep = '';
for (var si = 0; si < 50; si++) sep += '-';

console.log(sep);
if (passed) {
    console.log('  Result: PASS (' + coveragePct + '% >= ' + MIN_COVERAGE + '%)');
} else {
    console.log('  Result: FAIL (' + coveragePct + '% < ' + MIN_COVERAGE + '%)');
}
console.log(sep);
console.log('');

process.exit(passed ? 0 : 1);
