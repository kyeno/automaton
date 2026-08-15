/**
 * File conventions check.
 *
 * Static convention checks per CONTRIBUTING.md, complementing the illegal
 * Unicode scan:
 *   - Shebangs only on executable scripts -- a "#!" first line is flagged in
 *     any .js file without an execute permission bit (imported library
 *     modules must not carry shebangs).
 *   - No tab characters anywhere in scanned files (4-space indentation rule).
 *   - Code lines under src/ indented by a multiple of 4 spaces. Lines inside
 *     block comments, quoted strings, and template literals (including ${...}
 *     interpolations) are exempt; a small state machine tracks those contexts
 *     across lines. Standalone comment lines are also exempt.
 *   - Singleton naming: default-exported module singletons must be built from
 *     an S-prefixed class (class SX -> instance export), e.g. SConfigService.
 *
 * Scans .js files under src/, bin/, tests/. The indentation and singleton
 * rules apply to src/ only for now; dev tooling keeps its own style.
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
var SCAN_DIRS = [join(ROOT, 'src'), join(ROOT, 'bin'), join(ROOT, 'tests')];

/* ------------------------------------------------------------------ */
/* File collection                                                    */
/* ------------------------------------------------------------------ */

function shouldExclude(relPath) {
    var parts = relPath.split('/');
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].startsWith('_')) return true;
    }
    if (/node_modules/.test(relPath)) return true;
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
/* Rule: shebang on non-executable file                                */
/* ------------------------------------------------------------------ */

/**
 * A "#!" first line is only meaningful on executable scripts. Flag it in any
 * other .js file so imported library modules stay clean per CONTRIBUTING.md.
 * @param {string} filePath - Absolute path (stat needs the real file)
 * @returns {Array<Object>} violations
 */
function checkShebang(filePath, lines) {
    if (!lines[0] || !lines[0].startsWith('#!')) return [];
    var mode = statSync(filePath).mode;
    if ((mode & 0o111) !== 0) return []; // genuinely executable -- allowed
    return [{ rule: 'shebang-on-non-executable', line: 1, detail: "remove the shebang (file has no execute bit)" }];
}

/* ------------------------------------------------------------------ */
/* Rule: tab characters                                                */
/* ------------------------------------------------------------------ */

/** One violation per tab occurrence (reporting caps examples per file). */
function checkTabs(lines) {
    var out = [];
    for (var li = 0; li < lines.length; li++) {
        var idx = -1;
        while ((idx = lines[li].indexOf('\t', idx + 1)) !== -1) {
            out.push({ rule: 'tab-character', line: li + 1, col: idx + 1, detail: 'use spaces instead of tabs' });
        }
    }
    return out;
}
/* ------------------------------------------------------------------ */
/* Rule: 4-space indentation under src/                                */
/* ------------------------------------------------------------------ */

/**
 * Index just past a single/double-quoted string starting at startIdx. These
 * strings cannot span newlines in valid JS, so scanning stays on one line.
 * Unterminated input runs to end of line (lenient -- syntax errors elsewhere).
 * @param {string} text - Line content
 * @param {number} startIdx - Position of the opening quote
 * @param {string} quoteChar - "'" or '"'
 * @returns {number} Index after the closing quote
 */
function endOfQuotedString(text, startIdx, quoteChar) {
    for (var q = startIdx + 1; q < text.length; q++) {
        if (text[q] === '\\') { q++; continue; }
        if (text[q] === quoteChar) return q + 1;
    }
    return text.length;
}

/**
 * Scan one JavaScript file and report code lines whose leading whitespace is
 * not a multiple of 4 spaces. Tracks block comments, quoted strings, and
 * template literals with ${...} interpolation across lines so their contents
 * are exempt from the check. Standalone comment lines are exempt too.
 * @param {string} content - Full file content
 * @returns {Array<Object>} violations with 1-based line numbers
 */
