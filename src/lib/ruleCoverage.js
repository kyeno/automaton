/**
 * Rule Coverage Analyzer.
 *
 * Statically sweeps a rule-based automation's YAML rules across every hour of the day and a
 * derived grid of sensor/presence/video-player scenarios to find timing gaps (hours where no
 * rule can match), overlaps (several rules matching at once) and which rule wins by priority --
 * without touching live devices, MQTT or Redis. It mirrors the condition semantics of
 * {@link ../automation/base/ruleBasedAutomationBase.js conditionsMatch()} for every statically
 * evaluable condition type: time-of-day period membership, actual wall-clock hour bounds (`hour:`), season, numeric range bounds
 * (`lt`/`lte`/`gt`/`gte`) on arbitrary sensor keys, network presence maps, and video-player
 * status lists including the explicit-`unknown` opt-in. Conditions that require live state
 * (`state-changed-ago-minutes`) are treated as satisfied and noted in the report meta.
 *
 * The hour-to-period mapping is injected per analysis so callers can evaluate against the
 * current fixed partition ({@link lib/date getHourToPeriodMap()}) or against an alternative
 * map -- e.g., {@link legacyHourToPeriod}, which reproduces the pre-c1e8c6f sun-derived
 * boundaries from Central-Europe sunrise/sunset averages. Diffing the two directly shows how
 * each hour's behavior shifted when day periods became clock-based.
 *
 * Pure data in / pure data out: no services, no I/O, deterministic given its inputs. Used by
 * the `/automation coverage <name>` UI command; see doc/architecture/time-of-day-periods.md
 * for what the results mean when designing rules.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

import temporal from './date.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Condition keys handled specially before the generic numeric-range loop (mirrors conditionsMatch()). */
const RESERVED_CONDITION_KEYS = new Set([
    'time-of-day',
    'hour',
    'season',
    'presence',
    'video-player',
    'state-changed-ago-minutes',
])

/** Sentinel status meaning "no recorded player state" -- matches only lists containing `unknown`. */
const VIDEO_PLAYER_UNKNOWN = 'unknown'

/** Average sunrise/sunset hours per month for Central Europe (~52degN), as used pre-c1e8c6f. Indexed by zero-based month. */
const LEGACY_SUN_TIMES = [
    [8, 16],   // January
    [7, 17],   // February
    [6, 18],   // March
    [6, 19],   // April
    [5, 21],   // May
    [5, 21],   // June
    [5, 21],   // July
    [5, 20],   // August
    [6, 19],   // September
    [7, 17],   // October
    [7, 16],   // November
    [8, 16],   // December
]

/** Hours evening was extended past sunset before night began (pre-c1e8c6f twilight allowance). */
const LEGACY_EVENING_EXTENSION_HOURS = 2

/** Hard cap on sample points generated per sensor dimension to keep scenario grids bounded. */
const MAX_POINTS_PER_SENSOR = 8

/** Hard cap on total scenarios per analysis; beyond it the grid is truncated and flagged in meta. */
const MAX_SCENARIOS = 512

// ---------------------------------------------------------------------------
// Period maps (current + legacy)
// ---------------------------------------------------------------------------

/**
 * Hour-to-period lookup for the current fixed partition ({@link lib/date DAY_PERIODS}).
 * Delegates to {@link lib/date getHourToPeriodMap()} so the table stays defined in exactly one place.
 * @returns {Array<string>} 24-element array; index = hour (0-23), value = period name.
 */
export function currentHourToPeriod() {
    return temporal.getHourToPeriodMap()
}

/**
 * Derive which of the five day periods a clock hour fell into under the pre-c1e8c6f
 * sun-derived scheme: daylight split into four equal quarters, evening extended two hours
 * past sunset, night spanning until next sunrise -- using Central-Europe monthly averages.
 * Kept here solely for before/after diffing of rule behavior after the switch to fixed zones.
 *
 * @param {number} hour - Clock hour (0-23).
 * @param {number} monthIndex - Zero-based month (0=January .. 11=December); wraps modulo 12.
 * @returns {'morning'|'noon'|'afternoon'|'evening'|'night'} The legacy period active at that hour.
 */
