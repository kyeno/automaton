# Home-Theater "Ambient Lights Did Not Come Back" Bug -- Root Cause & Fix Log

> Hand-off document. Written 2026-10-09 during the incident investigation. It is meant to be
> readable with **zero prior context**: it restates the symptom, the evidence, the root cause,
> the fix plan and the current status. Update the **Status** checklist at the bottom as work
> progresses so the next person (or the next context window) knows exactly where things stand.

## Symptom

Play a video on the HTPC, then turn the player off. The ambient lamps that Home Theater Mode
switched off for the movie **do not come back** -- in the 2026-10-09 incident specifically the
kitchen outlet lamp (`Kuchnia Gniazdo`) and the hallway outlet lamp (`Przedpokoj Gniazdo`).

The user report, verbatim: *"Look carefully at Kuchnia Gniazdko and Przedpokoj Gniazdo - those
should come back via ambient lights automation that gets force invoked whenever the movie player
is gone. It DID NOT."*

This has been "fixed" repeatedly (see `git log` -- `e461074`, `6bea899`, and the
`doc/architecture/rule-engine-restore-semantics.md` write-up) without the symptom ever going away,
because **every previous fix targeted rule *gating* (which rule fires, in which time window), while
the actual defect is one layer below, in the device layer's no-op suppression.** The rules fire
correctly and on time; their commands are thrown away before they reach the radio.

## Incident timeline (2026-10-09, UTC; local time = UTC+02:00)

All lines are from `var/log/debug1.log` / `trace1.log` (the files covering 15:00-21:26 UTC at the
time of writing; `debug.log`/`trace.log` rotate every ~5 MB).

| UTC | Local | What happened |
|-----|-------|---------------|
| 21:15:00.429 | 23:15 | `Auto:HomeOfficeVideoAutomation` dark mode publishes `{"state":"OFF"}` to `Kuchnia Gniazdo` and `Przedpokoj Gniazdo` |
| 21:15:00.709 | 23:15 | `Przedpokoj Gniazdo` echo matches -> cache correctly `OFF`. **Kuchnia: no echo ever** |
| 21:15:12 | 23:15 | `Kuchnia Gniazdo` reports `state:"ON"` but `power: 3W -> 0` -- **the relay did switch off; the report did not** |
| 21:15:44.940 | 23:15 | Player gone -> forced invoke -> `Settled dusk` matches. `Przedpokoj Gniazdo` `ON` is **sent** (cache said `OFF`) -> lamp relights. `Kuchnia Gniazdo` `ON` is **`Command "ON" suppressed: device already at target state`** |
| 21:17:36.624 | 23:17 | Dark mode again. Both plugs get `OFF`. Przedpokoj confirms; **Kuchnia: no echo** (`token cmd-1791580656624-19 expired without confirmation` at 21:18:16) |
| 21:18:20.878 | 23:18 | You power the player off: `Video player htpc: playing -> offline (player not answering)` |
| 21:18:21.129 | 23:18 | `Rule matched: "HTPC: player gone - hand back to the room owners"` -> `Invoking automation "AmbientLightsAutomation" (forced)` |
| 21:18:21.140 | 23:18 | Forced run: `Rule matched: "Settled dusk - turn on ambient lamps"` + `"After sunset - someone home - full salon ambient"` |
| 21:18:21.145 | 23:18 | Engine logs `Przedpokoj Gniazdo -> {"state":"ON"}` and `Kuchnia Gniazdo -> {"state":"ON"}` |
| 21:18:21.146 | 23:18 | **Both are dropped**: `Command "ON" suppressed: device already at target state` (trace: `redundancy check hit description=ON`) |
| 21:18:21.147 | 23:18 | Only `Salon Wlacznik Ambient` really gets commands -> `{"state_l1":"ON","state_l2":"ON"}` + brightness -> relights |
| 21:18:36+ | 23:18 | Both plugs keep reporting `state:"ON"` while `power: 0` -- **lamps dark, system certain they are lit** |
| 21:18:59.930 | 23:18 | Presence-triggered natural run: `Rule "Settled dusk" already acted today during evening, skipping` -> `No rules matched, no action`. Same on every 15 m timer tick after that |

### The decisive A/B experiment

`Przedpokoj Gniazdo` is the proof, because it is the *same plug* with the *same command* twice:

* `OFF` at 21:15:00 -> echo arrived 279 ms later -> cache `OFF` -> the 21:15:44 restore `ON` was
  **published** -> `power 0 -> 1 W` by 21:16:26 -> lamp back on.
* `OFF` at 21:17:36 -> **no echo** -> cache stayed `ON` -> the 21:18:21 restore `ON` was
  **suppressed** -> `power` stayed `0` until the log ends.

So the rules, the trigger, the forced invoke and the `once` bookkeeping all behaved exactly as
designed. The command died in one place: `DeviceBase.#isCommandRedundant()`.

## Root cause (three layers)

