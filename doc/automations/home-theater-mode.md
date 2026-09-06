# Home Theater Automation

The **Home Theater** automation watches a room's video player and stages the room for watching: while a player is open, the room's rollers are closed; when a video actually plays, interfering lights go off (dark mode); when playback pauses or stops, ambient lights come back. It is the flagship consumer of the [Video Player monitor](../monitors/video-player.md) and of the rule engine's [restore & ownership semantics](../architecture/rule-engine-restore-semantics.md).

It ships as **one reusable pattern with per-room deployments**: a shared base class (`homeTheaterBase.js`, exporting `HomeTheaterAutomation`) holds the behavior, and each room gets a thin wrapper instance bound to its own config file -- here `HomeOfficeVideoAutomation` (HTPC / Salon) and `BedroomVideoAutomation` (Sypialnia). Splitting by host keeps trigger subscriptions scoped: an instance only subscribes to `videoPlayer:<host>` / `network:<host>` topics for hosts listed in *its* triggers, so events from another room's player never fire it at all instead of running through the full rule set and matching nothing. Deploying several rooms inside ONE bundled instance also works if you prefer that shape -- the framework does not care which split you choose.

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
- Each instance opts into `override_human_interaction`, so it is "sticky" while active: manual changes to its targets are re-corrected on the next tick.

## Configuration Files

Each deployment instance reads its own YAML next to its wrapper class; active configs are gitignored and the tracked `.dist` templates ship with fresh clones:

| Instance | Class file | Config template |
|----------|-----------|-----------------|
| Home office (HTPC / Salon) | `etc/automation/homeOfficeVideoAutomation.js` | [`etc/automation/home-office-video.yaml.dist`](../../etc/automation/home-office-video.yaml.dist) |
| Bedroom (Sypialnia) | `etc/automation/bedroomVideoAutomation.js` | [`etc/automation/bedroom-video.yaml.dist`](../../etc/automation/bedroom-video.yaml.dist) |

Both require video players defined under `videoPlayers` in `etc/device/network.yaml` — see the [Video Player monitor](../monitors/video-player.md) for player-side setup (MPC-HC / VLC). The per-room shape looks like this (full examples in the linked templates):

```yaml
override_human_interaction: true   # sticky while active

targets:                      # Device names exactly as registered in your setup
  - 'Living Room Plug'
  - 'Living Room Roller Left'

triggers_video:               # THIS room's player hosts only (videoPlayers keys)
  - my-pc

triggers_network:             # THIS room's presence hosts only
  - my-pc

rules:
  # Rollers: owned while the player answers HTTP; handed back to their owner when it goes offline
  - name: 'Room: player reachable - close rollers'
    conditions:
      presence: { my-pc: true }
      video-player: { my-pc: [playing, paused, stopped] }
    targets:
      Living_Room_Roller_Left: CLOSE

  - name: 'Room: player gone - hand rollers back to their owner'
    conditions:
      presence: { my-pc: false }
      video-player: { my-pc: [unknown, unreachable] }
    invoke_automation: { name: HomeOfficeRollersAutomation, force: true }

  # Lights: playback drives them locally (dark mode); restore is delegated to ambient lights
  - name: 'Room: not playing - delegate light restore to ambient lights'
    conditions:
      video-player: { my-pc: [paused, stopped, unreachable, unknown] }
    invoke_automation: { name: AmbientLightsAutomation, force: true }

  - name: 'Room: playing - dark mode'
    conditions:
      presence: { my-pc: true }
      video-player: { my-pc: [playing] }
    targets:
      Living_Room_Plug: OFF
```

**Creating your own split:** copy one of the wrapper files (`homeOfficeVideoAutomation.js` / `bedroomVideoAutomation.js`), give it a distinct class + instance name and point its config path at a new YAML with *your* room's hosts, devices and rules. The container auto-discovers any `.js` under `etc/automation/` whose file name contains "Automation", so no registration step is needed -- and the execution test suite discovers every subclass of `HomeTheaterAutomation` on its own and validates each configured instance against its triggers. Keeping the shared base's file name free of "Automation" is what keeps it from being instantiated as a phantom third automation.

## File Map

| Component | Path |
|-----------|------|
| Shared base class | `etc/automation/homeTheaterBase.js` (class `HomeTheaterAutomation`) |
| Home office instance | `etc/automation/homeOfficeVideoAutomation.js` + `etc/automation/home-office-video.yaml.dist` |
| Bedroom instance | `etc/automation/bedroomVideoAutomation.js` + `etc/automation/bedroom-video.yaml.dist` |
| Status source | `src/monitor/videoPlayerMonitor.js` (see [Video Player monitor](../monitors/video-player.md)) |
| Execution tests | `tests/test-home-theater-rules.js` (elastic: both deployment shapes + discovery-driven consistency checks) |

---

→ Back to [Automations](./index.md) · Sibling: [Home Office Rollers](./home-office-rollers.md)