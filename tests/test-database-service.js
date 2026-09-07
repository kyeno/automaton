/**
 * Unit tests for DatabaseService (local SQLite state-transition history).
 *
 * Covers: init/close availability, record + dedupe semantics, current-state reads,
 * lastTransitionTs / priorStateDurationMs / priorTransitionTs timing, null->unknown
 * normalization, history filtering/ordering, and fail-open behaviour when the store
 * cannot be opened.
 *
 * Uses an isolated temp database so the real project store is never touched.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import DatabaseService from '../src/service/databaseService.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-db-test-'))
const dbFile = path.join(dir, 'state.db')
let failures = 0

function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok - ${name}`))
        .catch((e) => { failures += 1; console.error(`  FAIL - ${name}: ${e.message}`) })
}

async function main() {
    // -- Availability -----------------------------------------------------
    const ready = await DatabaseService.init(dbFile)
    assert.equal(ready, true, 'init should succeed with a writable temp path')
    assert.ok(DatabaseService.isAvailable(), 'service reports available after init')

    // -- Record + dedupe --------------------------------------------------
    let r = await DatabaseService.recordTransition({ domain: 'videoPlayer', subject: 'htpc', toState: 'playing' })
    assert.equal(r.changed, true, 'first change is recorded')
    assert.ok(typeof r.ts === 'number' && r.ts > 0, 'record returns an epoch-ms timestamp')

    r = await DatabaseService.recordTransition({ domain: 'videoPlayer', subject: 'htpc', toState: 'playing' })
    assert.equal(r.changed, false, 'identical state is deduped (no new row)')

    r = await DatabaseService.recordTransition({ domain: 'videoPlayer', subject: 'htpc', toState: 'paused' })
    assert.equal(r.changed, true, 'a different state records again')

    // -- Current-state reads ---------------------------------------------
    assert.equal(await DatabaseService.getCurrent('videoPlayer', 'htpc'), 'paused', 'current reflects last write')
    assert.equal(await DatabaseService.lastTransitionTs('videoPlayer', 'htpc'), r.ts, 'lastTransitionTs matches written ts')

    // -- null/undefined -> unknown ---------------------------------------
    r = await DatabaseService.recordTransition({ domain: 'videoPlayer', subject: 'bedroom', toState: null })
    assert.equal(r.changed, true, 'null state recorded as unknown')
    assert.equal(await DatabaseService.getCurrent('videoPlayer', 'bedroom'), 'unknown', 'null maps to the unknown label')

    // -- Absent subject ---------------------------------------------------
    assert.equal(await DatabaseService.getCurrent('network', 'ghost'), null, 'absent subject current is null')
    assert.equal(await DatabaseService.lastTransitionTs('network', 'ghost'), null, 'absent subject ts is null')
    assert.equal(await DatabaseService.priorStateDurationMs('network', 'ghost'), null, 'absent subject duration is null')
    assert.equal(await DatabaseService.priorTransitionTs('network', 'ghost'), null, 'absent subject prior ts is null')

    // -- priorStateDurationMs ----------------------------------------------
    let p = await DatabaseService.recordTransition({ domain: 'network', subject: 'solo', toState: 'online' })
    assert.equal(p.changed, true, 'first transition for solo recorded')
    assert.equal(await DatabaseService.priorStateDurationMs('network', 'solo'), null, 'single transition -> no prior state -> null')
    const q = await DatabaseService.recordTransition({ domain: 'network', subject: 'solo', toState: 'offline' })
    assert.equal(q.changed, true, 'second transition for solo recorded')
    assert.equal(
        await DatabaseService.priorStateDurationMs('network', 'solo'),
        q.ts - p.ts,
        'two transitions -> exact interval between them (prior-state duration)'
    )

    // -- priorTransitionTs ---------------------------------------------------
    assert.equal(
        await DatabaseService.priorTransitionTs('network', 'solo'),
        p.ts,
        'two transitions -> second-newest timestamp (the moment it left its prior state)'
    )

    // -- History filtering + ordering ------------------------------------
    const all = await DatabaseService.getTransitions()
    assert.ok(all.length >= 3, 'history contains multiple rows')
    assert.ok(typeof all[0].toState === 'string', 'rows expose a string toState')
    const htpcOnly = await DatabaseService.getTransitions({ domain: 'videoPlayer', subject: 'htpc' })
    assert.ok(htpcOnly.every((x) => x.subject === 'htpc'), 'subject filter only returns that subject')
    for (let i = 1; i < htpcOnly.length; i += 1) {
        assert.ok(htpcOnly[i - 1].ts >= htpcOnly[i].ts, 'history ordered newest-first')
    }

    // -- Close marks unavailable -----------------------------------------
    await DatabaseService.close()
    assert.equal(DatabaseService.isAvailable(), false, 'close() marks the store unavailable')
    assert.equal(await DatabaseService.getCurrent('videoPlayer', 'htpc'), null, 'reads fail open after close')
    r = await DatabaseService.recordTransition({ domain: 'network', subject: 'tv', toState: 'online' })
    assert.equal(r.changed, false, 'writes are no-ops when unavailable')
    assert.equal(await DatabaseService.priorStateDurationMs('network', 'solo'), null, 'duration reads fail open after close')
    assert.equal(await DatabaseService.priorTransitionTs('network', 'solo'), null, 'prior-ts reads fail open after close')

    if (failures > 0) throw new Error(`${failures} check(s) failed`)
}

main()
    .then(() => { console.log('\nAll DatabaseService tests passed.'); process.exit(0) })
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