1. **The plugs execute commands but do not always report the result.**
   Both commands ended in `token ... expired without confirmation` (`src/device/base/deviceBase.js`,
   `CommandCorrelator.hasActive()`), yet the load dropped right after the publish
   (`Kuchnia Gniazdo` `power 3W -> 0` within 12 s of the `OFF`; `Przedpokoj Gniazdo` `1W -> 0`).
   The periodic zigbee2mqtt reports keep carrying a **stale `state:"ON"`** for the rest of the
   evening. Nothing in the pipeline can tell "the device did not act" from "the device acted and
   never told us".

2. **The device layer treats that stale report as proven truth.**
   `#isCommandRedundant()` compares the commanded state against `#stateLast.state` -- the last
   *reported* value -- and drops the command as a no-op. There was no way to say "our last command
   was never confirmed, so the cached state is not evidence". Even a forced hand-off run hit the
   same suppression, because `receiveCommand()` could not express "this must reach the device".
   Note the automation layer *counts the dropped command as dispatched*
   (`#dispatchDeviceCommands()` increments `dispatchedCount` and logs `-> {...}` before the
   device layer gets a say), which is why the logs look like the restore worked.

3. **Nothing ever self-heals afterwards.**
   Both ambient `ON` rules are `once: true` and their `evening` slot was consumed at dusk, so
   from then on every natural run logs `already acted today during evening, skipping` ->
   `No rules matched, no action`. The `forced_only` pre-dawn rule is out of window at 23:18.
   The single 21:18:21 poke was therefore the *only* chance in the whole evening, and its two
   `ON`s were silently discarded. Even `/automation force AmbientLightsAutomation` could not
   have relit the lamps, because the force flag never reached the device layer either.

### Why the previous fixes did not help

Every earlier fix (`e461074`, `6bea899`, the `once`-marker window scoping, the `forced_only`
pre-dawn split) changed *which rule fires when*. They are correct and they work -- the poke now
fires reliably on every player-gone transition, as the timeline shows. The remaining defect is
in the command/state trust model, so all of those fixes leave the symptom untouched.

## Secondary findings (same investigation, not yet acted on)

* **`Salon Wlacznik Swiatlo` has no owner on restore.** Dark mode switches it off
  (`etc/automation/home-office-video.yaml`, `HTPC: playing - dark mode`) but **no rule anywhere
  ever switches it back on**. In the incident it was `ON` from 21:04 (human), killed at 21:15:00,
  still `OFF` at 23:35. Dark-mode and restore target sets are asymmetric. Decision needed from the
  user (see *Open questions*) -- do not silently change house lighting behaviour.
* ~~**Dual-dimmer echo matching never matches at all.**~~ **FIXED (2026-10-10).** Tokens used to be registered with
  `expectedState={"STATE_L1":"OFF","STATE_L2":"OFF"}` while `#evaluate()` compares
  `payload.state`, so *every* dual-dimmer command ends in `expired without confirmation`
  (visible all evening for `Salon Wlacznik Ambient` and `Salon Wlacznik Swiatlo`). Those devices
  are only saved by the fact that their periodic reports do carry `state_l1` / `state_l2`.
  Now resolved: `CommandCorrelator` confirms on the STATE channels and `#isCommandRedundant()` proves multi-channel no-ops, so healthy dimmers/switches confirm AND re-suppress again -- which also closes the coupling with the re-assert fix (they no longer keep the unverified-state marker set forever). See section F of `tests/test-command-reassert.js`.
* **`force_restore` and `restore_state_aware` are documented but not implemented.**
  `grep -rn 'force_restore\|restore_state_aware' src/ etc/ tests/` finds nothing outside `doc/`.
  The architecture doc describes snapshot/ownership semantics that do not exist in code. The fix
  below adds the *narrow* piece that was actually needed; do not assume the documented flags work.


## The fix

Principle: **a no-op is only provable from a confirmed state.** And: a hand-off/restore dispatch
must be able to say "this must reach the device".

1. `src/device/base/deviceBase.js` -- `CommandCorrelator`
   * Remember the last automation command that expired without confirmation
     (`#unconfirmed = { token, expectedState, expiredAt }`).
   * Clear it when it stops being ambiguous: a new command is registered, an echo matches, a
     conflict is reported, a genuine state change is observed, or a human-directed command is
     published.
   * `warn`-log the expiry (it was `trace`-only before, i.e. invisible).
2. `src/device/base/deviceBase.js` -- `DeviceBase`
   * `#isCommandRedundant()` returns `false` (send it) while the cached state is unverified by an
     unconfirmed command. Self-limiting: dispatching the replacement command registers a fresh
     token and clears the marker, so this adds **at most one** extra publish per unconfirmed
     command -- the MQTT-spam guarantee for healthy devices is preserved.
   * `receiveCommand(command, source, options)` gains
     `options.bypassNoOpSuppression` so a caller can force the command onto the wire.
3. `src/automation/base/ruleBasedAutomationBase.js` -- `#dispatchDeviceCommands()`
   * Passes `bypassNoOpSuppression: true` when the run is **forced** (`/automation force`,
     `invoke_automation: {force: true}` player-gone hand-off) or when a contributing rule
     declares **`reassert_state: true`** (new per-rule flag, needed for the *natural*
     `paused`/`stopped` restore path in `home-office-video.yaml`, which is not a forced run).
