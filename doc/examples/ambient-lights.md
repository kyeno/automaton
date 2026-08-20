# Ambient Lights

The **Ambient lights** automation manages ambient lighting across two daily windows: during morning hours it turns off any leftover lights once natural light becomes sufficient, and when dusk settles it switches on socket-powered ambient lamps. Each rule acts **at most once per day** (`once: true`) — after firing, it stands down so humans have full control until the next window opens.

## How It Works

1. On each timer tick (every 30 seconds), and whenever the illuminance sensor publishes a new reading via MQTT, the base class builds an evaluation context from the sensors listed under `sensors:` (here just one illuminance reading) plus the current time-of-day period.
2. Rules are evaluated against that context:
   - *Bright morning* fires in the `morning` period when illuminance ≥ 20 lx and commands **OFF** for every listed target — including wall switches driving main room lights, so nothing stays lit once daylight arrives.
   - *Settled dusk* fires in the `evening` period once illuminance drops below the dusk threshold and commands **ON** only for the socket-powered lamps.
3. Once commands are dispatched — or every targeted device was deferred due to recent human interaction — the rule consumes its daily slot by writing a marker to Redis (`auto:<automation>:once:<rule-slug>`, storing the local calendar day) and stays quiet for the rest of that day. If nothing happened at all, later ticks keep retrying until conditions hold.

## Asymmetric Target Sets

Each rule carries its own per-target command map, so the ON and OFF sets can differ even though they share one target list:

| Rule | Conditions | Devices commanded |
|------|------------|-------------------|
| Bright morning → `OFF` | `time-of-day: [morning]`, `illuminance: { gte: 20 }` | Every listed target (sockets and wall switches) |
| Settled dusk → `ON` | `time-of-day: [evening]`, `illuminance: { lt: <threshold> }` | Only the socket-powered lamps |

The shared `targets:` section maps display names to short ids; each rule's `targets:` map references those ids with an action value. Simple automations may instead use a single flat `action:` field applied uniformly to every listed device.

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
      time-of-day: [morning]
      illuminance: { gte: 20 }
    targets:                    # Per-target actions for this rule
      kitchen_outlet: OFF
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

→ Back to [Example Automations](./index.md) · Sibling example: [TTS Weather Man](./weatherman.md)