# Home Theater Automation

The **Home Theater** automation watches a room's video player and stages the room for watching: while a player is open, the room's rollers are closed; when a video actually plays, interfering lights go off (dark mode); when playback pauses or stops, ambient lights come back. It is the flagship consumer of the [Video Player monitor](../monitors/video-player.md) and of the rule engine's [restore & ownership semantics](../architecture/rule-engine-restore-semantics.md).

It ships as **one reusable pattern with per-room deployments**: a shared base class (`homeTheaterBase.js`, exporting `HomeTheaterAutomation`) holds the behavior, and each room gets a thin wrapper instance bound to its own config file -- here `HomeOfficeVideoAutomation` (HTPC / Salon) and `BedroomVideoAutomation` (Sypialnia). Splitting by host keeps trigger subscriptions scoped: an instance only subscribes to `videoPlayer:<host>` / `network:<host>` topics for hosts listed in *its* triggers, so events from another room's player never fire it at all instead of running through the full rule set and matching nothing. Deploying several rooms inside ONE bundled instance also works if you prefer that shape -- the framework does not care which split you choose.

## Behavior

| Player state | Rollers | Lights |
|--------------|--------|--------|
| Reachable (playing, paused, or stopped) | **CLOSE** — the automation owns them | unchanged |
| `playing` | stays closed | **OFF** — dark mode |
| `paused` / `stopped` (player still online) | stays closed | HTPC instance: restored **locally** from its own time-of-day + illuminance rules (dimmer ON at l1 50% / l2 25%); Bedroom instance: delegated to [Ambient Lights](./ambient-lights.md) via forced `invoke_automation` |
| `offline` (player gone) | **handed back** to the room's roller owner via forced `invoke_automation` | **delegated** to [Ambient Lights](./ambient-lights.md) via the same forced `invoke_automation` (array form) -- the owner restores from its own time-of-day + illuminance rules, so no `presence` gate is needed and an offline machine still gets its lamps back |

> **Settling delay:** `playing` above is the monitor's *effective* status, which only becomes true once the same title has played continuously for the [playback-settle](../monitors/video-player.md#playback-settle) window (~60 s by default). So dark mode and light/suppression stand-down engage ~60 s into continuous viewing rather than the instant playback starts; rollers are unaffected because they track reachability, not playback. Browsing or skipping through titles therefore never dims the room or suppresses roller automations.

Key design points:

