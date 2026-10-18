# Bedroom Rollers

Closes bedroom shutters in low light during evening/night. An optional pilot-remote interaction adds full travel, 20% steps, and sensor-based outlet control.

## How It Works

1. On each timer tick and whenever the outdoor illuminance sensor publishes, the base class builds context from `sensors:` plus time-of-day.
2. The single shipped rule (*Night - close all*) matches in the evening/night period when illuminance falls below the dark threshold and commands `CLOSE` for every target in that rule. With "most-closed-wins" merging inherited from the base class, any rules you add later will always resolve to the most closed position per shutter.

## Configuration File

Located at `etc/automation/bedroom-rollers.yaml` (template: `bedroom-rollers.yaml.dist`). Key fields:

```yaml
sensors:
  illuminance: 'Outdoor Luminance'
  temperature: 'Outdoor Temperature'

triggers_zigbee:
  - 'Outdoor Luminance'
  - 'Outdoor Temperature'

timer_interval: "1m"

video_player_suppression:      # Optional stand-down guard (see note below)
  my-pc: [playing, paused, stopped]

rules:
  - name: 'Night - close all'
    conditions:
      time_of_day: [evening, night]
      illuminance: { lt: 15 }
    targets:                    # Key = registered device name with spaces replaced by underscores
      Bedroom_Roller_Left: CLOSE
      Bedroom_Roller_Right: CLOSE
```

**Target devices:** there is no separate declaration section -- each rule's `targets:` key addresses a device directly (registered friendly name with spaces -> underscores). Keys are validated against the live device container at startup; unknown or non-actuator resolutions warn and stay inert.

> **Tuning note:** Raise/lower the `illuminance: { lt: 15 }` cutoff so shutters close when you'd normally pull them down yourself; add further rules (morning open, presence presets) using the same target keys.

> **Stand-down guard:** While any player listed under `video_player_suppression` is in one of the listed statuses, the whole automation stands down -- e.g. so a home-theater automation can own the same shutters during a movie without the two fighting over them. Hosts combine with OR; individual rules may opt out via `ignore_video_player_suppression: true`. See [Video Player Suppression](../configuration.md) in the Configuration Guide.

## Pilot Remote Interaction

The companion interaction pairs a physical remote with the shutters *and* an outlet:

| Button | Action | Behavior |
|--------|--------|----------|
| Open   | `1_single` | runs every shutter fully **open**; if outdoor light is bright, schedules the paired outlet **OFF** after a short delay |
| Open +  | `1_double` | steps every shutter **20% further open** from its current position (no outlet side effect) |
| Stop   | `2_single` | sends `STOP` to every shutter - no position logic, so it stays declarative |
| Pause  | `2_double` | toggles both bedroom ambient outlets together (declarative) |
| Close  | `3_single` | runs every shutter fully **closed**; if it's dark outside, turns the paired outlet **ON** immediately |
| Close + | `3_double` | steps every shutter **20% further closed** from its current position (no outlet side effect) |

### End-Stop Feedback

When every shutter is within ±2% of the requested end stop, the interaction double-beeps and sends no command.

If any shutter can move, the group receives the command; device-level no-op suppression drops redundant targets.

### How the Split Works

`RollerShuttersBase` reads positions and handles travel. Delegate travel actions through `calls`; YAML `targets` run first and cannot be cancelled by the handler. STOP can remain a direct target action.

A concrete room only fixes its identity and its shutter list:

```javascript
export default class SalonRollersInteraction extends RollerShuttersBase {
    constructor() {
        super({ name: 'SalonRollersInteraction', shutters: SALON_SHUTTERS })
    }
}
```

Side effects attach through the `onOpened()` / `onClosed()` hooks, which fire only on a real full travel - never on a 20% nudge and never on a beep-gated press (nothing moved in either case).

Copy these templates and set your device names:

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

→ Back to [Automations](./index.md) · Sibling example: [Home Office Rollers](./home-office-rollers.md)
