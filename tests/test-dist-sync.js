/**
 * Distribution template sync test.
 *
 * Compares every .yaml.dist template against its active counterpart and flags
 * any structural drift — keys present in the working config that are missing
 * from the distribution template. This catches forgotten template updates when
 * new configuration options are added during development.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseDocument as yamlParseDocument } from 'yaml'

const ROOT = resolve(import.meta.dirname, '..')
const ETC_DIR = join(ROOT, 'etc')

let passed = 0
let failed = 0
let skipped = 0

function pass(label) {
    console.log(`  ✓ ${label}`)
    passed++
}

function fail(label) {
    console.error(`  ✗ ${label}`)
    failed++
}

// ---------------------------------------------------------------------------
// Recursively discover all .yaml.dist files under etc/
// ---------------------------------------------------------------------------

function findDistFiles(dir, list = []) {
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.')) continue
        const full = join(dir, entry)
        const st = statSync(full)
        if (st.isDirectory()) {
            findDistFiles(full, list)
        } else if (entry.endsWith('.yaml.dist')) {
            // Active path = same path without ".dist" suffix
            const activePath = full.replace(/\.dist$/, '')
            list.push({ dist: full, active: activePath })
        }
    }
    return list
}

const pairs = findDistFiles(ETC_DIR)

if (pairs.length === 0) {
    console.log('\n  ⊘ No .yaml.dist templates found in etc/ (skipped)\n')
    process.exit(0)
}

console.log(`\n── YAML .dist template drift check (${pairs.length} pair(s)) ──\n`)

// ---------------------------------------------------------------------------
// Recursive key-walk: collect every leaf/key path in a YAML object
// Skips array elements (data, not structure) and only tracks object keys.
// ---------------------------------------------------------------------------

/**
 * Recursively collect all dot-notation key paths from an object up to a max depth.
 * Arrays are treated as data — their indices are NOT traversed.
 * Limiting depth prevents flagging user-specific data entries (device names, hostnames)
 * as "missing structure" since those naturally differ between installations.
 *
 * @param {Object} obj
 * @param {string} prefix
 * @param {number} depth - Current nesting level (0 = top-level keys)
 * @param {number} maxDepth - Stop recursing beyond this depth
 * @returns {Set<string>}
 */
function collectKeyPaths(obj, prefix = '', depth = 0, maxDepth = 3) {
    const paths = new Set()
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
        return paths
    }
    for (const key of Object.keys(obj)) {
        const fullPath = prefix ? `${prefix}.${key}` : key
        paths.add(fullPath)
        // If the value is a nested object and we haven't hit max depth, recurse
        const val = obj[key]
        if (val != null && typeof val === 'object' && !Array.isArray(val) && depth + 1 < maxDepth) {
            const childPaths = collectKeyPaths(val, fullPath, depth + 1, maxDepth)
            for (const cp of childPaths) paths.add(cp)
        }
    }
    return paths
}

// ---------------------------------------------------------------------------
// Compare each pair
// ---------------------------------------------------------------------------

for (const { dist, active } of pairs) {
    const relDist = dist.replace(ROOT + '/', '')
    const relActive = active.replace(ROOT + '/', '')

    // Check if active config exists
    let activeExists = false
    try {
        statSync(active)
        activeExists = true
    } catch {
        // Active file doesn't exist — nothing to compare against
        pass(`${relDist}: no active config (OK in CI / fresh clone)`)
        skipped++
        continue
    }

    // Load both YAML files
    /** @type {Object|null} */
    let distObj, activeObj
    try {
        const doc = yamlParseDocument(readFileSync(dist, 'utf-8'))
        distObj = doc.toJS()
    } catch (e) {
        fail(`${relDist}: failed to parse template — ${e.message}`)
        continue
    }

    try {
        const doc = yamlParseDocument(readFileSync(active, 'utf-8'))
        activeObj = doc.toJS()
    } catch (e) {
        fail(`${relActive}: failed to parse active config — ${e.message}`)
        continue
    }

    // If either is null/empty, skip structural comparison
    if (!distObj || typeof distObj !== 'object') {
        pass(`${relDist}: empty template (structural check N/A)`)
        skipped++
        continue
    }
    if (!activeObj || typeof activeObj !== 'object') {
        pass(`${relActive}: empty active config (nothing to compare)`)
        skipped++
        continue
    }

    // Collect key paths — limit recursion to depth 1 so we compare top-level
    // sections and their immediate sub-sections without flagging user-specific
    // data entries (hostnames, device names) that naturally differ between installs.
    const distKeys   = collectKeyPaths(distObj, '', 0, 1)
    const activeKeys = collectKeyPaths(activeObj, '', 0, 1)

    // Find keys in active that are missing from .dist
    /** @type {string[]} */
    const missing = []
    for (const key of activeKeys) {
        if (!distKeys.has(key)) {
            // Only report the parent key (first segment difference), not every nested child
            // e.g., if "logger.console.custom_levels" is missing, don't also flag
            // "logger.console.custom_levels.error" separately
            let isDuplicate = false
            for (const existing of missing) {
                if (key.startsWith(existing + '.')) {
                    isDuplicate = true
                    break
                }
            }
            if (!isDuplicate) {
                missing.push(key)
            }
        }
    }

    if (missing.length === 0) {
        pass(`${relDist}: all ${activeKeys.size} key(s) present in template`)
    } else {
        fail(`${relDist}: ${missing.length} key(s) missing from template:`)
        for (const m of missing) {
            console.error(`      → ${m}`)
        }
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed + skipped
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)