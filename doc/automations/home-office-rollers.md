# Home Office Rollers

Evaluates illuminance, temperature, time, and presence rules on timer/sensor events. For each shutter, the most closed matching position wins.

## How It Works

1. The base class builds an evaluation context from every entry under `sensors:` (here outdoor illuminance + temperature) plus the current time-of-day period. Presence conditions are resolved by querying the network-presence monitor for each host listed in `triggers_network`.
2. Every rule whose conditions match contributes its per-target command (`OPEN`, `CLOSE`, or a numeric position 0–100) into that target's candidate list.
3. For each target, candidates are merged with "lowest position wins": `CLOSE` → 0, `OPEN` → 100, numbers stay as-is; the minimum becomes the final command. A single strong `CLOSE` therefore overrides several weaker open/partial rules on the same shutter.
4. Commands are dispatched through the device container, skipping any target recently touched by a human (interaction cooldown), so you always keep manual control.

## Most-Closed-Wins Merging

Matching commands merge per shutter using the lowest position: CLOSE = 0, OPEN = 100.

| Intent | Example condition set | Resulting merge |
|--------|-----------------------|-----------------|
| Keep shutters up when warm but dim | `time_of_day: [morning..evening]`, `illuminance < 11000`, `temperature < 25` | `OPEN` unless another matched rule is more closed |
| Park at a preset while someone is home | `presence: laptop`, `200 <= illuminance <= 11000` | e.g. left shutter `40`, right shutter `12` — overridden if a `CLOSE` rule also matches |
| Hard close at night / extreme heat | `illuminance <= 15`, or `temperature >= 29` in afternoon/noon | `CLOSE` wins for that target |

## Configuration File

Located at `etc/automation/home-office-rollers.yaml` (template: `home-office-rollers.yaml.dist`). Key fields:

```yaml
sensors:                      # Logical key -> Zigbee device feeding the context
  illuminance: 'Outdoor Luminance'
  temperature: 'Outdoor Temperature'

triggers_zigbee:              # Re-evaluate immediately on new readings from these devices
  - 'Outdoor Luminance'
  - 'Outdoor Temperature'

triggers_network:             # Hosts whose presence can gate rules (see networkPresence)
  - laptop
  - my-pc

timer_interval: "1m"          # How often rules are evaluated when no trigger fires

video_player_suppression:      # Optional stand-down guard (see note below)
  my-pc: [playing, paused, stopped]

rules:
  - name: 'Day: laptop present, not too bright'
    conditions:
      time_of_day: [morning, noon, afternoon]
      hour: { gte: sunrise }
      illuminance: { gte: 200, lte: 11000 }
      presence: laptop
    targets:                  # Per-target actions for this rule (key = registered device name, spaces -> _)
      Home_Office_Roller_Left: 40
      Home_Office_Roller_Right: 12
```

**Target devices:** there is no separate declaration section -- each rule's `targets:` key addresses a device directly (registered friendly name with spaces -> underscores). Keys are validated against the live device container at startup; unknown or non-actuator resolutions warn and stay inert.

> **Tuning note:** The illuminance thresholds (`11000`, `12700`) and position presets (`40`, `12`, …) are starting points. Watch your outdoor sensor's real readings through a day and adjust so shutters park where you'd set them by hand. Presence hostnames must match entries in `etc/device/network.yaml`.

> **Stand-down guard:** While any player listed under `video_player_suppression` is in one of the listed statuses, the whole automation stands down -- e.g. so a home-theater automation can own the same shutters during a movie without the two fighting over them. Hosts combine with OR; individual rules may opt out via `ignore_video_player_suppression: true`. See [Video Player Suppression](../configuration.md) in the Configuration Guide.

Season conditions, all numeric operators, and the human-interaction cooldown are documented in the [Configuration Guide](../configuration.md).

## File Map

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/homeOfficeRollersAutomation.js` |
| Configuration template | `etc/automation/home-office-rollers.yaml.dist` |
| Base classes | `src/automation/base/ruleBasedAutomationBase.js` · `automationBase.js` |

---

→ Back to [Automations](./index.md) · Sibling example: [Bedroom Rollers](./bedroom-rollers.md)
