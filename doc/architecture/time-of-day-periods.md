# Time-of-Day Periods

`time_of_day` uses the same local clock periods all year:

| Period | Local time |
|--------|------------|
| `night` | 00:00–04:59 |
| `morning` | 05:00–10:59 |
| `noon` | 11:00–12:59 |
| `afternoon` | 13:00–17:59 |
| `evening` | 18:00–23:59 |

## How Rules Use Periods

A condition accepts one period or a list: `time_of_day: [afternoon, evening]`.
A missing condition imposes no period restriction.

`once: true` grants one action per local day per active period when a rule has a
`time_of_day` condition, including nested `any_of` / `all_of` groups. Without that
condition, the budget is one action per day.

All matching device rules contribute commands. Later rules override shared fields;
roller automations can use most-closed-wins merging. `priority` selects speech rules
in Weather Man and does not order device commands.

## Sun-Aware Gates On Top Of The Clock

Use explicit solar bounds for daylight schedules:

| Bound | Meaning |
|-------|---------|
| `sunrise` / `sundawn` | Civil dawn |
| `sunset` / `sundusk` | Actual sunset |
| `predusk` | Actual sunset minus 30 minutes |
| `after_latest_of: [sundusk, { hour: 19 }]` | Sunset or 19:00, whichever is later |
| `after_earliest_of: [sundawn, 'morning']` | Civil dawn or 05:00, whichever is earlier |

Solar times use `locale.geo_latitude` and `locale.geo_longitude`. Unresolvable solar
bounds fail closed. Clock bounds also accept `1230`, `'12:30'`, or `12.5` for 12:30.

## Rule Design Guidance

- Include both `afternoon` and `evening` for dusk rules that must work in winter and summer.
- Use solar and illuminance conditions for darkness; `night` starts at midnight.
- Express overnight hours as OR branches: `hour: { gte: 22, lt: 6 }` never matches.
- Check `/automation coverage <name>` for gaps and overlaps. Solar/history bounds are
  treated as satisfied by this static analysis; it does not predict actual solar timing.
- Append `legacy` to compare with the seasonal periods used before commit `c1e8c6f`.

## Tooling & File Map

| Component | Path |
|-----------|------|
| Period definitions and `getHourToPeriodMap()` | `src/lib/date.js` |
| Solar times | `src/lib/sun.js` |
| Condition matching | `src/automation/base/ruleBasedAutomationBase.js` |
| Static coverage | `src/lib/ruleCoverage.js` |
| Coverage command | `src/ui/commands/automationCmd.js` |
| Tests | `tests/test-rule-coverage.js`, `tests/test-sun-gate-condition.js` |

See [Configuration Guide](../configuration.md#day-periods-time_of_day) for syntax.
