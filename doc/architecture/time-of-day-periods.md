# Time-of-Day Periods

The rule engine's `time-of-day:` condition matches against five **fixed clock-based** day periods defined once in [`src/lib/date.js`](../../src/lib/date.js) (`DAY_PERIODS`). This page is the single source of truth for what those boundaries are, why they changed from sun-derived ones, how rules interact with them, and where production configs still carry assumptions from the old scheme.

## Current Partition

| Period    | Hours   | Clock range      |
|-----------|---------|------------------|
| night     | 00–04   | midnight → 04:59 |
| morning   | 05–10   | 05:00 → 10:59    |
| noon      | 11–12   | 11:00 → 12:59    |
| afternoon | 13–17   | 13:00 → 17:59    |
| evening   | 18–23   | 18:00 → 23:59    |

Properties that follow directly from this design:

- **Hour-granular.** Matching uses `Date.getHours()` only — every hour maps to exactly one period, no gaps or overlaps, and minute/second precision never matters.
- **Identical year-round.** No season dependence; a rule written in January behaves identically in July. This is deliberate (see below).
- **`evening` never starts before 18:00** and **`night` never begins until midnight**, regardless of when the sun actually sets.

The full lookup table can be obtained programmatically via `temporal.getHourToPeriodMap()` (a 24-entry array indexed by clock hour) — tooling such as [`src/lib/ruleCoverage.js`](../../src/lib/ruleCoverage.js) consumes it instead of re-declaring the boundaries.

## Why Fixed Clock Boundaries

Before commit `c1e8c6f`, periods were derived from average sunrise/sunset times for Central Europe (~52°N): daylight was split into four equal quarters (`morning`, `noon`, `afternoon`, `evening`) with evening extended two hours past sunset, and `night` spanning from there back to next sunrise. The same wall-clock hour therefore meant different things across months — e.g., 20:00 was *night* in winter but *evening* in summer, and "morning" began anywhere between 05:00 and 08:00 depending on the season.

That made rule behavior hard to reason about ("why did this fire at 7am in June but not January?") and pushed seasonal edge cases into every rule author's head. The fixed partition trades physical accuracy for predictability: rules are written against stable, memorable boundaries, and any desired sun-awareness can be expressed explicitly through sensor conditions (illuminance thresholds) rather than being smuggled in through period names.

## How Rules Use Periods

- **Matching.** [`conditionsMatch()`](../../src/automation/base/ruleBasedAutomationBase.js) checks membership of the current period name in the rule's scalar or array value. Absent condition = always passes; a present one that doesn't include the live period rejects the whole rule before any other condition is considered.
- **`once:` scoping.** A per-rule daily marker (`once: true`) is scoped per time window when the rule carries a `time-of-day:` condition — see [Configuration Guide → once](../configuration.md). In practice: a morning-only cleanup rule re-arms automatically after its window ends, while an all-day rule fires at most once until midnight.
- **Priority & overlap.** When several rules match simultaneously, higher `priority` wins (ties keep config order); the losing rules' targets are still merged under most-closed-wins semantics where applicable. `/automation debug <name>` shows each rule's condition summary so overlaps stay visible.

## History: What Changed in c1e8c6f

| Season group | Old scheme (sun-derived averages) | New fixed partition |
|--------------|-----------------------------------|---------------------|
| Winter (Dec–Feb) | sunrise ~07:30–08:00, sunset ~16:00–17:00 → *morning* 08–10/11, *evening* only ~15–17h, *night* from ~18h onward | morning 05–10, noon 11–12, afternoon 13–17, evening 18–23, night 00–04 |
| Mid (Mar/Apr/Sep/Oct) | sunrise ~06:00–07:00, sunset ~18:00–19:00 → boundaries shift with month | same as above |
| Summer (May–Jul) | sunrise ~05:00, sunset ~21:00 → *morning* 05–09, *evening* 18–22, *night* 23–04 | same as above |

Concrete behavioral shifts that matter for existing rules:

