# Home Theater Automation

Closes a room's rollers while its player is reachable, switches lights off during
playback, and restores or delegates lighting when playback stops.

## Behavior

| Player status | Rollers | Lights |
|---------------|---------|--------|
| Reachable: playing, paused, or stopped | CLOSE | Follow playback rules |
| `playing` | Stay closed | OFF |
| `paused` / `stopped` after playing | Stay closed | Office restores locally; bedroom delegates to Ambient Lights |
| `offline` | Delegate to room's roller owner | Delegate to Ambient Lights |

`playing` is the monitor's effective status after the default 60-second
[playback-settle](../monitors/video-player.md#playback-settle) window.

Office restore rules require darkness and the overnight window: sunset to midnight OR
midnight to civil dawn. Dimmers need both state and levels,
e.g. `{ state: 'ON', brightness: { l1: 50, l2: 25 } }`.
The hallway cupboard lamp has a separate restore rule limited to sunset–midnight.

Restore rules use `state_transition: { 'videoPlayer:<host>': { from: playing } }`.
An `offline → stopped` startup therefore does not trigger a light restore.
The separate `offline` delegation rule has no origin gate.

Other settings:

- `override_human_interaction: true` makes this automation reapply its targets while active.
- `trigger_on_change_only: true` skips timer ticks without a monitored player/presence change.
- Illuminance is context only; sensor reports do not trigger this automation.
- Forced delegations bypass silence and daily markers without consuming those markers.
  The delegated owner's human cooldown and video suppression still apply.

See [Restore & Ownership](../architecture/rule-engine-restore-semantics.md) for shared behavior.

## Configuration Files

| Instance | Wrapper | Template |
|----------|---------|----------|
| Office | `homeOfficeVideoAutomation.js` | [home-office-video.yaml.dist](../../etc/automation/home-office-video.yaml.dist) |
| Bedroom | `bedroomVideoAutomation.js` | [bedroom-video.yaml.dist](../../etc/automation/bedroom-video.yaml.dist) |

Files live under `etc/automation/`. Define players in `etc/device/network.yaml`
under `videoPlayers`; see [player setup](../monitors/video-player.md#player-side-setup).
Each wrapper reads its own YAML and subscribes to its declared hosts.

A local restore rule:

```yaml
- name: 'Room: paused/stopped - restore ambient lighting'
  reassert_state: true
  conditions:
    video_player: { my-pc: [paused, stopped] }
    state_transition: { 'videoPlayer:my-pc': { from: playing } }
    illuminance: { lt: 900 }
    any_of:
      - hour: { gte: sunset }
      - hour: { lt: sunrise }
  targets:
    Living_Room_Plug: ON
    Living_Room_Dimmer: { state: 'ON', brightness: { l1: 50, l2: 25 } }
```

An offline delegation rule:

```yaml
- name: 'Room: player gone - hand back to owners'
  conditions:
    video_player: { my-pc: [offline] }
  invoke_automation:
    - { name: HomeOfficeRollersAutomation, force: true }
    - { name: AmbientLightsAutomation, force: true }
```

To add a room, copy a wrapper, give it a unique class/instance name and YAML path,
and configure that room's hosts and devices. The autoloader discovers `.js` files
containing `Automation`; the shared `homeTheaterBase.js` is not instantiated directly.

## File Map

| Component | Path |
|-----------|------|
| Shared class | `etc/automation/homeTheaterBase.js` |
| Status monitor | `src/monitor/videoPlayerMonitor.js` |
| Tests | `tests/test-home-theater-rules.js` |

Related: [Automations](./index.md) · [Target syntax](../configuration.md#target-keys-targets)