4. `src/device/type/dualswitch.js` / `dualdimmer.js` -- thread `options` through their
   `receiveCommand()` -> `_publishResolved()` -> `_publishRaw()` -> `super.receiveCommand()`.
5. `src/ui/commands/automationCmd.js` -- render a `[reassert]` flag next to `[once/day]` /
   `[invoke-only]` so the new rule flag is visible in `/automation debug` and `/automation coverage`.
6. `etc/automation/home-office-video.yaml` (+ `.dist`; `tests/test-dist-sync.js` enforces sync) --
   mark `HTPC: paused/stopped - restore ambient lighting` with `reassert_state: true`.
7. `tests/test-command-reassert.js` -- regression test that reproduces the incident end to end
   with a mock MQTT broker that never echoes (see file for the exact scenario).
8. Docs: `doc/configuration.md` (new flag), `doc/architecture/rule-engine-restore-semantics.md`
   (be honest about what exists), this file.
9. `src/device/base/deviceBase.js` (`CommandCorrelator`) + `dualdimmer.js` -- per-channel echo matching for
   suffixed payloads, no-op proof in `#isCommandRedundant()`, and dimmer split-state/brightness correlation onto
   the STATE channels via `options.correlateAs`. Closes secondary finding #2 above.



### What was deliberately NOT done

* No blanket "always send" for natural tick runs -- that would reintroduce the MQTT spam the
  suppression exists to prevent.
* No `restore_state_aware` / snapshot implementation (large feature, documented but absent;
  out of scope for this bug).
* No change to `once: true` semantics or to the time-of-day window scoping -- those are correct.
* `Salon Wlacznik Swiatlo` left alone pending a user decision (see *Open questions*).

## Open questions for the user

1. `Salon Wlacznik Swiatlo` (salon main dimmer) is switched off by dark mode and restored by
   nothing. Options: (a) add it to the restore rules (needs a decision on which channels and what
   level -- it was `l1` only, `l2` off, when dark mode killed it), or (b) remove it from dark mode
   so the movie no longer touches it.

## How to verify the fix in production

1. Watch `var/log/trace.log` for `token ... expired without confirmation` followed later by
   `Command "ON" sent to topic zigbee2mqtt/Kuchnia Gniazdo/set` during a player-gone hand-off
   (previously that second line was `... suppressed: device already at target state`).
2. Watch `var/log/warn.log` for the unconfirmed-command warning, which reads
   `Automated command ON produced no observable response -- cached device state stays unverified until the
   device confirms or changes state`. (The phrase `expired without confirmation` itself is only logged at
   **trace** level; it never reaches warn.log.)
3. For multi-channel devices (`Salon Wlacznik Ambient`, etc.), confirm their restore now logs
   `Automation echo matched -- origin=automation` when the suffixed report arrives, and that a redundant
   re-send is then `suppressed: device already at target state` (previously every such token ended in
   `expired without confirmation` because suffixed echoes were never matched).
4. Confirm `power` on `Kuchnia Gniazdo` returns to ~3 W and `Przedpokoj Gniazdo` to ~1 W after
   the player goes offline.

## Status

- [x] Log forensics / root cause identified (2026-10-09)
- [x] Hand-off document written (this file)
- [x] `CommandCorrelator` unconfirmed-command tracking + warn log
- [x] `DeviceBase` unverified-state bypass + `bypassNoOpSuppression` option
- [x] Dual-channel types thread the option through
- [x] Rule engine passes the bypass for forced runs / `reassert_state` rules
- [x] `[reassert]` flag in `/automation debug` + `/automation coverage`
- [x] `home-office-video.yaml` + `.dist` marked `reassert_state: true` (in sync; `test-dist-sync.js` green)
- [x] Regression test added and passing -- `tests/test-command-reassert.js` (23 assertions incl. multi-channel section F), registered in `bin/automaton-test`
- [x] Multi-channel echo matching fixed (`CommandCorrelator` per-channel confirm) + no-op proof in `#isCommandRedundant()`; dimmer split correlated onto STATE channels via `options.correlateAs` (secondary finding #2 closed; coupling resolved)
- [x] Docs updated -- `doc/configuration.md` (`reassert_state`) and `doc/architecture/rule-engine-restore-semantics.md` (now honest that snapshots / `restore_state_aware` / `force_restore` are documented-but-absent)
- [x] Lint green -- `npm run lint:check` 4/4. Full `npm test`: every test touched by this fix passes, including the new regression test. Two failures remain that are **pre-existing and unrelated** to this change: `test-sound.js` needs a real audio device (`beep exited with code 1`), and `test-ambient-lights-rules.js` fails identically on pristine HEAD (verified via a throwaway `git worktree` at `80d562e`).


---

→ Back to [Index](./index.md) · Related: [Restore & Ownership Semantics](./architecture/rule-engine-restore-semantics.md) · [Home Theater Mode](./automations/home-theater-mode.md)