export function legacyHourToPeriod(hour, monthIndex) {
    const [sunrise, sunset] = LEGACY_SUN_TIMES[((monthIndex % 12) + 12) % 12]
    const q = (sunset - sunrise) / 4
    const nightStart = (sunset + LEGACY_EVENING_EXTENSION_HOURS) % 24
    const morningEnd = Math.round(sunrise + q)
    const noonEnd = Math.round(sunrise + 2 * q)
    const afternoonEnd = Math.round(sunrise + 3 * q)

    const ranges = {
        morning:   [sunrise, morningEnd],
        noon:      [morningEnd + 1, noonEnd],
        afternoon: [noonEnd + 1, afternoonEnd],
        evening:   [afternoonEnd + 1, nightStart - 1],
        // Wraps midnight; handled by the wrap-aware range check below.
        night:     [nightStart, sunrise - 1],
    }
    for (const [name, [from, to]] of Object.entries(ranges)) {
        if (from <= to ? hour >= from && hour <= to : hour >= from || hour <= to) return name
    }
    return 'night' // unreachable -- the five ranges always partition all 24 hours
}

/**
 * Build a full 24-entry legacy period map for one month, mirroring {@link currentHourToPeriod}'s shape.
 * @param {number} monthIndex - Zero-based month (0=January .. 11=December).
 * @returns {Array<string>} 24-element array; index = hour (0-23), value = legacy period name.
 */
export function buildLegacyHourMap(monthIndex) {
    return Array.from({ length: 24 }, (_, h) => legacyHourToPeriod(h, monthIndex))
}

/**
 * List the clock hours whose period assignment differs between two maps.
 * @param {Array<string>} currentMap - Current hour-to-period mapping (24 entries).
 * @param {Array<string>} otherMap - Mapping to compare against (e.g., a legacy month map).
 * @returns {Array<{hour: number, from: string, to: string}>} Changed hours in ascending order.
 */