function findIndentViolations(content) {
    var out = [];
    var lines = content.split('\n');
    var inBlockComment = false;
    // Stack entries: { kind: 'template' } or { kind: 'interp', depth: number }
    var stack = [];

    function contextState() {
        if (!stack.length) return 'code';
        return stack[stack.length - 1].kind === 'interp' ? 'code' : 'templit';
    }

    for (var li = 0; li < lines.length; li++) {
        var lineText = lines[li];
        var state = inBlockComment ? 'blockcomment' : contextState();

        // Candidate indentation only counts when the line starts in plain code
        // context AND its first token is not a standalone comment.
        var candidate = null;
        if (state === 'code') {
            var ws = 0;
            while (ws < lineText.length && (lineText[ws] === ' ' || lineText[ws] === '\t')) ws++;
            var c1 = lineText[ws];
            var c2 = ws + 1 < lineText.length ? lineText[ws + 1] : '';
            var isCommentStart = (c1 === '/' && (c2 === '/' || c2 === '*'));
            if (ws > 0 && !isCommentStart) candidate = ws;
        }

        var i = 0;
        while (i < lineText.length) {
            var ch = lineText[i];
            var next = i + 1 < lineText.length ? lineText[i + 1] : '';
            if (state === 'code') {
                if (ch === '/' && next === '*') { state = 'blockcomment'; i += 2; continue; }
                if (ch === '/' && next === '/') break; // rest of line is a comment
                if (ch === "'" || ch === '"') { i = endOfQuotedString(lineText, i, ch); continue; }
                if (ch === '`') { stack.push({ kind: 'template' }); state = 'templit'; i++; continue; }
                if (stack.length && stack[stack.length - 1].kind === 'interp') {
                    var top = stack[stack.length - 1];
                    if (ch === '{') top.depth++;
                    else if (ch === '}') {
                        if (top.depth > 0) top.depth--;
                        else { stack.pop(); state = contextState(); }
                    }
                }
                i++;
            } else if (state === 'blockcomment') {
                var closeIdx = lineText.indexOf('*/', i);
                if (closeIdx === -1) break;
                i = closeIdx + 2;
                state = 'code';
            } else { // templit
                if (ch === '\\') { i += 2; continue; }
                if (ch === '`') { stack.pop(); state = contextState(); i++; continue; }
                if (ch === '$' && next === '{') { stack.push({ kind: 'interp', depth: 0 }); state = 'code'; i += 2; continue; }
                i++;
            }
        }

        inBlockComment = (state === 'blockcomment');
        if (candidate !== null && candidate % 4 !== 0) {
            out.push({ rule: 'indent-not-multiple-of-4', line: li + 1, indent: candidate, detail: 'leading whitespace is ' + candidate + ' spaces (expected a multiple of 4)' });
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Rule: S-prefixed class for default-exported singletons              */
/* ------------------------------------------------------------------ */

var SINGLETON_CLASS_RE = /^[S][A-Z]/;

/** Escape regex special chars so an identifier can be embedded safely. */
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 1-based line number of a character offset in the file content. */
function lineOf(content, idx) {
    var n = 1;
    for (var k = 0; k < idx; k++) if (content[k] === '\n') n++;
    return n;
}

/**
 * Detect module-level singletons whose backing class lacks the documented
 * "S" prefix. Matches the two instance-export shapes used in this codebase:
 *   export default Object.freeze(new X())
 *   const y = new X(); ... export default y
 * @param {string} content - Full file content
 * @returns {Array<Object>} violations with 1-based line numbers
 */
function findSingletonNamingViolations(content) {
    var out = [];
    var m;
    var reDirect = /export\s+default\s+Object\.freeze\(new\s+([A-Za-z_$][\w$]*)\s*\(\)\)/g;
    while ((m = reDirect.exec(content)) !== null) {
        if (!SINGLETON_CLASS_RE.test(m[1])) {
            out.push({ rule: 'singleton-class-missing-S-prefix', line: lineOf(content, m.index), detail: "class '" + m[1] + "' should be named 'S" + m[1] + "'" });
        }
    }
    var reInstance = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)/g;
    while ((m = reInstance.exec(content)) !== null) {
        var exportedName = m[1];
        var className = m[2];
        var exportRe = new RegExp('export\\s+default\\s+' + escapeRegExp(exportedName) + '\\b');
        if (exportRe.test(content) && !SINGLETON_CLASS_RE.test(className)) {
            out.push({ rule: 'singleton-class-missing-S-prefix', line: lineOf(content, m.index), detail: "class '" + className + "' should be named 'S" + className + "'" });
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Scan & report                                                       */
/* ------------------------------------------------------------------ */

console.log('');
console.log('-- File Conventions Check --');
console.log('');

var files = [];
for (var d = 0; d < SCAN_DIRS.length; d++) {
    var found = collectJsFiles(SCAN_DIRS[d]);
    for (var f = 0; f < found.length; f++) files.push(found[f]);
}

var violations = [];
for (var fi = 0; fi < files.length; fi++) {
    var filePath = files[fi];
    var relPath = relative(ROOT, filePath).replace(/\\/g, '/');
    var content = readFileSync(filePath, 'utf8');
    var lines = content.split('\n');
    var isSrc = relPath.indexOf('src/') === 0;

    var local = checkShebang(filePath, lines);
    local = local.concat(checkTabs(lines));
    if (isSrc) {
        local = local.concat(findIndentViolations(content));
        local = local.concat(findSingletonNamingViolations(content));
    }
    for (var v = 0; v < local.length; v++) {
        local[v].file = relPath;
        violations.push(local[v]);
    }
}

if (violations.length > 0) {
    // Group by file and cap examples per file to keep the output readable.
    var byFile = {};
    var order = [];
    for (var gi = 0; gi < violations.length; gi++) {
        var g = violations[gi];
        if (!byFile[g.file]) { byFile[g.file] = []; order.push(g.file); }
        byFile[g.file].push(g);
    }
    console.log(violations.length + ' violation(s) found in ' + order.length + ' file(s):\n');
    var MAX_EXAMPLES = 8;
    for (var oi = 0; oi < order.length; oi++) {
        var list = byFile[order[oi]];
        console.log('  ' + order[oi] + ' (' + list.length + ')');
        for (var ei = 0; ei < Math.min(list.length, MAX_EXAMPLES); ei++) {
            var e2 = list[ei];
            console.log('    line ' + e2.line + ': [' + e2.rule + '] ' + e2.detail);
        }
        if (list.length > MAX_EXAMPLES) console.log('    ... and ' + (list.length - MAX_EXAMPLES) + ' more');
    }
    console.log('\nFix per CONTRIBUTING.md conventions.\n');
    var sep = '';
    for (var si = 0; si < 50; si++) sep += '-';
    console.log(sep);
    console.log('  Result: FAIL -- convention violations detected');
    console.log(sep);
    console.log('');
    process.exit(1);
} else {
    console.log('No convention violations found in ' + files.length + ' file(s).');
    console.log('');
    var sep2 = '';
    for (var si2 = 0; si2 < 50; si2++) sep2 += '-';
    console.log(sep2);
    console.log('  Result: PASS');
    console.log(sep2);
    console.log('');
    process.exit(0);
}
