# Rule Engine: Restore & Ownership Semantics

## Overview

Rule-based automations frequently need to *undo* their own actions: lights turned off for a movie must come back when it ends, blinds closed for glare must reopen when the cause disappears. The rule engine (`src/automation/base/ruleBasedAutomationBase.js`) implements this with **snapshots** — an automation remembers the state a device was in *before* it acted, and restores exactly that when its rules stand down.

Two related mechanisms ride along: **ownership** (an automation only undoes changes *it* made) and **no-op suppression** (commands that would not change anything are not sent at all).

## Snapshots

When an automation dispatches a command that changes a device, it first records the device's pre-command state as a snapshot:

- Stored in Redis under `auto:<automation>:restore:<targetId>` with a **12-hour TTL**, plus an in-memory fast path.
- Written **only on real transitions** — if the device was already in the commanded state, nothing is recorded. A light that was already off when dark mode started therefore has no snapshot, and nothing is ever "restored" for it.
- Snapshots survive process restarts (Redis) but expire on their own — a stale snapshot never resurrects a light hours later.

## State-Aware Restore (`restore_state_aware`)

With `restore_state_aware: true` at the automation level, restore commands are filtered through the snapshots:

- **ON** is re-asserted only for devices the automation itself turned off from an on-state.
- **OPEN** is re-asserted only for rollers the automation itself closed from an open state — blinds found already closed are never opened by a hand-back.
- Devices without a snapshot are skipped entirely.

Without the flag, restore commands are dispatched unconditionally.

## `force_restore`

A rule can mark its targets as unconditional with `force_restore: true`:

- Normally reserved for "always on" ambient lights — e.g. dim bathroom/snack lights that should come back on pause *even if they were off before dark mode*.
- Ownership is resolved per target: the **first matching rule that commands the target** owns the decision, and *its* `force_restore` flag applies. This keeps multiple rules from disagreeing about the same device.

## No-Op Suppression

Before dispatching, the engine compares the commanded state against the device's last known state:

- `ON` to a device already on, `OFF` to one already off, `CLOSE` to a roller already at position 0, `OPEN` to one already at 100 — all provable no-ops are dropped.
- This stops MQTT spam from "sticky" automations that re-assert their desired state on every tick (e.g. those using `override_human_interaction`), and keeps snapshots clean: no transition, no snapshot.

## The `unknown` Status Token

Monitor-backed conditions (`videoPlayer`, and any future monitor) treat a `null` status as an explicit **`unknown`** token rather than a wildcard:

- An unknown status matches **only** condition lists that explicitly include `unknown`.
- Each rule decides whether an unknown state is safe to act on: ambient-restore rules opt in (`[paused, stopped, unreachable, unknown]`), playback rules stay inert (no dark-mode action fires on a guess).
- `unreachable` is a *real* status (the host is online but the player does not answer) and matches lists containing it, independent of `unknown`.

## Ownership Pattern in Practice

The [Home Theater Mode](../automations/home-theater-mode.md) automation demonstrates the full pattern:

| Player state | Rollers (owned while reachable) | Lights (driven by playback) |
|--------------|--------------------------------|----------------------------|
| Reachable (any state) | `CLOSE` — automation takes ownership | unchanged |
| `playing` | stays closed | `OFF` — dark mode |
| `paused` / `stopped` | stays closed | restore (snapshot-filtered; `force_restore` lights always) |
| `unknown` / `unreachable` | hand back — `OPEN` only what it closed itself | restore, gated by `presence` |

## Related Documentation

| Document | Relation |
|----------|----------|
| [Home Theater Mode](../automations/home-theater-mode.md) | Flagship consumer of snapshots, ownership, and `force_restore` |
| [Video Player Monitor](../monitors/video-player.md) | Source of the statuses the `unknown` token governs |
| [Configuration Guide](../configuration.md) | Rule syntax: `restore_state_aware`, `force_restore`, `videoPlayer` condition |
| [Automation vs Human Differentiation](./automation-human-differentiation.md) | The cooldown/override system these rules dispatch through |