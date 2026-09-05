# Home Theater Mode

The **Home Theater Mode** automation watches the room's video player and stages the room for watching: while a player is open, the room's rollers are closed; when a video actually plays, interfering lights go off (dark mode); when playback pauses or stops, ambient lights come back. It is the flagship consumer of the [Video Player monitor](../monitors/video-player.md) and of the rule engine's [restore & ownership semantics](../architecture/rule-engine-restore-semantics.md).

## Behavior

| Player state | Rollers | Lights |
|--------------|--------|--------|
| Reachable (playing, paused, or stopped) | **CLOSE** — the automation owns them | unchanged |
| `playing` | stays closed | **OFF** — dark mode |
| `paused` / `stopped` | stays closed | restore: "always on" ambient lights directly, the rest only if they were on before dark mode |
| `unknown` / `unreachable` | **hand back** — re-open only what this automation closed itself | restore, gated by `presence` |

Key design points:

- **Roller ownership is keyed to reachability, not playback.** A paused movie still means "someone is watching" — blinds stay down until the player disappears (machine off, player closed).
- **Hand-back never opens blinds it did not close.** Blinds found already closed are left alone; the automations that normally own them decide when they open.
- **Light rules keep `presence`.** A machine that is simply switched off must not restore anything — nobody is there.
- The automation opts into `override_human_interaction`, so it is "sticky" while active: manual changes to its targets are re-corrected on the next tick.

## Configuration File

Located at `etc/automation/home-theater-mode.yaml` (template: `home-theater-mode.yaml.dist`). Requires video players defined under `videoPlayers` in `etc/device/network.yaml` — see the [Video Player monitor](../monitors/video-player.md) for player-side setup (MPC-HC / VLC).

```yaml
override_human_interaction: true   # sticky while active
restore_state_aware: true           # restore only what this automation changed

targets:                      # Device names exactly as registered in your setup
  - 'Living Room Plug'
  # ...

triggers_video:                     # player hosts (videoPlayers keys)
  - my-pc
  - laptop

triggers_network:                   # presence hosts
  - my-pc
  - laptop

timer_interval: '30s'               # safety net if an event is missed

rules:
  # Rollers: owned while the player answers HTTP; handed back when gone
  - name: 'Living room: player reachable - close rollers'
    conditions:
      video-player: { my-pc: [playing, paused, stopped] }
    targets:
      Living_Room_Roller_Left: CLOSE

  - name: 'Living room: player gone - hand rollers back'
    conditions:
      video-player: { my-pc: [unknown, unreachable] }
    targets:
      Living_Room_Roller_Left: OPEN

  # Lights: playback drives them; presence gates restores
  - name: 'Living room: not playing - always-on ambient lights'
    conditions:
      presence: { my-pc: true }
      video-player: { my-pc: [paused, stopped, unreachable, unknown] }
    force_restore: true             # always comes back on pause
    targets:
      Living_Room_Plug: ON

  - name: 'Living room: playing - dark mode'
    conditions:
      presence: { my-pc: true }
      video-player: { my-pc: [playing] }
    targets:
      Living_Room_Plug: OFF
```

The `unknown` token, `force_restore`, and snapshot/restore mechanics are documented in [Rule Engine Restore & Ownership](../architecture/rule-engine-restore-semantics.md); condition syntax in the [Configuration Guide](../configuration.md).

## File Map

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/homeTheaterModeAutomation.js` |
| Configuration template | `etc/automation/home-theater-mode.yaml.dist` |
| Status source | `src/monitor/videoPlayerMonitor.js` (see [Video Player monitor](../monitors/video-player.md)) |
| Execution tests | `tests/test-home-theater-mode-rules.js` |

---

→ Back to [Automations](./index.md) · Sibling: [Home Office Rollers](./home-office-rollers.md)