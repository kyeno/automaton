# Bedroom Rollers

The **Bedroom Rollers** automation is a minimal rule-based roller-shutter controller for a bedroom: it closes every shutter at night once outdoor light drops below a threshold. It ships with an optional **pilot remote interaction** — a 3-button remote that moves the shutters via YAML targets while delegating outlet on/off decisions to a custom JavaScript handler that reads outdoor light first. Together they demonstrate both halves of the interaction system (declarative `targets:` actions *and* `calls:` delegation to custom JS logic).

## How It Works

1. On each timer tick and whenever the outdoor illuminance sensor publishes, the base class builds context from `sensors:` plus time-of-day.
2. The single shipped rule (*Night - close all*) matches in the evening/night period when illuminance falls below the dark threshold and commands `CLOSE` for every listed target. With "most-closed-wins" merging inherited from the base class, any rules you add later will always resolve to the most closed position per shutter.

## Configuration File

Located at `etc/automation/bedroom-rollers.yaml` (template: `bedroom-rollers.yaml.dist`). Key fields:

```yaml
targets:
  - name: 'Bedroom Roller Left'
    id: left
  - name: 'Bedroom Roller Right'
    id: right

sensors:
  illuminance: 'Outdoor Luminance'
  temperature: 'Outdoor Temperature'

triggers_zigbee:
  - 'Outdoor Luminance'
  - 'Outdoor Temperature'

timer_interval: "1m"

rules:
  - name: 'Night - close all'
    conditions:
      time-of-day: [evening, night]
      illuminance: { lt: 15 }
    targets:
      left: CLOSE
      right: CLOSE
```

> **Tuning note:** Raise/lower the `illuminance: { lt: 15 }` cutoff so shutters close when you'd normally pull them down yourself; add further rules (morning open, presence presets) using the same target ids.

## Pilot Remote Interaction

The companion interaction pairs a physical remote with the shutters *and* an outlet:

| Button | YAML action (`interaction.yaml`) | Delegated JS logic (`bedroomRollersInteraction.js`) |
|--------|----------------------------------|------------------------------------------------------|
| OPEN   | sends `OPEN` to every shutter via `targets:` | if outdoor light is bright → schedule the paired outlet **OFF** after a short delay |
| STOP   | sends `STOP` to every shutter | — (no outlet side-effect) |
| CLOSE  | sends `CLOSE` to every shutter via `targets:` | if it's dark outside → turn the paired outlet **ON** immediately |

The YAML entry uses `calls: 'bedroomRollersInteraction'` on the OPEN and CLOSE actions. The container resolves that string to the custom class by its filename slug and invokes its `execute()`, which reads the illuminance sensor and conditionally toggles the outlet(s). This keeps simple "move the shutter" commands declarative in YAML while housing the stateful, sensor-aware outlet decision in code.

Released as obfuscated templates so they work out of the box once you rename devices to your own:

- `etc/interaction/interaction.yaml.dist` — the `bedroom_pilot_remote` example entry
- `etc/interaction/bedroomRollersInteraction.js.dist` — the generic handler template

## File Map

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/bedroomRollersAutomation.js` |
| Configuration template | `etc/automation/bedroom-rollers.yaml.dist` |
| Interaction (active/local) | `etc/interaction/bedroomRollersInteraction.js` |
| Interaction template | `etc/interaction/bedroomRollersInteraction.js.dist` |
| Remote wiring (template) | `etc/interaction/interaction.yaml.dist` (`bedroom_pilot_remote`) |

---

→ Back to [Example Automations](./index.md) · Sibling example: [Home Office Rollers](./home-office-rollers.md)
