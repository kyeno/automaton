# Rule Engine: Restore & Ownership Semantics

Restore behavior is defined by explicit rules. A matching restore rule sends its declared
values; the engine does not capture or restore pre-command snapshots.
`restore_state_aware` and `force_restore` are not implemented.

## No-Op Suppression (device layer)

`DeviceBase.#isCommandRedundant()` drops commands that already match the last reported
state, such as ON to an ON light or CLOSE to a closed shutter.

An unconfirmed automation command marks the cached state as unverified. The next command
bypasses suppression, registers a fresh token, and clears that marker. Token expiry without
confirmation logs a warning.

## Re-Assert State (`reassert_state`)

- Forced runs automatically pass `{bypassNoOpSuppression: true}` to targeted devices.
- On natural runs, `reassert_state: true` bypasses suppression for that rule's targets.
- Other rules' targets retain normal suppression. Human cooldowns and video-player
  suppression still apply to forced runs.

Use reassertion for restore commands that must reach a device even when its cache is stale.

## The `offline` Status

A host that is offline, unpolled, or unreachable maps to `offline`. Rules match it only
when they list that status. Changes between raw offline causes do not emit a status change.

## Ownership Pattern in Practice

[Home Theater Mode](../automations/home-theater-mode.md) uses this pattern:

| Player status | Rollers | Lights |
|---------------|---------|--------|
| Reachable | CLOSE | Controlled by playback rules |
| `playing` | Stay closed | OFF |
| `paused` / `stopped` | Stay closed | Explicit restore or delegated ambient rules |
| `offline` | Delegate to roller owner | Delegate to ambient owner |

Restore rules apply their configured values even to devices that were already off before playback.

## Carve-Outs: When A Restore Rule Must Not Restore Everything

Give devices with narrower hours separate restore rules. The hallway cupboard lamp is
lit at dusk and switched off after midnight by Ambient Lights. Home Theater excludes it
from the general restore and relights it only with `hour: { gte: sunset }`.
Ambient Lights also excludes it from pre-dawn restore.

Both restore rules can match on the same tick; their target commands are merged.

## Transition Gating: Which Change Is a Hand-Off

The playback-settle window reports an unsettled player as `stopped`. Require a departure
from `playing` so an `offline → stopped` startup does not restore the lights:

```yaml
conditions:
  video_player: { my-pc: [paused, stopped] }
  state_transition: { 'videoPlayer:my-pc': { from: playing } }
```

| Last transition | Matches `from: playing`? |
|-----------------|-------------------------|
| `playing → paused`, `playing → stopped`, `playing → offline` | Yes |
| `offline → stopped`, `stopped → paused`, initial row with null origin | No |

The condition reads SQLite transition history. Missing history leaves the gate inactive
and does not block the rule. The separate `offline` delegation rule remains ungated.

Related: [Transition syntax](../configuration.md#transition-origin-gate-state_transition) ·
[Video Player Monitor](../monitors/video-player.md) ·
[Human cooldowns](./automation-human-differentiation.md)
