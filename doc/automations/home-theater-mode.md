# Home Theater Mode

The **Home Theater Mode** automation watches the room's video player and stages the room for watching: while a player is open, the room's rollers are closed; when a video actually plays, interfering lights go off (dark mode); when playback pauses or stops, ambient lights come back. It is the flagship consumer of the [Video Player monitor](../monitors/video-player.md) and of the rule engine's [restore & ownership semantics](../architecture/rule-engine-restore-semantics.md).

## Behavior

| Player state | Rollers | Lights |
|--------------|--------|--------|
| Reachable (playing, paused, or stopped) | **CLOSE** — the automation owns them | unchanged |
| `playing` | stays closed | **OFF** — dark mode |
| `paused` / `stopped` | stays closed | delegated to [Ambient Lights](./ambient-lights.md) via forced `invoke_automation` |
| `unknown` / `unreachable` | **handed back** to the room's roller owner via forced `invoke_automation` | delegated to [Ambient Lights](./ambient-lights.md), still gated by `presence` |

Key design points:

- **Roller ownership is keyed to reachability, not playback.** A paused movie still means "someone is watching" — blinds stay down until the player disappears (machine off, player closed).
- **Hand-back and light restore are delegated, not done locally.** When a player goes offline home-theater invokes the room's roller owner ([Home Office Rollers](./home-office-rollers.md) / [Bedroom Rollers](./bedroom-rollers.md)); whenever nothing is playing it delegates ambient-light decisions to [Ambient Lights](./ambient-lights.md) -- each owner applies its full rule set from its own perspective instead of home-theater guessing at positions or lamp states.
- **Delegated runs are forced but budget-neutral.** Each hand-off carries `force: true` so an owner acts even if a once/silent guard would otherwise block it, yet a forced run neither consumes nor refreshes any once-per-day marker; human-interaction cooldowns still apply.
- **Light rules keep `presence`.** A machine that is simply switched off must not trigger a restore -- nobody is there.
- The automation opts into `override_human_interaction`, so it is "sticky" while active: manual changes to its targets are re-corrected on the next tick.

## Configuration File

Located at `etc/automation/home-theater-mode.yaml` (template: `home-theater-mode.yaml.dist`). Requires video players defined under `videoPlayers` in `etc/device/network.yaml` — see the [Video Player monitor](../monitors/video-player.md) for player-side setup (MPC-HC / VLC).

```yaml
override_human_interaction: true   # sticky while active
restore_state_aware: true           # keeps dark-mode OFFs and roller CLOSEs idempotent across ticks

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
  # Rollers: owned while the player answers HTTP; handed back to their owner when it goes offline
  - name: 'Living room: player reachable - close rollers'
    conditions:
      video-player: { my-pc: [playing, paused, stopped] }
    targets:
      Living_Room_Roller_Left: CLOSE

  - name: 'Living room: player gone - hand rollers back to their owner'
    conditions:
      video-player: { my-pc: [unknown, unreachable] }
    invoke_automation: { name: HomeOfficeRollersAutomation, force: true }

  # Lights: playback drives them locally (dark mode); restore is delegated to ambient lights
  - name: 'Living room: not playing - delegate light restore to ambient lights'
    conditions:
      presence: { my-pc: true }
      video-player: { my-pc: [paused, stopped, unreachable, unknown] }
    invoke_automation: { name: AmbientLightsAutomation, force: true }

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