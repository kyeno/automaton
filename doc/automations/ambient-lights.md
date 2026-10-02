# Ambient Lights

The **Ambient lights** automation manages ambient lighting in two behaviors: during morning hours it turns off any leftover lights once natural light becomes sufficient; and a single **settled dusk** rule switches on socket-powered ambient lamps once it gets dark enough -- covering the `evening` and `night` windows in one rule. That same rule also answers Home Theater Mode's player-gone hand-off: a forced poke re-evaluates it without consuming its once-per-day budget, so a movie that ends past midnight still gets these lamps back while pre-dawn timer ticks never fire uninvited. Autonomous rules act **at most once per calendar day per time window** (`once: true`), so an early firing never blocks a later darkness window; within a given window they stand down after firing so humans keep full control.

## How It Works

1. On each timer tick (every 30 seconds), and whenever the illuminance sensor publishes a new reading via MQTT, the base class builds an evaluation context from the sensors listed under `sensors:` (here just one illuminance reading) plus the current time-of-day period.
2. Rules are evaluated against that context:
   - *Bright morning* fires in the `morning` period when illuminance ≥ 20 lx and commands **OFF** for every listed target — including wall switches driving main room lights, so nothing stays lit once daylight arrives.
   - *Settled dusk* fires in the `evening`/`night` periods once illuminance drops below the dusk threshold and commands **ON** only for the socket-powered lamps. It is the single owner of the dark-window restore: a home-theater player-gone hand-off pokes it with `force: true`, which re-evaluates the rule without consuming its once-per-day budget, so a movie that ends past midnight still gets these lamps back while pre-dawn timer ticks never fire uninvited.
3. Once commands are dispatched — or every targeted device was deferred due to recent human interaction — the rule consumes that window's slot by writing a marker to Redis (key `auto:<automation>:once:<rule-slug>` -- suffixed with the active period as `<...>:<period>`, because this rule declares a `time_of_day` condition, giving every listed window its own daily budget), storing the local calendar day, and stays quiet for the rest of that window. If nothing happened at all, later ticks keep retrying until conditions hold.

## Asymmetric Target Sets

Each rule carries its own per-target command map, so the ON and OFF sets can differ:

| Rule | Conditions | Devices commanded |
|------|------------|-------------------|
| Bright morning → `OFF` | `time_of_day: [morning]`, `illuminance: { gte: 20 }` | Every target in that rule (sockets and wall switches) |
| Settled dusk → `ON` | `time_of_day: [evening, night]`, `illuminance: { lt: <threshold> }` | Only the socket-powered lamps -- fires autonomously once per window, and also answers a home-theater player-gone hand-off (forced poke re-evaluates it without consuming the once budget) |

There is no top-level declaration section: each rule's `targets:` map addresses devices directly by their derived **target key** -- the registered friendly name trimmed with whitespace collapsed to underscores, casing preserved (`Kitchen Outlet` -> `Kitchen_Outlet`). Keys are validated against the live device container at startup: unknown keys or non-actuator resolutions warn and stay inert; an automation whose declared targets all fail validation fails fast instead of running silently inert. Simple automations may instead use a single flat `action:` field applied uniformly to every resolved device.

## Configuration File

Located at `etc/automation/ambient-lights.yaml` (template: `ambient-lights.yaml.dist`). Key fields:

```yaml
timer_interval: "30s"           # How often rules are evaluated ("90s", "3m 45s", "1h"...; legacy timer_interval_ms still works)

sensors:
  illuminance: 'Outdoor Luminance'    # Sensor feeding the evaluation context

triggers_zigbee:
  - 'Outdoor Luminance'               # Re-evaluate immediately on new sensor readings

rules:
  - name: 'Bright morning - turn off leftover lights'
    once: true                  # Act at most once per local calendar day
    conditions:
      time_of_day: [morning]
      illuminance: { gte: 20 }
    targets:                    # Per-target actions (key = registered device name, spaces -> _)
      Kitchen_Outlet: OFF
      ...
  - name: 'Settled dusk - turn on ambient lamps'
    once: true                  # One autonomous firing per window per calendar day; a forced poke re-evaluates without consuming the budget
    conditions:
      time_of_day: [evening, night]
      illuminance: { lt: 900 }
    targets:
      Kitchen_Outlet: ON
      ...
```

> **Tuning note:** The dusk threshold (`illuminance: { lt: 2000 }`) is a placeholder — observe your illuminance sensor's readings around sunset and adjust it so lamps come on when you'd normally flip the switch yourself.

Daily `once` markers, season conditions, and all other condition operators are documented in the [Configuration Guide](../configuration.md).

## File Map

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/ambientLightsAutomation.js` |
| Configuration template | `etc/automation/ambient-lights.yaml.dist` |
| Execution tests | `tests/test-ambient-lights-rules.js` |

---

→ Back to [Automations](./index.md) · Sibling example: [TTS Weather Man](./weatherman.md)