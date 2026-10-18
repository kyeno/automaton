# Ambient Lights

Turns off leftover lights after civil dawn and lights ambient lamps from `predusk`
(actual sunset minus 30 minutes), subject to illuminance thresholds.

## How It Works

| Rule | Conditions | Action |
|------|------------|--------|
| Bright morning | `morning`, at/after civil dawn, ≥20 lx | OFF for listed sockets and switches |
| Settled dusk | `afternoon` / `evening`, at/after `predusk`, <900 lx | ON for ambient sockets |
| Past midnight | `night` (00:00–04:59) | OFF for hallway cupboard lamp |
| Pre-dawn restore | Forced run, `night` / `morning`, before civil dawn, <900 lx | ON for listed ambient sockets |

These are template values; tune the thresholds for your sensor. Each `once: true` rule
has one budget per local day per time period. Forced runs neither check nor consume
those markers. Pre-dawn restore uses `forced_only: true` and runs only when forced,
such as a Home Theater delegation.

Evaluation runs on the configured timer, sensor reports, and presence events.
`trigger_on_change_only: true` can skip timer evaluations without a monitored
presence/player transition; crossing a clock bound alone does not wake that timer.
Playback suppression and human-interaction cooldowns also apply.

## Asymmetric Target Sets

Each rule has its own `targets` map. Keys use device friendly names with whitespace
replaced by underscores, preserving case: `Kitchen Outlet` → `Kitchen_Outlet`.
See [target validation](../configuration.md#target-keys-targets).

Keep presence-controlled room lights out of the unconditional pre-dawn restore.
Their own presence-gated rules are evaluated during the same forced run.

## The Cupboard Lamp: A Three-Rule Day

The cupboard lamp turns ON at dusk, OFF after midnight, and OFF again during morning
cleanup. It is excluded from pre-dawn restore. After a once-rule fires, manual changes
remain in place for the rest of that window.

Home Theater's dedicated cupboard restore runs only between sunset and midnight.
See [Restore & Ownership](../architecture/rule-engine-restore-semantics.md#carve-outs-when-a-restore-rule-must-not-restore-everything).

## Configuration File

Copy [ambient-lights.yaml.dist](../../etc/automation/ambient-lights.yaml.dist) to
`etc/automation/ambient-lights.yaml` and set your sensor, hosts, and targets.
The dusk rule has this form:

```yaml
- name: 'Settled dusk - turn on ambient lamps'
  once: true
  reassert_state: true
  conditions:
    time_of_day: [afternoon, evening]
    hour: { gte: predusk }
    illuminance: { lt: 900 }
  targets:
    Kitchen_Outlet: ON
    Hallway_Outlet: ON
    Hallway_Cupboard_Outlet: ON
```

## File Map

| Component | Path |
|-----------|------|
| Class | `etc/automation/ambientLightsAutomation.js` |
| Template | `etc/automation/ambient-lights.yaml.dist` |
| Tests | `tests/test-ambient-lights-rules.js` |

Related: [Automations](./index.md) · [Configuration](../configuration.md)
