/**
 * Rule coverage analyzer tests.
 * Behavioral coverage for src/lib/ruleCoverage.js -- the pure engine behind
 * "/automation coverage <name>" -- plus integration of the new subcommand through a stubbed
 * AutomationCmd context (usage listing, name resolution, gap/legacy-diff rendering).
 *
 * Covers:
 *   A) currentHourToPeriod() -- exact fixed partition (night 00-04, morning 05-10, noon 11-12,
 *      afternoon 13-17, evening 18-23), single period per hour
 *   B) legacyHourToPeriod()/buildLegacyHourMap() -- pre-c1e8c6f sun-derived boundaries reproduce
 *      documented spot values and keep all 24 hours covered for every month; changedHours()
 *      reports exactly the shifted hours
 *   C) evaluateRule()/matchesNumericRange()/normalizers -- boundary semantics mirror the base
 *      class: null never satisfies bounds, presence string/array/object forms, video-player
 *      unknown opt-in, season pass-through, extra keys ignored
 *   D) buildScenarios() -- sample points straddle every declared bound, presence subsets are
 *      enumerated fully, grid truncation cap is honored and flagged
 *   E) analyzeRules()/pickWinner() -- gaps detected on uncovered periods, priority decides the
 *      overlap winner even when listed later, summary math stays consistent
 *   F) /automation coverage subcommand -- usage text, missing/unknown name paths, trailing
 *      "legacy" modifier parsing, report sections (rules list with flags, timeline, GAPS,
 *      legacy diff rows) rendered through the stub context
 *
 * Pure module + command harness only -- no Redis/MQTT/AI providers needed.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

import * as cov from '../src/lib/ruleCoverage.js'
import AutomationCmd from '../src/ui/commands/automationCmd.js'

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

function assertTrue(condition, label) {
    assertEqual(Boolean(condition), true, label)
}

// ---------------------------------------------------------------------------
// A. Current fixed partition
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 A. currentHourToPeriod() \u2500\u2500\n')
{
    const map = cov.currentHourToPeriod()
    assertEqual(map.length, 24, 'map has one entry per clock hour')
    const expected = [
        'night', 'night', 'night', 'night', 'night',
        'morning', 'morning', 'morning', 'morning', 'morning', 'morning',
        'noon', 'noon',
        'afternoon', 'afternoon', 'afternoon', 'afternoon', 'afternoon',
        'evening', 'evening', 'evening', 'evening', 'evening', 'evening',
    ]
    assertEqual(JSON.stringify(map), JSON.stringify(expected), 'exact fixed boundaries (c1e8c6f DAY_PERIODS)')
    const names = new Set(map)
    assertEqual(names.size, 5, 'all five periods appear exactly as a full partition')
}

// ---------------------------------------------------------------------------
// B. Legacy sun-derived maps + changedHours
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 B. legacy period maps \u2500\u2500\n')
{
    // Spot values from the documented pre-c1e8c6f scheme (sunrise/sunset averages).
    assertEqual(cov.legacyHourToPeriod(19, 0), 'night', 'January h=19 was night (sunset 16h + 2h extension)')
    assertEqual(cov.legacyHourToPeriod(7, 0), 'night', 'January h=7 was still night (sunrise 8h, night wraps to 7h)')
    assertEqual(cov.legacyHourToPeriod(5, 5), 'morning', 'June h=5 was morning (sunrise 5h)')
    assertEqual(cov.legacyHourToPeriod(23, 5), 'night', 'June h=23 was night (sunset 21h + 2h)')
    assertEqual(cov.legacyHourToPeriod(18, 5), 'evening', 'June h=18 was evening')

    // Every month must still partition all 24 hours into valid periods.
    let ok = true
    const valid = new Set(['morning', 'noon', 'afternoon', 'evening', 'night'])
    for (let m = 0; m < 12; m++) {
        const leg = cov.buildLegacyHourMap(m)
        if (leg.length !== 24 || !leg.every((p) => valid.has(p))) ok = false
    }
    assertTrue(ok, 'all 12 legacy month maps cover every hour with a valid period')

    // changedHours() flags exactly the shifted hours between current and January-legacy.
    const cur = cov.currentHourToPeriod()
    const jan = cov.buildLegacyHourMap(0)
    const diffs = cov.changedHours(cur, jan).map((d) => `${d.hour}:${d.from}>${d.to}`)
    assertTrue(diffs.includes('5:night>morning'), 'Jan h=5 night->morning reported as changed')
    assertTrue(diffs.includes('6:night>morning'), 'Jan h=6 night->morning reported as changed')
    assertTrue(diffs.includes('18:night>evening'), 'Jan h=18 night->evening reported as changed')
    assertTrue(diffs.includes('19:night>evening'), 'Jan h=19 night->evening reported as changed')
    assertTrue(!diffs.some((d) => d.startsWith('9:')), 'unchanged hours are not listed')
    assertTrue(!diffs.some((d) => d.startsWith('13:')), 'h=13 now aligns with the legacy afternoon band, so no diff is reported there')
}

// ---------------------------------------------------------------------------
// C. Condition evaluation semantics (mirrors RuleBasedAutomationBase)
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 C. condition evaluation \u2500\u2500\n')
{
    // Numeric bounds -- null/undefined never satisfy; equality follows lt/lte/gt/gte exactly.
    assertEqual(cov.matchesNumericRange(null, { gte: 400 }), false, 'null fails a bound check')
    assertEqual(cov.matchesNumericRange(undefined, { lt: 900 }), false, 'undefined fails a bound check')
    assertEqual(cov.matchesNumericRange(400, { gte: 400 }), true, 'gte is inclusive at the bound')
    assertEqual(cov.matchesNumericRange(899.99, { lte: 900 }), true, 'lte holds below the bound')
    assertEqual(cov.matchesNumericRange(900, { lt: 900 }), false, 'lt is exclusive at the bound')
    assertEqual(cov.matchesNumericRange(10, {}), true, 'empty constraint object matches anything non-null')

    // time-of-day membership with scalar and array forms.
    const ctx = { timeOfDay: 'evening', presence: {}, videoPlayer: {} }
    assertTrue(cov.evaluateRule({ 'time-of-day': 'evening' }, ctx), 'scalar period matches itself')
    assertTrue(cov.evaluateRule({ 'time-of-day': ['night', 'evening'] }, ctx), 'array form includes current period')
    assertEqual(cov.evaluateRule({ 'time-of-day': 'morning' }, ctx), false, 'non-matching period rejects')

    // Presence -- string/array/object normalization; absent host counts as offline.
    const pctx = { timeOfDay: 'noon', presence: { kyeno: true }, videoPlayer: {} }
    assertTrue(cov.evaluateRule({ presence: 'kyeno' }, pctx), 'string presence matches online host')
    assertTrue(cov.evaluateRule({ presence: ['kyeno', 'meerkat'] }, { ...pctx, presence: { kyeno: true, meerkat: true } }), 'array presence requires all listed hosts online')
    assertEqual(cov.evaluateRule({ presence: ['kyeno', 'meerkat'] }, pctx), false, 'array presence fails when one host is offline')
    assertTrue(cov.evaluateRule({ presence: { kyeno: false } }, { ...pctx, presence: {} }), 'object form can require a host to be OFFLINE')
    assertEqual(
        JSON.stringify(cov.normalizePresenceCondition('a')),
        JSON.stringify({ a: true }),
        'normalizer maps bare name to expected-online flag'
    )

    // Video-player -- no recorded state only satisfies explicit `unknown` opt-in lists.
    const vctx = { timeOfDay: 'night', presence: {}, videoPlayer: {} }
    assertTrue(cov.evaluateRule({ 'video-player': { tv: ['unreachable', 'unknown'] } }, vctx), 'no-state baseline matches unknown-opt-in list')
    assertEqual(cov.evaluateRule({ 'video-player': { tv: ['playing'] } }, vctx), false, 'no-state baseline does not match concrete statuses')
    assertTrue(cov.evaluateRule({ 'video-player': { tv: 'paused' } }, { ...vctx, videoPlayer: { tv: 'paused' } }), 'scalar status matches when recorded')
    assertEqual(cov.evaluateRule({ 'video-player': { tv: 'paused' } }, { ...vctx, videoPlayer: { tv: 'playing' } }), false, 'recorded mismatch rejects')

    // Season pass-through and extra-key tolerance.
    assertTrue(cov.evaluateRule({ season: 'winter' }, ctx), 'season condition passes when analysis pins none')
    assertEqual(cov.evaluateRule({ season: 'summer' }, { ...ctx, season: 'winter' }), false, 'pinned season mismatch rejects')
    assertTrue(cov.evaluateRule({ someUnknownKey: 42 }, ctx), 'non-object extra keys are ignored like at runtime')
}

// ---------------------------------------------------------------------------
// D. Scenario grid construction
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 D. buildScenarios() \u2500\u2500\n')
{
    const rules = [
        { name: 'bright', conditions: { illuminance: { gte: 400 } } },
        { name: 'dim', conditions: { illuminance: { lt: 900 } } },
        { name: 'home', conditions: { presence: ['kyeno'] } },
        { name: 'away', conditions: { presence: { meerkat: false } } },
    ]
    const built = cov.buildScenarios(rules)
    const pts = built.meta.pointsBySensor['illuminance']
    assertTrue(pts.some((v) => v < 400), 'sample points include values below the lowest bound')
    assertTrue(pts.includes(400), 'bound value itself is sampled (inclusive edge tested)')
    assertTrue(pts.some((v) => v >= 900), 'sample points extend beyond the highest bound')
    assertEqual(built.meta.presenceHosts.length, 2, 'both referenced presence hosts are collected')
    // Two hosts -> all four subsets enumerated (baseline + singles + pair).
    assertEqual(built.scenarios.length, pts.length * 4, 'scenario count equals sensor points x presence subsets')
    const labels = built.scenarios.map((s) => s.label)
    assertTrue(labels.some((l) => l.endsWith('presence=-')), 'all-off baseline scenario present')
    assertTrue(labels.some((l) => l.endsWith('presence=kyeno+meerkat')), 'both-online combination present')

    // Truncation cap: many independent sensors would explode the grid; it must stop and flag.
    const bigRules = []
    for (let i = 1; i <= 10; i++) bigRules.push({ name: `r${i}`, conditions: { [`sensor${i}`]: { gte: i * 100 } } })
    const big = cov.buildScenarios(bigRules)
    assertEqual(big.scenarios.length, 512, 'grid is capped at the documented maximum')
    assertEqual(big.meta.truncated, true, 'truncation is flagged in meta when the cap engages')
}

// ---------------------------------------------------------------------------
// E. analyzeRules() + pickWinner()
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 E. analyzeRules()/pickWinner() \u2500\u2500\n')
{
    const cur = cov.currentHourToPeriod()
    // Morning-only rule -> every non-morning hour must be a full gap; morning hours covered.
    const rules = [{ name: 'Morning only', conditions: { 'time-of-day': 'morning' } }]
    const rep = cov.analyzeRules({ rules, periodMap: cur })
    for (const h of [5, 6, 8, 10]) {
        assertTrue(rep.hours[h].fullyCovered, `hour ${h} (morning) fully covered`)
    }
    for (const h of [0, 11, 14, 20]) {
        assertEqual(rep.hours[h].gapCount, rep.hours[h].totalScenarios, `hour ${h} outside its period is a total gap`)
    }
    assertEqual(
        rep.summary.gapCells,
        rep.summary.totalCells - rep.summary.coveredCells,
        'summary gap math is consistent'
    )

    // Priority decides the overlap winner even when the higher-priority rule is listed later.
    const prioRules = [
        { name: 'Low first', conditions: {} },
        { name: 'High second', conditions: {}, priority: 5 },
    ]
    const winner = cov.pickWinner([
        { rule: prioRules[0], index: 0 },
        { rule: prioRules[1], index: 1 },
    ])
    assertEqual(winner.name, 'High second', 'higher priority wins regardless of config order')
    const tie = cov.pickWinner([
        { rule: prioRules[0], index: 0 },
        { rule: { name: 'Tie later', conditions: {} }, index: 1 },
    ])
    assertEqual(tie.name, 'Low first', 'equal priorities keep config order (first wins)')

    const prioRep = cov.analyzeRules({ rules: prioRules, periodMap: cur })
    assertTrue(prioRep.overlaps.count > 0, 'cells with two matching rules are counted as overlaps')
    assertEqual(
        prioRep.overlaps.examples[0]?.winnerName,
        'High second',
        'overlap example reports the priority winner'
    )

    // Legacy diff sanity on an ambient-style fixture: dusk rule written for old evening semantics.
    const duskRules = [
        { name: 'Dusk on', conditions: { 'time-of-day': ['evening', 'night'], illuminance: { lt: 900 } } },
        { name: 'Bright off', conditions: { 'time-of-day': 'morning', illuminance: { gte: 400 } } },
    ]
    const built = cov.buildScenarios(duskRules)
    const nowSet = cov.matchedNamesByHour(cov.analyzeRules({ rules: duskRules, periodMap: cur, scenarios: built.scenarios }))
    const janSet = cov.matchedNamesByHour(cov.analyzeRules({ rules: duskRules, periodMap: cov.buildLegacyHourMap(0), scenarios: built.scenarios }))
    // January h=15 was evening (dusk could fire); today it is afternoon and only "Bright off" territory remains.
    assertTrue(janSet.get(15).has('Dusk on'), 'legacy Jan h=15 matched the dusk rule')
    assertEqual(nowSet.get(15).has('Dusk on'), false, 'current h=15 no longer matches the dusk rule')
}

// ---------------------------------------------------------------------------
// F. /automation coverage subcommand integration
// ---------------------------------------------------------------------------
console.log('\n\u2500\u2500 F. /automation coverage command \u2500\u2500\n')
{
    class FakeRuleBasedAutomation {
        constructor(name, config = {}) {
            this.name = name
            this._initialized = true
            this.config = config
        }
        getTriggerTopics() { return [] }
        getTimerIntervalMs() { return 45_000 }
        async execute(triggerData) { void triggerData }
    }

    const covConfig = {
        rules: [
            { name: 'Morning off', conditions: { 'time-of-day': 'morning', illuminance: { gte: 400 } }, once: true },
            { name: 'Dusk on', conditions: { 'time-of-day': ['evening', 'night'], illuminance: { lt: 900 } } },
        ],
    }
    const flaggedConfig = {
        rules: [{ name: 'Invoke only', conditions: { 'time-of-day': 'noon' }, forced_only: true, priority: 3 }],
    }
    const noRules = new FakeRuleBasedAutomation('EmptyAuto', {})
    const ambient = new FakeRuleBasedAutomation('AmbientLightsAutomation', covConfig)
    const flagged = new FakeRuleBasedAutomation('FlaggedAutomation', flaggedConfig)

    function makeContainer(automations) {
        const map = new Map(automations.map((a) => [a.name, a]))
        return { getAll: () => map, getAutomation: (name) => map.get(name) ?? null, getNames: () => [...map.keys()].sort() }
    }
    function createHarness(container) {
        const printed = []
        const ctx = { print: (text) => printed.push(String(text)) }
        if (container) ctx.automationContainer = container
        return { cmd: new AutomationCmd(ctx), printed }
    }

    // Usage help lists the new subcommand alongside the existing ones.
    const usage = createHarness(makeContainer([ambient]))
    await usage.cmd.execute('')
    assertTrue(usage.printed[0].includes('coverage <name>'), 'usage lists "coverage" subcommand')
    assertTrue(usage.printed[0].includes('legacy'), 'usage documents the legacy modifier')

    // Missing name -> hint; unknown name -> error + available list.
    let h = createHarness(makeContainer([ambient]))
    await h.cmd.execute('coverage')
    assertEqual(h.printed[0], 'Missing automation name', 'missing coverage name yields hint')
    h = createHarness(makeContainer([ambient]))
    await h.cmd.execute('coverage NopeAutomation')
    assertEqual(h.printed[0], 'Unknown automation "NopeAutomation"', 'unknown coverage target reports the name')

    // No rules -> graceful notice instead of a report.
    h = createHarness(makeContainer([noRules]))
    await h.cmd.execute('coverage EmptyAuto')
    assertTrue(h.printed[0].includes('defines no rules to analyze'), 'rule-less automation gets a clear notice')

    // Full report: header, flagged rule index, timeline with gap markers, GAPS section.
    h = createHarness(makeContainer([ambient, flagged]))
    await h.cmd.execute('coverage AmbientLightsAutomation')
    const out = h.printed.join('\n')
    assertTrue(out.startsWith('Coverage analysis: AmbientLightsAutomation'), 'report opens with the analyzed automation')
    assertTrue(out.includes('"Morning off" [once/day]'), 'once-per-day flag rendered on its rule line')
    assertTrue(out.includes('timeline (union of rules able to fire at each hour; G k/N = gap in k scenarios):'), 'timeline header present')
    assertTrue(/G \d+\/\d+/.test(out), 'gap counts annotated on affected hours')
    assertTrue(out.includes('GAPS -- '), 'unmatched cells are listed under GAPS')
    assertTrue(out.includes('h=00 (night)'), 'an uncovered night cell appears in the gap list')
    assertTrue(out.includes('% of cells covered'), 'final coverage percentage printed')

    // Flag rendering for invoke-only + priority rules.
    h = createHarness(makeContainer([flagged]))
    await h.cmd.execute('coverage FlaggedAutomation')
    assertTrue(h.printed[0].includes('[invoke-only] [p=3]'), 'forced_only and priority flags render together')

    // Trailing "legacy" modifier is stripped from the name and triggers the diff section.
    h = createHarness(makeContainer([ambient]))
    await h.cmd.execute('coverage AmbientLightsAutomation legacy')
    const legOut = h.printed.join('\n')
    assertTrue(legOut.includes('-- Legacy diff vs pre-c1e8c6f sun-derived periods --'), 'legacy diff section rendered when requested')
    assertTrue(legOut.includes('January (winter worst case):'), 'January representative month analyzed')
    assertTrue(legOut.includes('June (summer):'), 'June representative month analyzed')
    assertTrue(/lost: .*gained: /.test(legOut), 'shifted hours report lost/gained rule sets')

    // Bare "legacy" with no name resolves as a missing-name error, not an unknown automation.
    h = createHarness(makeContainer([ambient]))
    await h.cmd.execute('coverage legacy')
    assertEqual(h.printed[0], 'Missing automation name', '"legacy" alone is treated as the modifier, leaving no name')

    // Tab completion offers coverage first-class and the trailing modifier after a name token.
    const cmd = new AutomationCmd({ print() {}, automationContainer: makeContainer([ambient]) })
    assertTrue(cmd.completeNextToken([]).includes('coverage'), 'first-token candidates include coverage')
    assertEqual(JSON.stringify(cmd.completeNextToken(['coverage'])), JSON.stringify(['AmbientLightsAutomation']), 'name position completes from registry')
    assertEqual(JSON.stringify(cmd.completeNextToken(['coverage', 'AmbientLightsAutomation'])), JSON.stringify(['legacy']), 'post-name position offers the legacy modifier')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = passed + failed
console.log(`\n${'\u2550'.repeat(50)}`)
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`)
console.log(`${'\u2550'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)