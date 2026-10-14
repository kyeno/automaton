# Rule Engine: Restore & Ownership Semantics

## Overview

Rule-based automations frequently need to *undo* their own actions: lights turned off for a movie must come back when it ends, blinds closed for glare must reopen when the cause disappears. The rule engine (`src/automation/base/ruleBasedAutomationBase.js`) implements this with **explicit restore rules** -- rules that fire when the stand-down condition holds (player `paused` / `stopped` / `offline`), gated by `presence`, `once` markers and time windows. There is no remembered pre-command state; what comes back is whatever those rules declare.

One mechanism rides along: **no-op suppression** (commands that would not change anything are not sent) -- plus its two escape hatches described below, which is where the home-theater ambient-lighting failure lived.

> ### What actually exists vs. what was documented here
>
> Earlier revisions of this page described **snapshots**, an automation-level `restore_state_aware` flag and a per-rule `force_restore` flag as implemented features. **None of them exist in the code.** There is no `auto:<automation>:restore:*` Redis key, no pre-command state capture, and neither flag is read anywhere under `src/`. They were written up as the *intended* design before it was built; they remain a roadmap item, not behavior. Do not rely on them. Restore today is driven entirely by **explicit rules** that fire when the stand-down condition holds (`paused` / `stopped` / `offline`, gated by `presence`, `once`, time windows) -- see [Home Theater Mode](../automations/home-theater-mode.md). The only restore-related mechanism that ships is the device-layer re-assert path below.

## No-Op Suppression (device layer)

Redundant commands are dropped in `DeviceBase.#isCommandRedundant()` -- at the **device** layer, not the rule engine. Before publishing, the commanded value is compared against the last *reported* state:

- `ON` to a device already reporting `ON`, `OFF` to one reporting `OFF`, `CLOSE` to a roller already at position 0, `OPEN` to one at 100 -- provable no-ops are suppressed so "sticky" automations do not spam MQTT every tick.
- A command counts as redundant **only while the cached state is proven**. Two exceptions force a send instead:
  - **Unverified-state bypass.** If the automation's own previous command expired without an echo/confirmation (a plug can flip its relay and never report back), the cache may still describe the pre-command world. While that doubt is open, suppression is skipped for the next command; dispatching it registers a fresh token and clears the marker, so this adds **at most one extra publish** per unconfirmed command. The expiry is now logged at `warn` level (`token ... expired without confirmation`).
  - **Explicit re-assert.** A caller passes `{bypassNoOpSuppression: true}` to guarantee delivery regardless of what the cache says. The rule engine sets this automatically -- see below.

## Re-Assert State (`reassert_state`)

The rule engine decides, per target device, whether to set `bypassNoOpSuppression`:

- **Forced / delegated runs always re-assert** -- `/automation force <n>` or another automation's forced `invoke_automation` (the player-gone hand-off). This guarantees the restore reaches devices whose cache is stale.
- **Natural runs re-assert only when a contributing rule declares `reassert_state: true`.** This covers restore paths that fire on their own schedule rather than being poked -- e.g. the `paused`/`stopped` ambient-lighting restore in `home-office-video.yaml`.
- The flag is **per-rule and scoped**: it applies only to devices targeted by *that* rule; other rules' targets in the same run are unaffected. It complements (does not replace) the automatic unverified-state bypass above. See [Configuration Guide](../configuration.md#re-assert-state-reassert_state) for authoring details.

## The `offline` Status

Monitor-backed conditions (`video_player`, and any future monitor) enumerate every "no usable signal" case into one **`offline`** status rather than a wildcard:

- Host offline, host not yet polled, and player not answering all arrive as `offline` -- and, for the top-level `video_player_suppression` stand-down guard, suppress only when `offline` is listed among the suppression statuses.
- Each rule decides whether an offline player is safe to act on: ambient-restore rules list it (`[paused, stopped, offline]`), playback rules stay inert (no dark-mode action fires on a guess).
- The raw cause behind an `offline` status (presence-offline vs. unreachable player) is kept in the monitor's debug logs only; drifting between the two raw causes is **not** a status transition, so it never re-fires automations.

## Ownership Pattern in Practice

The [Home Theater Mode](../automations/home-theater-mode.md) automation demonstrates the full pattern:

| Player state | Rollers (owned while reachable) | Lights (driven by playback) |
|--------------|--------------------------------|----------------------------|
| Reachable (any state) | `CLOSE` — automation takes ownership | unchanged |
| `playing` | stays closed | `OFF` — dark mode |
| `paused` / `stopped` | stays closed | restore via explicit rule (`reassert_state`) |
| `offline` | hand back — roller restore rule fires | restore, gated by `presence` (+ forced-run re-assert) |

There is **no snapshot-based filtering** ("only reopen what it closed itself"): which devices come back is decided purely by which restore rules match, so a device that was already off before dark mode gets whatever its restore rule declares -- the same value every time.

## Carve-Outs: When A Restore Rule Must Not Restore Everything

A restore rule's target list **is** its ownership list, and a restore rule restores exactly what it lists -- every time, at the same value. So when two automations own the same device at different hours, that device has to be carved out of one of the lists:

- The **hallway cupboard lamp** (`Hallway Cupboard Outlet`, live `Przedpokoj Gniazdo Szafka`) is lit by [Ambient Lights](../automations/ambient-lights.md) from dusk, switched off by that automation's own past-midnight rule, and cleared by its bright-morning safety net. Home Theater's general `paused`/`stopped` restore therefore does **not** list it. Home Theater still switches it out for dark mode and still relights it -- but only through a dedicated rule of its own, gated by `hour: { lt: sunrise }`, so a movie paused at 21:00 in October does not light a cupboard lamp that the household expects to be out by then.
- Ambient Lights' **pre-dawn restore** carves the same lamp out in the other direction: it restores the lamps its owner owns, and the cupboard lamp is deliberately not among them, because past midnight the lamp belongs to the "night is over" rule, not to a player hand-off.

The dedicated rule is the pattern to copy: keep the general restore rule's target list to the devices whose ownership you hold across the whole window, and give the carved-out device a rule of its own carrying the narrower gate. Both rules then match in the same tick and the engine merges them -- see [Configuration Guide → Target Keys](../configuration.md#target-keys-targets).

## Related Documentation

| Document | Relation |
|----------|----------|
| [Home Theater Mode](../automations/home-theater-mode.md) | Flagship consumer of the restore-rule pattern and `reassert_state` |
| [Video Player Monitor](../monitors/video-player.md) | Source of the `offline` status the conditions govern |
| [Configuration Guide](../configuration.md) | Rule syntax: `reassert_state`, `forced_only`, `once`, `video_player` condition (`restore_state_aware` / `force_restore` are documented above as not implemented) |
| [Automation vs Human Differentiation](./automation-human-differentiation.md) | The cooldown/override system these rules dispatch through |