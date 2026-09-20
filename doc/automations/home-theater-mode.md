# Home Theater Automation

The **Home Theater** automation watches a room's video player and stages the room for watching: while a player is open, the room's rollers are closed; when a video actually plays, interfering lights go off (dark mode); when playback pauses or stops, ambient lights come back. It is the flagship consumer of the [Video Player monitor](../monitors/video-player.md) and of the rule engine's [restore & ownership semantics](../architecture/rule-engine-restore-semantics.md).

It ships as **one reusable pattern with per-room deployments**: a shared base class (`homeTheaterBase.js`, exporting `HomeTheaterAutomation`) holds the behavior, and each room gets a thin wrapper instance bound to its own config file -- here `HomeOfficeVideoAutomation` (HTPC / Salon) and `BedroomVideoAutomation` (Sypialnia). Splitting by host keeps trigger subscriptions scoped: an instance only subscribes to `videoPlayer:<host>` / `network:<host>` topics for hosts listed in *its* triggers, so events from another room's player never fire it at all instead of running through the full rule set and matching nothing. Deploying several rooms inside ONE bundled instance also works if you prefer that shape -- the framework does not care which split you choose.

## Behavior

| Player state | Rollers | Lights |
|--------------|--------|--------|
| Reachable (playing, paused, or stopped) | **CLOSE** — the automation owns them | unchanged |
| `playing` | stays closed | **OFF** — dark mode |
| `paused` / `stopped` | stays closed | HTPC instance: restored locally from its own time-of-day + illuminance rules (dimmer at 50%); Bedroom instance: delegated to [Ambient Lights](./ambient-lights.md) via forced `invoke_automation` |
| `unknown` / `unreachable` | **handed back** to the room's roller owner via forced `invoke_automation` | same local/delegated restore as above -- no `presence` gate on either side, so an offline machine also restores the lights |

> **Settling delay:** `playing` above is the monitor's *effective* status, which only becomes true once the same title has played continuously for the [playback-settle](../monitors/video-player.md#playback-settle) window (~60 s by default). So dark mode and light/suppression stand-down engage ~60 s into continuous viewing rather than the instant playback starts; rollers are unaffected because they track reachability, not playback. Browsing or skipping through titles therefore never dims the room or suppresses roller automations.

Key design points:

- **Roller ownership is keyed to reachability, not playback.** A paused movie still means "someone is watching" — blinds stay down until the player disappears (machine off, player closed).
- **Roller hand-back is always delegated; light restore depends on the instance.** When a player goes offline home-theater invokes the room's roller owner ([Home Office Rollers](./home-office-rollers.md) / [Bedroom Rollers](./bedroom-rollers.md)) so that owner decides the post-playback position from its full rule set. For lights, the HTPC/Salon instance restores its lamp set directly from its own rules -- gated by time-of-day (`afternoon`/`evening`/`night`) and outdoor illuminance (<900), with the salon dimmer returning at half brightness via a structured `{brightness: 50}` command; the Bedroom instance keeps delegating that decision to [Ambient Lights](./ambient-lights.md).
- **Delegated runs are forced but budget-neutral.** Each hand-off carries `force: true` so an owner acts even if a once/silent guard would otherwise block it, yet a forced run neither consumes nor refreshes any once-per-day marker; human-interaction cooldowns still apply.
- **Dark-mode OFF rules keep `presence`; restore does not.** Re-darkening an empty room serves no one, but pause/stop/gone all restore the lights even when the host itself is unreachable.
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

sensors:                    # illuminance source for the local restore gate
  illuminance: 'Outdoor Luminance'

triggers_zigbee:            # re-evaluate on sensor reports too (dusk transition mid-pause)
  - 'Outdoor Luminance'

timer_interval: "15m"       # safety net so condition changes are picked up without an event

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

  # Lights: playback drives them locally (dark mode); on pause/stop/gone this instance
  # restores its lamp set itself -- gated by time of day + outdoor illuminance like the old
  # delegation was. Dimmers take a structured percentage command instead of plain ON.
  - name: 'Room: not playing - restore ambient lighting'
    conditions:
      video-player: { my-pc: [paused, stopped, unreachable, unknown] }
      time-of-day: [afternoon, evening, night]
      illuminance: { lt: 900 }
    targets:
      Living_Room_Plug: ON
      Kitchen_Outlet: ON
      Salon_Dimmer: { brightness: 50 }

  - name: 'Room: playing - dark mode'
    conditions:
      presence: { my-pc: true }
      video-player: { my-pc: [playing] }
    targets:
      Living_Room_Plug: OFF
```

**Target devices:** there is no separate declaration section -- each rule's `targets:` key addresses a device directly by its derived target key (registered friendly name with spaces replaced by underscores, casing kept). Keys are validated against the live device container at startup: unknown or non-actuator resolutions warn and stay inert; an automation whose declared targets all fail validation fails fast instead of running silently inert. Target values may also be **structured object commands passed through verbatim** -- e.g., `Salon_Dimmer: { brightness: 50 }`, where the DualDimmer maps the percentage into its per-channel level range at publish time; scalar forms (`ON`/`OFF`, `OPEN`/`CLOSE`, position integers) keep their existing mappings.

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