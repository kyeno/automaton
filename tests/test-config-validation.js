/**
 * Config file validation tests.
 * Recursively discovers all .yaml/.yml files -- including *.dist templates --
 * under etc/ and verifies valid YAML syntax plus basic formatting conventions
 * (no tabs, no trailing whitespace, single final newline).
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const ROOT = resolve(import.meta.dirname, '..')
const ETC_DIR = join(ROOT, 'etc')

let passed = 0
let failed = 0

function assert(condition, label) {
    if (condition) {
        console.log(`  ✓ ${label}`)
        passed++
    } else {
        console.error(`  ✗ ${label}`)
        failed++
    }
}

/* ------------------------------------------------------------------ */
 /* Helper: recursively collect all .yaml files                        */
/* ------------------------------------------------------------------ */
function collectYaml(dir, list = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (entry.startsWith('.')) continue
        const stat = statSync(full)
        if (stat.isDirectory()) {
            collectYaml(full, list)
        } else if (entry.endsWith('.yaml') || entry.endsWith('.yml') ||
                   entry.endsWith('.yaml.dist') || entry.endsWith('.yml.dist')) {
            list.push(full.replace(ROOT + '/', ''))
        }
    }
    return list.sort()
}

/* ------------------------------------------------------------------ */
 /* 1. Discover config files                                           */
/* ------------------------------------------------------------------ */
console.log('\n── Config file discovery ──\n')

const yamlFiles = collectYaml(ETC_DIR)
assert(yamlFiles.length > 0, `Found ${yamlFiles.length} YAML config file(s)`)
assert(yamlFiles.includes('etc/automaton.yaml'), 'Main config etc/automaton.yaml exists')

for (const f of yamlFiles) {
    assert(yamlFiles.includes(f), `Discovered: ${f}`)
}

/* ------------------------------------------------------------------ */
 /* 2. Validate YAML syntax & formatting                               */
/* ------------------------------------------------------------------ */
console.log('\n── YAML syntax & formatting validation ──\n')

for (const file of yamlFiles) {
    const fullPath = join(ROOT, file)
    let content
    try {
        content = readFileSync(fullPath, 'utf-8')
    } catch (e) {
        assert(false, `${file} - unreadable: ${e.message}`)
        continue
    }

    // Formatting conventions (house style): no tabs, no trailing whitespace,
    // and exactly one final newline at EOF.
    const lines = content.split('\n')
    const badTabs = []
    const badTrail = []
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('\t')) badTabs.push(i + 1)
        if (/[ \t]+$/.test(lines[i])) badTrail.push(i + 1)
    }
    const fmtNote = list => list.slice(0, 5).join(', ') + (list.length > 5 ? ` (+${list.length - 5})` : '')
    assert(badTabs.length === 0, `${file} - no tab characters${badTabs.length ? ` (line ${fmtNote(badTabs)})` : ''}`)
    assert(badTrail.length === 0, `${file} - no trailing whitespace${badTrail.length ? ` (line ${fmtNote(badTrail)})` : ''}`)
    assert(content.endsWith('\n') && !content.endsWith('\n\n'), `${file} - ends with a single final newline`)

    try {
        parse(content)
        assert(true, `${file} - valid YAML`)
    } catch (e) {
        assert(false, `${file} - ${e.message}`)
    }
}

/* ------------------------------------------------------------------ */
 /* Summary                                                            */
/* ------------------------------------------------------------------ */
const total = passed + failed
console.log(`\n${'═'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)