- **Winter dusk got closer to real sunset.** In January the old scheme put ~15:00 onward into `evening`; the first fixed partition pushed that back to 19:00, and the current table settles at 18:00 — still about an hour after actual sunset (~16:30). A "dusk ambience" rule keyed on `[evening]` therefore fires later than true dusk in winter, and if it also requires low illuminance it misses bright early-evening hours entirely (measured gap at h=15–17 vs legacy).
- **Pre-dawn is morning again.** Old June had 05:xx already in `morning`; the first fixed partition moved all of 00:00–05:59 into `night`, but the current table restored 05:00–05:59 to `morning`. Early-morning actions (e.g., roller open before work) regained their pre-06:00 window; only 00:00–04:59 remains deep night.
- **Late-afternoon boundary shifted earlier.** 18:00 was `afternoon` under the first fixed partition (and `evening`/`night` territory in old summer/winter math); today 13:00–17:59 is unambiguously `afternoon` and everything from 18:00 onward is `evening`. Warm-late rules that want dusk coverage must list both periods explicitly instead of relying on seasonal drift.
- **Night shrank in winter, grew in summer.** Winter night used to start around 18h; it now starts at midnight all year. Anything gated on `night` (deep-sky talk, late-night restores) moved accordingly.

## Impact Analysis on Production Configs

Running the static sweep (`/automation coverage <name> legacy`) against the shipped configs surfaces exactly these desyncs (numbers below measured with the current partition):

**AmbientLightsAutomation** (`etc/automation/ambient-lights.yaml`) — overall cell coverage 49.4%

- *Settled dusk* (`[evening]`, illuminance `< 900`) — reachable from **18:00**, resolving the "move evening to 6pm" TODO item; bright early-evening hours still get no ambient hand-off though, because h=15–17 was `evening` under the old January map and is now `afternoon` (measured gap vs legacy).
- *Bright morning cleanup* (`morning`, illuminance `>= 20`) — covers 05:00–10:59 (one hour wider than before); leftover-light handling between 11:00 and 17:59 depends solely on the bedroom-specific rule, which is the only one that fires there.
- *Late-night restore* (`forced_only`, `[night]`) — previously reachable during winter afternoons/evenings via delegated runs; now strictly 00:00–04:59.

**HomeOfficeRollersAutomation** (`etc/automation/home-office-rollers.yaml`) — overall cell coverage 71.4%, up from 69.5% under the previous partition

- Pre-dawn desync resolved: 05:xx is back in `morning`, so the presence/warmth rules match again at dawn — this used to be the classic "PC online but rollers stuck" window where only the darkness-gated night-close rule could fire.
- Remaining seasonal desync concentrates at h=15–17 in winter: those hours were `evening` under the old scheme (so evening-presence rules fired) and are now `afternoon`. Rules wanting them must list both periods explicitly.
- Largest remaining gap by design: bright pre-dawn scenarios (h=00–04 with illuminance above the night rule's threshold) match no rule at all.

## Rule Design Guidance

When writing or reviewing a `time-of-day:` condition:

1. **Check the table above first.** The period name is a clock label, not a sun phase. If you need "when it gets dark", pair the period with an illuminance bound instead of hoping for seasonal drift.
2. **List every period you mean.** A rule that should cover dusk-to-midnight needs `[evening, night]`; omitting one silently drops half the day.
3. **Mind the boundaries at 05/11/13/18 and midnight.** Rules anchored just inside a boundary (e.g., "from 18h") are stable now, but double-check anything historically tuned around 17–19h winter evenings.
4. **Use `/automation coverage <name>`** after any change to see hour-by-hour which rules can fire, where gaps remain, and who wins overlaps; append `legacy` to diff against the pre-c1e8c6f scheme when migrating older configs.
5. **Prefer explicit sensor bounds over period cleverness** — periods tell you *when*, sensors tell you *under what conditions*; mixing them implicitly was the old design's main failure mode.

## Tooling & File Map

| What | Where |
|------|-------|
| Period definitions + predicates (`isMorning()` … `getHourToPeriodMap()`) | [`src/lib/date.js`](../../src/lib/date.js) |
| Condition matching semantics (period membership, presence, video-player, ranges) | [`src/automation/base/ruleBasedAutomationBase.js`](../../src/automation/base/ruleBasedAutomationBase.js) |
| Static gap/overlap analyzer (pure module) | [`src/lib/ruleCoverage.js`](../../src/lib/ruleCoverage.js) |
| In-app command surface: `/automation coverage <name> [legacy]` | [`src/ui/commands/automationCmd.js`](../../src/ui/commands/automationCmd.js) |
| Analyzer tests (partition, legacy maps, evaluation, grid, report rendering) | [`tests/test-rule-coverage.js`](../../tests/test-rule-coverage.js) |
| Config reference for `time-of-day:` / `once:` scoping | [Configuration Guide](../configuration.md) |
| Command quick-reference entry | [UI Commands Reference](../ui/commands/index.md) |