- **Roller ownership is keyed to reachability, not playback.** A paused movie still means "someone is watching" — blinds stay down until the player disappears (machine off, player closed).
- **Roller hand-back is always delegated; light restore is split by player state.** When a player goes **gone** (offline) home-theater invokes the room's roller owner ([Home Office Rollers](./home-office-rollers.md) / [Bedroom Rollers](./bedroom-rollers.md)) so that owner decides the post-playback position from its full rule set, AND pokes the ambient-lights owner via the same array-form `invoke_automation` so the lamps are restored by their own rules. When an **online** player merely pauses/stops, the HTPC/Salon instance instead restores its lamp set locally from its own rules -- gated by time-of-day (`afternoon`/`evening`/`night`) and outdoor illuminance (<900), with the salon dimmer returning switched on via a structured `{state: 'ON', brightness: { l1: 50, l2: 25 }}` command (a bare `{brightness: N}` only sets the level and never switches the relay on); the Bedroom instance keeps delegating that decision to [Ambient Lights](./ambient-lights.md).
- **Delegated runs are forced but budget-neutral.** Each hand-off carries `force: true` so an owner acts even if a once/silent guard would otherwise block it, yet a forced run neither consumes nor refreshes any once-per-day marker; human-interaction cooldowns still apply.
- **Dark-mode OFF rules keep `presence`; the gone rule does not.** Re-darkening an empty room serves no one, so the dark-mode rule requires the host to be reachable. The gone rule, by contrast, is keyed on the player state alone (`offline`) -- no separate `presence` gate -- so an offline machine still triggers the hand-back and the delegated lamp restore.
- **The illuminance sensor is a context source, never a trigger.** Each instance evaluates its `<900` restore gate against the sensor's latest reading whenever it runs, but only player-status/presence transitions (and change-gated timer ticks) actually wake it -- a sensor-report subscription would re-run the gone rule on every lux change while a player is off.
- Each instance opts into `override_human_interaction`, so it is "sticky" while active: manual changes to its targets are re-corrected on the next tick.
- **The timer is a safety net, not a re-firer.** Each instance sets `trigger_on_change_only: true`, so a scheduled tick is skipped unless a monitored player/presence state actually transitioned since the last evaluation. This is what stops a stably-offline player from re-firing the gone rule (and re-poking the owners) on every 15-minute tick -- the rule fires once on the transition that made its conditions true, then stays quiet until something changes again. See the [react-on-change gate](../configuration.md#react-on-change-gate-trigger_on_change_only) in the configuration guide.

## Configuration Files

Each deployment instance reads its own YAML next to its wrapper class; active configs are gitignored and the tracked `.dist` templates ship with fresh clones:

| Instance | Class file | Config template |
|----------|-----------|-----------------|
| Home office (HTPC / Salon) | `etc/automation/homeOfficeVideoAutomation.js` | [`etc/automation/home-office-video.yaml.dist`](../../etc/automation/home-office-video.yaml.dist) |
| Bedroom (Sypialnia) | `etc/automation/bedroomVideoAutomation.js` | [`etc/automation/bedroom-video.yaml.dist`](../../etc/automation/bedroom-video.yaml.dist) |

Both require video players defined under `videoPlayers` in `etc/device/network.yaml` — see the [Video Player monitor](../monitors/video-player.md) for player-side setup (MPC-HC / VLC). The per-room shape looks like this (full examples in the linked templates):

```yaml
override_human_interaction: true   # sticky while active

sensors:                    # illuminance source for the local restore gate -- context ONLY,
  illuminance: 'Outdoor Luminance'   # never a trigger: sensor reports must not re-run this automation

timer_interval: "15m"       # safety net so condition changes are picked up without an event

trigger_on_change_only: true # skip a timer tick unless a monitored player/presence state changed --
                             # stops a stably-offline player from re-firing the gone rule every tick

triggers_video:               # THIS room's player hosts only (videoPlayers keys)
  - my-pc

triggers_network:             # THIS room's presence hosts only
  - my-pc

rules:
  # Rollers: owned while the player answers HTTP; handed back to their owner when it goes offline
  - name: 'Room: player reachable - close rollers'
    conditions:
      presence: { my-pc: true }
      video_player: { my-pc: [playing, paused, stopped] }
    targets:
      Living_Room_Roller_Left: CLOSE

  # Player gone (offline): hand the room back to its owners in one rule. The array form of
  # `invoke_automation` force-fires BOTH the roller owner and the ambient-lights owner. Keyed
  # on the player state alone -- `offline` already covers both an unresponsive player and a
  # powered-down host, so no separate `presence` gate is needed.
  - name: 'Room: player gone - hand back to the room owners'
    conditions:
      video_player: { my-pc: [offline] }
    invoke_automation:
      - { name: HomeOfficeRollersAutomation, force: true }
      - { name: AmbientLightsAutomation, force: true }

  # Lights: playback drives them locally (dark mode); an ONLINE player that pauses/stops
  # restores the lamp set itself -- gated by time of day + outdoor illuminance. A GONE player
  # instead delegates the restore to the ambient-lights owner (above), so the two never fight
  # over the same lamps. Dimmers take a structured state + per-channel percentage map instead
  # of plain ON (a bare {brightness: N} never switches the relay on).
  - name: 'Room: paused/stopped - restore ambient lighting'
    conditions:
      video_player: { my-pc: [paused, stopped] }
      time_of_day: [afternoon, evening, night]
      illuminance: { lt: 900 }
    targets:
      Living_Room_Plug: ON
      Kitchen_Outlet: ON
      Salon_Dimmer: { state: 'ON', brightness: { l1: 50, l2: 25 } }

  - name: 'Room: playing - dark mode'
    conditions:
      presence: { my-pc: true }
      video_player: { my-pc: [playing] }
    targets:
      Living_Room_Plug: OFF
      Salon_Dimmer: OFF
```

**Target devices:** there is no separate declaration section -- each rule's `targets:` key addresses a device directly by its derived target key (registered friendly name with spaces replaced by underscores, casing kept). Keys are validated against the live device container at startup: unknown or non-actuator resolutions warn and stay inert; an automation whose declared targets all fail validation fails fast instead of running silently inert. Target values may also be **structured object commands passed through verbatim** -- e.g., `Salon_Dimmer: { state: 'ON', brightness: { l1: 50, l2: 25 } }`, where the DualDimmer maps each percentage into its channel's level range at publish time (a bare `{brightness: N}` sets levels only and leaves the relay state alone); scalar forms (`ON`/`OFF`, `OPEN`/`CLOSE`, position integers) keep their existing mappings.

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