export function changedHours(currentMap, otherMap) {
    const out = []
    for (let h = 0; h < 24; h++) {
        if (currentMap[h] !== otherMap[h]) {
            out.push({ hour: h, from: otherMap[h], to: currentMap[h] })
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// Condition evaluation (mirrors RuleBasedAutomationBase.conditionsMatch semantics)
// ---------------------------------------------------------------------------

/**
 * Check a value against lt/lte/gt/gte bounds exactly like the base class' #matchesNumericRange():
 * null/undefined never satisfies any bound; absent operators impose no constraint.
 * @param {number|null|undefined} value - Sensor reading under test.
 * @param {{lt?: number, lte?: number, gt?: number, gte?: number}} constraints - Bound object from YAML.
 * @returns {boolean} True when every present bound holds.
 */
export function matchesNumericRange(value, constraints) {
    if (value === null || value === undefined) return false
    if (constraints.lt !== undefined && !(value < constraints.lt)) return false
    if (constraints.lte !== undefined && !(value <= constraints.lte)) return false
    if (constraints.gt !== undefined && !(value > constraints.gt)) return false
    if (constraints.gte !== undefined && !(value >= constraints.gte)) return false
    return true
}

/**
 * Normalize a presence condition to `{ host: boolean }` pairs, mirroring the base class'
 * #normalizePresenceCondition() -- string means "online", array means all listed online,
 * objects pass through with explicit per-host expectations.
 * @param {string|string[]|Record<string, boolean>} presence - Raw condition value from YAML.
 * @returns {Record<string, boolean>} Host name to expected-online flag.
 */
export function normalizePresenceCondition(presence) {
    if (typeof presence === 'string') return { [presence]: true }
    if (Array.isArray(presence)) {
        const result = {}
        for (const name of presence) result[name] = true
        return result
    }
    return presence ?? {}
}

/**
 * Normalize a video-player condition to `{ host: string[] }`, mirroring #normalizeVideoPlayerCondition().
 * @param {Record<string, string|string[]>} videoPlayer - Raw condition value from YAML.
 * @returns {Record<string, string[]>} Host name to accepted status list.
 */
export function normalizeVideoPlayerCondition(videoPlayer) {
    const result = {}
    for (const [host, statuses] of Object.entries(videoPlayer ?? {})) {
        result[host] = Array.isArray(statuses) ? [...statuses] : [statuses]
    }
    return result
}

/**
 * Evaluate one rule's conditions against a static context snapshot. Supports every statically
 * evaluable condition type; `season` is satisfied when the context carries no season (callers
 * that do not sweep seasons), and unknown extra keys without object bounds pass through -- both
 * matching how conditionsMatch() treats them at runtime.
 *
 * @param {Record<string, unknown>|null|undefined} conditions - Conditions object from a YAML rule.
 * @param {{timeOfDay?: string|null, hour?: number|null, season? string|null, presence?: Record<string, boolean>, videoPlayer?: Record<string, string|undefined>}} ctx - Static context: period name, swept clock hour for the hour condition, optional season, per-host online flags, per-host player status (absent key = no recorded state).
 * @param {Record<string, number|null>} [sensorValues={}] - Sensor readings keyed by logical sensor name.
 * @returns {boolean} True when every present condition holds.
 */
export function evaluateRule(conditions, ctx, sensorValues = {}) {
    if (!conditions || typeof conditions !== 'object') return true

    // time-of-day check
    if (conditions['time-of-day']) {
        const periods = Array.isArray(conditions['time-of-day']) ? conditions['time-of-day'] : [conditions['time-of-day']]
        if (!periods.includes(ctx.timeOfDay)) return false
    }

    // season check -- satisfied when the analysis does not pin a season
    if (conditions.season && ctx.season != null) {
        const seasons = Array.isArray(conditions.season) ? conditions.season : [conditions.season]
        if (!seasons.includes(ctx.season)) return false
    }

    // Actual wall-clock hour check -- mirrors conditionsMatch(); analyzeRules() injects the swept hour
    // as ctx.hour. Absent clock context means a declared bound cannot be satisfied.
    if (conditions.hour !== undefined) {
        const constraint = conditions.hour
        if (typeof constraint === 'number') {
            if (!Number.isInteger(ctx.hour) || Math.trunc(constraint) !== ctx.hour) return false
        } else if (constraint && typeof constraint === 'object' && !Array.isArray(constraint)) {
            if (!matchesNumericRange(ctx.hour ?? null, constraint)) return false
        } else {
            return false
        }
    }
    // presence check -- hosts absent from the scenario count as offline (mirrors networkPresence.isOnline())
    if (conditions.presence !== undefined) {
        for (const [host, shouldBeOnline] of Object.entries(normalizePresenceCondition(conditions.presence))) {
            const isOnline = ctx.presence ? Boolean(ctx.presence[host]) : false
            if (isOnline !== shouldBeOnline) return false
        }
    }

    // video player status check -- no recorded state matches only explicit `unknown` opt-ins
    if (conditions['video-player'] !== undefined) {
        for (const [host, statuses] of Object.entries(normalizeVideoPlayerCondition(conditions['video-player']))) {
            const status = ctx.videoPlayer?.[host]
            if (!status) return statuses.includes(VIDEO_PLAYER_UNKNOWN)
            if (!statuses.includes(status)) return false
        }
    }

    // Dynamic: any remaining object-valued condition key -> numeric range check against sensor values.
    for (const [key, constraint] of Object.entries(conditions)) {
        if (RESERVED_CONDITION_KEYS.has(key)) continue
        if (constraint && typeof constraint === 'object') {
            if (!matchesNumericRange(sensorValues[key], constraint)) return false
        }
    }

    return true
}

// ---------------------------------------------------------------------------
// Scenario grid construction
// ---------------------------------------------------------------------------

/**
 * Collect the logical sensor keys that appear as bounded numeric conditions across all rules.
 * @param {Array<Record<string, unknown>>} rules - Rules from an automation config.
 * @returns {string[]} Sorted unique sensor key names.
 */
export function collectSensorKeys(rules) {
    const keys = new Set()
    for (const rule of rules ?? []) {
        for (const [key, value] of Object.entries(rule.conditions ?? {})) {
            if (RESERVED_CONDITION_KEYS.has(key)) continue
            if (value && typeof value === 'object' && !Array.isArray(value)) keys.add(key)
        }
    }
    return [...keys].sort()
}

/**
 * Derive deterministic sample points around every bound a rule declares for one sensor: each
 * bound itself, midpoints between adjacent bounds, zero when all bounds are positive, and a
 * point beyond the highest bound -- guaranteeing both sides of every threshold get tested.
 * @param {number[]} bounds - All finite bound values declared for this sensor across the rules.
 * @returns {number[]} Ascending unique sample values (capped at MAX_POINTS_PER_SENSOR).
 */
function samplePoints(bounds) {
    const vals = [...new Set(bounds.filter((v) => Number.isFinite(v)))].sort((a, b) => a - b)
    if (vals.length === 0) return [0]
    const pts = new Set(vals)
    for (let i = 1; i < vals.length; i++) {
        pts.add(Number(((vals[i - 1] + vals[i]) / 2).toFixed(2)))
    }
    if (vals[0] > 0) pts.add(0)
    const maxV = vals[vals.length - 1]
    pts.add(Number((maxV + Math.max(1, maxV * 0.5)).toFixed(2)))

    let out = [...pts].sort((a, b) => a - b)
    if (out.length > MAX_POINTS_PER_SENSOR) {
        // Keep first/last and spread evenly so extreme bands stay represented.
        const step = Math.ceil(out.length / MAX_POINTS_PER_SENSOR)
        out = out.filter((_, i) => i % step === 0 || i === out.length - 1)
    }
    return out
}

/**
 * Expand per-host video-player option lists into every combination as `{ host: status|undefined }` maps.
 * @param {Array<Array<string|undefined>>} optionsPerHost - Allowed statuses (plus undefined baseline) per host, in host order.
 * @param {string[]} hosts - Host names aligned with optionsPerHost.
 * @returns {Array<Record<string, string|undefined>>} One map per combination; a single empty map when no hosts exist.
 */
function expandVp(optionsPerHost, hosts) {
    let combos = [{}]
    for (let i = 0; i < hosts.length; i++) {
        const next = []
        for (const combo of combos) {
            for (const status of optionsPerHost[i]) next.push({ ...combo, [hosts[i]]: status })
        }
        combos = next
    }
    return combos
}

/**
 * Render the compact human label used in gap/overlap listings for one scenario.
 * @param {Record<string, number>} sensors - Sensor key to sampled value.
 * @param {Record<string, boolean>} presenceMap - Host to online flag.
 * @param {string[]} allPresenceHosts - Every known presence host (to render explicit offline states).
 * @param {Record<string, string|undefined>} vpMap - Host to player status.
 * @param {string[]} allVpHosts - Every known video-player host.
 * @returns {string} e.g. "illuminance=300 temperature=20 presence=-" or "... presence=kyeno".
 */
function scenarioLabel(sensors, presenceMap, allPresenceHosts, vpMap, allVpHosts) {
    const parts = Object.entries(sensors).map(([k, v]) => `${k}=${v}`)
    if (allPresenceHosts.length > 0) {
        const online = allPresenceHosts.filter((h) => presenceMap[h] === true)
        parts.push(`presence=${online.length > 0 ? online.join('+') : '-'}`)
    }
    if (allVpHosts.length > 0) {
        for (const h of allVpHosts) parts.push(`${h}:${vpMap[h] ?? 'none'}`)
    }
    return parts.join(' ')
}

/**
 * Build the full scenario grid for an analysis: every combination of sampled sensor values,
 * presence on/off states (all subsets when three hosts or fewer), and video-player statuses
 * observed in the rules plus a no-state baseline. Deterministic ordering keeps reports stable.
 *
 * @param {Array<Record<string, unknown>>} rules - Rules from an automation config.
 * @returns {{scenarios: Array<{label: string, context: object, sensors: Record<string, number>}>, meta: {sensorKeys: string[], pointsBySensor: Record<string, number[]>, presenceHosts: string[], videoPlayerHosts: string[], truncated: boolean}}} Scenario list plus construction metadata.
 */
export function buildScenarios(rules) {
    const ruleList = Array.isArray(rules) ? rules : []

    // Sensor dimensions -- bounds collected per key across all rules.
    const sensorKeys = collectSensorKeys(ruleList)
    const pointsBySensor = {}
    for (const key of sensorKeys) {
        const bounds = []
        for (const rule of ruleList) {
            const constraint = rule.conditions?.[key]
            if (constraint && typeof constraint === 'object' && !Array.isArray(constraint)) {
                for (const v of Object.values(constraint)) if (typeof v === 'number') bounds.push(v)
            }
        }
        pointsBySensor[key] = samplePoints(bounds)
    }

    // Presence dimension -- every host any rule references; subsets when small enough to enumerate fully.
    const presenceHostSet = new Set()
    for (const rule of ruleList) {
        if (rule.conditions?.presence !== undefined) {
            for (const host of Object.keys(normalizePresenceCondition(rule.conditions.presence))) presenceHostSet.add(host)
        }
    }
    const hosts = [...presenceHostSet].sort()
    let presenceCombos
    if (hosts.length <= 3) {
        presenceCombos = []
        for (let mask = 0; mask < 1 << hosts.length; mask++) {
            const map = {}
            hosts.forEach((h, i) => { map[h] = Boolean(mask & (1 << i)) })
            presenceCombos.push(map)
        }
    } else {
        presenceCombos = [{}]
        for (const h of hosts) {
            const one = {}
            one[h] = true
            presenceCombos.push(one)
        }
    }

    // Video-player dimension -- statuses the rules themselves list per host, plus a no-state baseline.
    const vpStatusesByHost = {}
    for (const rule of ruleList) {
        const cond = rule.conditions?.['video-player']
        if (!cond || typeof cond !== 'object') continue
        for (const [host, raw] of Object.entries(cond)) {
            const list = Array.isArray(raw) ? raw : [raw]
            vpStatusesByHost[host] = [...new Set([...(vpStatusesByHost[host] ?? []), ...list])]
        }
    }
    const vpHosts = Object.keys(vpStatusesByHost).sort()
    let optionsPerHost = vpHosts.map((h) => [...vpStatusesByHost[h].slice(0, 4), undefined])
    if (expandVp(optionsPerHost, vpHosts).length > 8 && vpHosts.length > 0) {
        optionsPerHost = vpHosts.map(() => [undefined])
    }
    const vpMaps = expandVp(optionsPerHost, vpHosts)

    // Assemble the cartesian product in a stable order.
    let sensorCombos = [[]]
    for (const key of sensorKeys) {
        const next = []
        for (const combo of sensorCombos) {
            for (const v of pointsBySensor[key]) next.push([...combo, [key, v]])
        }
        sensorCombos = next
    }

    const scenarios = []
    let truncated = false
    outer:
    for (const sensors of sensorCombos) {
        for (const presenceMap of presenceCombos) {
            for (const vpMap of vpMaps) {
                if (scenarios.length >= MAX_SCENARIOS) { truncated = true; break outer }
                const context = { ...Object.fromEntries(sensors), presence: presenceMap, videoPlayer: vpMap }
                scenarios.push({
                    label: scenarioLabel(Object.fromEntries(sensors), presenceMap, hosts, vpMap, vpHosts),
                    context,
                    sensors: Object.fromEntries(sensors),
                })
            }
        }
    }

    return {
        scenarios,
        meta: { sensorKeys, pointsBySensor, presenceHosts: hosts, videoPlayerHosts: vpHosts, truncated },
    }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Pick the winning rule among matches by priority (higher wins; ties keep config order),
 * mirroring how execute() resolves competing rules at runtime.
 * @param {Array<{rule: object, index: number}>} matches - Matching rules with their original positions.
 * @returns {{name: string, priority: number}} Winner's display name and effective priority.
 */
export function pickWinner(matches) {
    const sorted = [...matches].sort((a, b) => {
        const pa = typeof a.rule.priority === 'number' ? a.rule.priority : 0
        const pb = typeof b.rule.priority === 'number' ? b.rule.priority : 0
        return pb !== pa ? pb - pa : a.index - b.index
    })
    const top = sorted[0]
    return { name: String(top?.rule.name ?? '(unnamed)'), priority: typeof top?.rule.priority === 'number' ? top.rule.priority : 0 }
}

/**
 * Run the full sweep: every hour x every scenario through evaluateRule(), collecting per-hour
 * coverage, gap cells, overlap examples and an overall summary. Pure -- same inputs always yield
 * the same report.
 *
 * @param {{rules?: Array<Record<string, unknown>>, periodMap: Array<string>, scenarios: Array<{label: string, context: object, sensors: Record<string, number>}}, season?: string|null, maxGapCells?: number, maxOverlapExamples?: number}} options - Rules to analyze, the 24-entry hour-to-period mapping in force (current or legacy), prebuilt scenario grid, optional pinned season, output caps.
 * @returns {{meta: object, hours: Array<object>, gaps: Array<object>, overlaps: {count: number, examples: Array<object>}, summary: object}} Structured report ready for rendering.
 */
export function analyzeRules(options) {
    const rules = Array.isArray(options.rules) ? options.rules : []
    const periodMap = options.periodMap
    const scenarios = Array.isArray(options.scenarios) ? options.scenarios : buildScenarios(rules).scenarios
    const maxGapCells = options.maxGapCells ?? 500
    const maxOverlapExamples = options.maxOverlapExamples ?? 6

    const hours = []
    const gaps = []
    let overlapCount = 0
    const overlapExamples = []
    let totalCells = 0
    let gapCells = 0

    for (let h = 0; h < 24; h++) {
        const period = periodMap[h]
        let covered = 0
        const matchedNames = new Set()
        for (const scenario of scenarios) {
            totalCells++
            // Inject this hour's period so the same scenario grid works under any period map (current or legacy).
            const evalCtx = { ...scenario.context, timeOfDay: period, hour: h }
            const matches = []
            rules.forEach((rule, index) => {
                if (evaluateRule(rule.conditions, evalCtx, scenario.sensors)) matches.push({ rule, index })
            })
            if (matches.length === 0) {
                gapCells++
                if (gaps.length < maxGapCells) gaps.push({ hour: h, period, label: scenario.label })
                continue
            }
            covered++
            for (const m of matches) matchedNames.add(String(m.rule.name ?? '(unnamed)'))
            if (matches.length > 1) {
                overlapCount++
                if (overlapExamples.length < maxOverlapExamples) {
                    const winner = pickWinner(matches)
                    overlapExamples.push({
                        hour: h,
                        period,
                        label: scenario.label,
                        names: [...matchedNames],
                        winnerName: winner.name,
                    })
                }
            }
        }
        hours.push({
            hour: h,
            period,
            totalScenarios: scenarios.length,
            coveredScenarios: covered,
            gapCount: scenarios.length - covered,
            fullyCovered: covered === scenarios.length && scenarios.length > 0,
            matchedRules: [...matchedNames].sort(),
        })
    }

    return {
        meta: {
            ruleCount: rules.length,
            scenarioCount: scenarios.length,
            season: options.season ?? null,
            note: 'state-changed-ago-minutes conditions are treated as satisfied in static analysis',
        },
        hours,
        gaps,
        overlaps: { count: overlapCount, examples: overlapExamples },
        summary: {
            totalCells,
            coveredCells: totalCells - gapCells,
            gapCells,
            overlapCells: overlapCount,
            coveragePct: totalCells > 0 ? Number(((100 * (totalCells - gapCells)) / totalCells).toFixed(2)) : 100,
        },
    }
}

/**
 * Reduce a report to the per-hour union of matching rule names for set-diffing against another map's report.
 * @param {{hours?: Array<{hour: number, matchedRules: string[]}>}} report - Report from analyzeRules().
 * @returns {Map<number, Set<string>>} Hour to set of rule names that can fire there.
 */
export function matchedNamesByHour(report) {
    const out = new Map()
    for (const entry of report.hours ?? []) out.set(entry.hour, new Set(entry.matchedRules))
    return out
}