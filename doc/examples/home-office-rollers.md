# Home Office Rollers

The **Home Office Rollers** automation is a rule-based roller-shutter controller for a home office (or any room with blinds). On every timer tick — and immediately whenever an outdoor sensor publishes a new reading — it evaluates your rules against live illuminance, temperature, time-of-day and network-presence context, then merges *all* matching results per target using **"most-closed-wins"** logic so overlapping rules always resolve to the most closed position.

## How It Works

1. The base class builds an evaluation context from every entry under `sensors:` (here outdoor illuminance + temperature) plus the current time-of-day period. Presence conditions are resolved by querying the network-presence monitor for each host listed in `triggers_network`.
2. Every rule whose conditions match contributes its per-target command (`OPEN`, `CLOSE`, or a numeric position 0–100) into that target's candidate list.
3. For each target, candidates are merged with "lowest position wins": `CLOSE` → 0, `OPEN` → 100, numbers stay as-is; the minimum becomes the final command. A single strong `CLOSE` therefore overrides several weaker open/partial rules on the same shutter.
4. Commands are dispatched through the device container, skipping any target recently touched by a human (interaction cooldown), so you always keep manual control.

## Most-Closed-Wins Merging

Because many rules can be true at once ("warm & not bright → open" while someone is home parking shutters partway), they never fight — the automation simply picks the most closed outcome per shutter:

| Intent | Example condition set | Resulting merge |
|--------|-----------------------|-----------------|
| Keep shutters up when warm but dim | `time-of-day: [morning..evening]`, `illuminance < 11000`, `temperature < 25` | `OPEN` unless another matched rule is more closed |
| Park at a preset while someone is home | `presence: my-laptop`, `illuminance <= 11000` | e.g. left `40`, right `12` — overridden if a `CLOSE` rule also matches |
| Hard close at night / extreme heat | `illuminance <= 15`, or `temperature >= 29` in afternoon/noon | `CLOSE` wins for that target |

## Configuration File

Located at `etc/automation/home-office-rollers.yaml` (template: `home-office-rollers.yaml.dist`). Key fields:

```yaml
targets:                      # Display name -> short id used by rules
  - name: 'Home Office Roller Left'
    id: left
  - name: 'Home Office Roller Right'
    id: right

sensors:                      # Logical key -> Zigbee device feeding the context
  illuminance: 'Outdoor Luminance'
  temperature: 'Outdoor Temperature'

triggers_zigbee:              # Re-evaluate immediately on new readings from these devices
  - 'Outdoor Luminance'
  - 'Outdoor Temperature'

triggers_network:             # Hosts whose presence can gate rules (see networkPresence)
  - my-laptop
  - my-desktop

timer_interval: "1m"          # How often rules are evaluated when no trigger fires

rules:
  - name: 'Day: laptop present, not too bright'
    conditions:
      time-of-day: [morning, noon, afternoon]
      illuminance: { lte: 11000 }
      presence: my-laptop
    targets:                  # Per-target actions for this rule
      left: 40
      right: 12
```

> **Tuning note:** The illuminance thresholds (`11000`, `12700`) and position presets (`40`, `12`, …) are starting points. Watch your outdoor sensor's real readings through a day and adjust so shutters park where you'd set them by hand. Presence hostnames must match entries in `etc/device/network.yaml`.

Season conditions, all numeric operators, and the human-interaction cooldown are documented in the [Configuration Guide](../configuration.md).

## File Map

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/homeOfficeRollersAutomation.js` |
| Configuration template | `etc/automation/home-office-rollers.yaml.dist` |
| Base classes | `src/automation/base/ruleBasedAutomationBase.js` · `automationBase.js` |

---

→ Back to [Example Automations](./index.md) · Sibling example: [Bedroom Rollers](./bedroom-rollers.md)
