# Ambient Lights

The **Ambient lights** automation manages ambient lighting in two behaviors: during morning hours it turns off any leftover lights once natural light becomes sufficient; and the **settled dusk** rule switches on socket-powered ambient lamps once it gets dark enough -- in the `evening`, or in the `afternoon` after civil dusk has passed (in winter dusk lands inside `afternoon`). The dark hours before civil dawn belong to a separate **pre-dawn restore** rule marked `forced_only`, which answers Home Theater Mode's player-gone hand-off and nothing else: a forced poke restores the lamps without consuming any budget, so a movie that ends past midnight still gets these lamps back while pre-dawn timer ticks never fire uninvited. Autonomous rules act **at most once per calendar day per time window** (`once: true`), so an early firing never blocks a later darkness window; within a given window they stand down after firing so humans keep full control.

## How It Works

1. On each timer tick (every 30 seconds), and whenever the illuminance sensor publishes a new reading via MQTT, the base class builds an evaluation context from the sensors listed under `sensors:` (here just one illuminance reading) plus the current time-of-day period.
2. Rules are evaluated against that context:
   - *Bright morning* fires in the `morning` period when illuminance ≥ 20 lx and commands **OFF** for every listed target — including wall switches driving main room lights, so nothing stays lit once daylight arrives.
   - *Settled dusk* fires when illuminance drops below the dusk threshold -- in the `evening`, or in the `afternoon` once civil dusk has passed (`hour: { gte: sunset }`) -- and commands **ON** only for the socket-powered lamps. Its two-window `any_of` declares one `time_of_day` gate per arm, and the `once:` budget splitter reads gates at any depth, so every window keeps its own daily slot; the sun gate on the afternoon arm is what keeps a gloomy mid-afternoon from lighting the lamps hours before dusk (the periods are fixed clock bands with no sun awareness).
   - *Pre-dawn restore* covers `night` plus the dark morning up to civil dawn (`hour: { lt: sunrise }`), and is `forced_only`: natural timer/sensor ticks skip it entirely, so a 00:26 presence blip in the middle of a session cannot blast the lamps. It fires only on a home-theater player-gone hand-off, which pokes this automation with `force: true`; forced runs neither check nor write markers, so repeated hand-offs keep working and consume nothing. It restores the socket lamps it owns and **nothing presence-owned**: a room light gated on presence (the salon ambient) is deliberately left out, because the same forced poke re-evaluates *that* rule too — so an occupant gets the room light back through its own rule at its own level, and an empty house at 03:00 stays dark. Listing a presence-owned target here would light a room nobody is in, and would win the first-match tie-break against the level its own rule chose.
3. Once commands are dispatched — or every targeted device was deferred due to recent human interaction — the rule consumes that window's slot by writing a marker to Redis (key `auto:<automation>:once:<rule-slug>` -- suffixed with the active period as `<...>:<period>`, because these rules declare a `time_of_day` condition, giving every window its own daily budget), storing the local calendar day, and stays quiet for the rest of that window. If nothing happened at all, later ticks keep retrying until conditions hold.

## Asymmetric Target Sets

Each rule carries its own per-target command map, so the ON and OFF sets can differ:

| Rule | Conditions | Devices commanded |
|------|------------|-------------------|
| Bright morning → `OFF` | `time_of_day: [morning]`, `illuminance: { gte: 20 }` | Every target in that rule (sockets and wall switches) |
| Settled dusk → `ON` | `illuminance: { lt: <threshold> }` + `any_of`: unguarded `[evening]` / `[afternoon]` + `hour: { gte: sunset }` | Only the socket-powered lamps -- fires autonomously once per window; the afternoon and evening slots are independent, and the afternoon arm waits for civil dusk |
| Pre-dawn restore → `ON` | `time_of_day: [night, morning]`, `hour: { lt: sunrise }`, `illuminance: { lt: <threshold> }`, `forced_only: true` | Only the socket-powered lamps -- invoke-only: answers a home-theater player-gone hand-off (forced poke, consumes no budget) and never fires on a natural tick. Presence-owned room lights are excluded on purpose; they come back via their own rule on the same poke |

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
    once: true                  # One autonomous firing per window per calendar day
    conditions:
      illuminance: { lt: 900 }
      any_of:                   # one time_of_day gate per arm -> one budget slot per window
        - time_of_day: [evening]
        - all_of:               # winter dusk lands inside `afternoon`; a gloomy mid-afternoon stays dark
            - time_of_day: [afternoon]
            - hour: { gte: sunset }
    targets:
      Kitchen_Outlet: ON
      ...
  - name: 'Pre-dawn restore - turn on ambient lamps'
    forced_only: true           # Invoke-only: answers a forced hand-off, never a natural tick
    conditions:
      time_of_day: [night, morning]
      hour: { lt: sunrise }     # midnight -> civil dawn (the "dark morning")
      illuminance: { lt: 900 }
    targets:
      Kitchen_Outlet: ON
      # Keep this to the lamps this automation owns. A light gated on `presence:` is restored
      # by its OWN rule on the same forced poke -- at its own level, and only if someone is in
      # the room. Do not list it here.
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