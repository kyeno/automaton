# Sequence Entity — Design & Implementation Brief

> **Status:** DESIGN APPROVED · NOT YET IMPLEMENTED (as of 2026-10-10)
> This file is the single source of truth for building the new *sequence* being.
> It was written as a durable handoff: any agent picking this up should read this
> document fully, then execute the implementation phases at the bottom in order.
> No decisions below are open — every item was explicitly approved by the owner.

---

## 1. What sequences are (requirements)

Sequences are a whole new first-class being alongside devices, automations and
interactions. They resemble **devices** from the outside: they can receive an
`ON` / `OFF` command. Internally a sequence is configured with an **ordered list
of devices**; an `ON` command walks that list iteratively and sends each device
the received command (or its per-step override), optionally pacing steps with a
preconfigured delay.

Key requirements (all approved):

1. Sequences live under `src/sequence/`, base class in `src/sequence/base/`.
2. They have their own configuration space under `etc/` (`etc/sequence/`).
3. A singleton container manages all instances (same pattern as DeviceContainer).
4. **Blocking**: one sequence instance cannot run twice at the same time;
   concurrent invocations are rejected (logged), never queued, never overridden.
5. **Loop option** (a configurable *option* on every sequence, NOT a separate
   entity type): starts a stateful timer which runs the whole sequence with
   `ON` and then runs it with `OFF`. The gap between the two runs is either a
   preconfigurable duration or `auto` mode (second run starts immediately when
   the first finishes). Loops repeat per config (`once` | `continuous`) and must
   expose a **public start/stop API** so they can be driven from CLI commands
   and later AI tool calls.
6. Runs work not just with bare ON/OFF but with **custom parameters** — e.g.
   dimmer channel percentages, roller positions, brightness. Any payload that
   `DeviceBase.receiveCommand()` accepts may appear in a step verbatim.
7. Every device interaction uses the **normal path only**: resolve via
   `DeviceContainer`, invoke through `receiveCommand()`. No extra hacks.

Reference examples:

- *Sequence*: turn on all ambient lights at home — one after another.
- *Loop sequence*: oscillate Salon's dual-dimmer channels to create a movie-style
  hazard light — channel l1 swings 1% ↔ 100%, channel l2 swings 25% ↔ 75%.
  Setting brightness values automatically creates the transition on the wire.

---

## 2. Approved decisions (including edge cases)

| # | Decision | Rationale / notes |
|---|----------|-------------------|
| D1 | **One base class only** — `sequenceBase.js`. Loop logic lives inside it as an option-driven section + public `startLoop()/stopLoop()` API. There is NO `sequenceLoopBase.js` (owner retracted the two-file idea once loop became an option). | Simpler surface; uniform interface for every instance |
| D2 | Container singleton at `src/sequence/container/sequenceContainer.js` (`SSequenceContainer` → frozen export), mirroring `deviceContainer.js` exactly. | Convention enforced by tests |
| D3 | Config space = `etc/sequence/sequences.yaml`; committed template `sequences.yaml.dist`; active file gitignored like all other configs. | Matches existing etc/ layering |
| D4 | Single friendly `name:` field per entry (no separate label). Internal registry/state key derived with existing `slugify()` from `lib/string.js:14` (trim, lowercase, spaces→underscores): `'Salon Hazard Light'` → `salon_hazard_light`. | Same convention devices use everywhere |
| D5 | `delay_ms` fully optional. Absent ⇒ **"multi-device endpoint" mode**: all steps fire back-to-back with no waiting (useful on its own). Present ⇒ inter-step pacing; per-step override allowed. | Owner request |
| D6 | Loop semantics: `cycle: once \| continuous`; `off_delay_ms` / `on_delay_ms`: `auto \| <duration>` (gaps before OFF runs / before ON runs respectively; both default to auto). **Graceful stop**: cancel whichever inter-phase timer is armed if between phases; an in-flight step-list always finishes so no device ends half-configured; after finishing, a stopped loop starts no further cycles. | Agreed edge case #5 |
| D7 | Blocking mutex covers BOTH single runs and loops per instance — nothing can override anything while an instance is busy. Rejections logged at warn level. | "No possibility to override" requirement |
| D8 | Run state stored in StateService under keys: `sequence.<slug>.active` (bool), `sequence.<slug>.phase` (`'on'\|'off'\|null`), `sequence.<slug>.loop.active` (bool). Bonus: UI status-bar `stateWidget` can render these later for free. | Owner suggested StateService |
| D9 | All commands sent as `DeviceCommandSource.AUTOMATION` (`src/enum/deviceCommandSource.js`). Keeps origin tracking / human-cooldown logic correct downstream. | No-hacks rule |
| D10 | Missing referenced devices ⇒ that step is inert with a warning log; sequence still runs remaining steps; app never crashes on bad references. Warn at container init like rule-based automations do for unknown targets. | Matches kitchen-automation precedent |
| D11 | **Restart kills sequences/loops** — accepted by owner ("no big deal"). Fresh process = clean slate; stale StateService keys cleared during container init. Redis marker persistence across restarts DEFERRED (§10). | Agreed edge case #1 |
| D12 | Device-layer no-op suppression applies normally (identical payload already at target gets dropped by the device). Accepted/desirable; `bypassNoOpSuppression` remains available if ever needed. | Agreed edge case #2 |
| D13 | Human override mid-sequence does NOT abort the run — sequence walks its full list. Documented behavior, not configurable in v1. | Agreed edge case #3 |
| D14 | AI tool integration **DEFERRED to a later change**. Public API (`run`, `startLoop`, `stopLoop`) must be ready so wiring two static tools (`run_sequence`, `control_sequence_loop`) into `toolBuilder.js` later is trivial. NO toolBuilder/i18n edits in this work. | Owner: "defer for later" |
| D15 | CLI command `/sequence` IS part of this change (demonstrates + exercises the public API). | From original requirement |
| D16 | Container init in main.js is **optional-tolerant** (`initService(..., true)`): bad/missing config warns and stays inert instead of crashing core startup. Sequences are a convenience layer, not core infra like DeviceContainer. | Approved with plan |

---

## 3. Codebase conventions that MUST be followed (enforced by tests)

These gates run under `npm test` (`node bin/automaton-test`) and fail if violated:

- **Singleton naming** (`tests/test-file-conventions.js`): default-exported module
  singletons must come from an S-prefixed class — `class SSequenceContainer` →
  `const SequenceContainer = new SSequenceContainer(); Object.freeze(SequenceContainer); export default SequenceContainer`. See tail of `src/device/container/deviceContainer.js`.
- **Indentation**: code lines under `src/` indented by multiples of 4 spaces; no tab
  characters anywhere; no shebangs on non-executable modules.
- **JSDoc coverage ≥ 80%** (`tests/test-jsdoc-coverage.js`): document every public
  class/method/top-level function. Every file starts with the standard license header
  block used across src/ (copy one verbatim, e.g. top of `deviceBase.js`).
- **Dist sync** (`tests/test-dist-sync.js`): any key present in an active YAML must
  also exist in its `.yaml.dist` template. Ship a complete, fully-commented template.
- **Test style** (model: `tests/test-kitchen-countertop-led.js`): plain node script;
  `dotenv` + env fallbacks at top; `await ConfigService.init()`; local
  `assert(condition, label)` counters; exit code reflects failures; mock devices are
  small classes recording `receiveCommand(cmd, source)` calls and reflecting state via
  `getStateLast()`; device lookup stubbed by patching
  `Object.getPrototypeOf(DeviceContainer).findByName` inside a test block and restoring it afterwards.

Key existing APIs to reuse (do not reinvent):

| API | Location | Notes |
|-----|----------|-------|
| `device.receiveCommand(command, source = HUMAN, options = {})` | `src/device/base/deviceBase.js:1131` | Accepts string (`'ON'`, `'OPEN'`) or object payload (`{state:'ON', brightness:{l1:50}}`). DualDimmer maps per-channel brightness % → zigbee levels itself (`_buildBrightnessFields`, `src/device/type/dualdimmer.js`). No-op suppression built in; `options.bypassNoOpSuppression` bypasses it. |
| `DeviceContainer.findByName(name)` / `.getAll()` | `src/device/container/deviceContainer.js` | Registry keys are raw friendly names. |
| `TimedAction` | `src/lib/timedAction.js` | Single-slot race-safe timer: `start(ms, boundFn) → bool`, `stop()`, `isActive()`, `cleanup()`. Use for the loop inter-phase delay. |
| `StateService` | `src/service/stateService.js` | Global KV store with listeners: `get/set/delete/on`. |
| `slugify(str)` | `src/lib/string.js:14` | trim + lowercase + spaces→underscores. |
| `temporal.parseDurationMs(value)` | `src/lib/date.js:299` | Parses `"500ms"`, `"2s"`, `"1m"` or plain ms numbers → number. Use for all duration config values. |
| `ConfigService.getConfigPath(name)` / `.load(filePath, sectionName)` | `src/service/configService.js` | `getConfigPath('sequence')` resolves via main-config `paths.configs` (default added per §7). `load()` returns a cached ConfigBase or **null on failure** (warns internally — handle null gracefully). ConfigBase auto-falls back to `<file>.dist` when the active file is missing and auto-loads schema from `src/validators/<sectionName>.js`; call `await section.validate()` yourself for non-fatal per-entry errors. |

---

## 4. File tree (final)

```
NEW  src/sequence/base/sequenceBase.js           # SequenceBase -- run engine + blocking mutex + optional loop state machine
NEW  src/sequence/container/sequenceContainer.js # SSequenceContainer singleton
NEW  etc/sequence/sequences.yaml.dist            # fully-commented template (active sequences.yaml gitignored)
NEW  src/validators/sequences.js                 # schema for the "sequences" config section
NEW  src/ui/commands/sequenceCmd.js              # /sequence CLI command with tab completion
NEW  tests/test-sequences.js                     # behavioral suite
EDIT src/main.js                                 # bootstrap init after DeviceContainer; gracefulDeath Phase 1 cleanup
EDIT src/service/configService.js                # DEFAULT_PATHS.configs.sequence entry
EDIT src/ui/ui.js                                # add sequenceContainer to ctx object (~line 147)
EDIT doc/architecture/index.md                   # list this doc in "In this section" + project structure tree
EDIT doc/configuration.md                        # new Sequences section
EDIT doc/ui/commands/index.md                    # /sequence reference entry
EDIT doc/TODO.md                                 # flip status once implemented
```

No other files are touched. In particular: NO `toolBuilder.js` / i18n edits (D14).

---

## 5. Configuration design (`etc/sequence/sequences.yaml`)

Two forms per entry — **simple** (device list, ON/OFF derived automatically) and
**rich** (explicit `on:`/`off:` step lists carrying arbitrary payloads):

```yaml
# Sequences Configuration
# Ordered device choreography with optional loops. Each entry is one sequence.
#
#   name       required friendly name; internally slugified (spaces -> underscores),
#              e.g. 'Salon Hazard Light' -> salon_hazard_light
#   delay_ms   OPTIONAL inter-step pause ("500ms", "2s", ... or plain ms). When absent
#              the sequence acts as a multi-device endpoint -- every step fires back-to-back.
#   devices    simple form: ordered names (or {device, command, delay_ms} objects);
#              ON sends each device 'ON', OFF sends each device 'OFF'.
#   on/off     rich form: explicit step lists. A step is {device, payload?, delay_ms?};
#              payload passes through DeviceBase.receiveCommand() verbatim (any shape it
#              accepts: strings, {state}, {position:N}, {state,brightness:{l1,l2}}, ...).
#              'off' defaults to plain OFF over the same ordered devices from 'on'.
#   loop       OPTIONAL block making this a looping sequence:
#                enabled: true
#                cycle: once | continuous      # once = single ON->OFF pass; continuous = repeat until stopped
#                off_delay_ms: auto | duration # gap between end of ON run and start of OFF run;
#                                              # auto = phase starts right when the previous one finishes
#                on_delay_ms: auto | duration  # gap between end of OFF run and next ON run (continuous only);
#                                              # auto = no wait, same as above
sequences:
  # Simple form + pacing: ambient lights come up one after another.
  - name: 'Ambient Lights'
    delay_ms: '500ms'
    devices:
      - 'Salon Ambient Left'
      - 'Bedroom Ambient'
      - device: 'Kitchen LED Strip'   # object entries allow per-step overrides
        command: 'ON'
        delay_ms: '800ms'

  # Rich form: Salon dual-dimmer hazard light oscillation.
  - name: 'Salon Hazard Light'
    loop:
      enabled: true
      cycle: continuous
      off_delay_ms: auto
      on_delay_ms: auto
    on:                               # phase A -- low values
      - device: 'Salon Dimmer'
        payload: { state: 'ON', brightness: { l1: 1, l2: 25 } }
    off:                              # phase B -- high values (setting values creates the transition)
      - device: 'Salon Dimmer'
        payload: { state: 'ON', brightness: { l1: 100, l2: 75 } }
```

Validation rules enforced at container init (warn + skip entry / inert step — never crash):

- `name` required string; duplicate slugs rejected with an error log.
- Exactly one of `devices:` or `on:` must be present (`off:` only meaningful with rich form).
- `delay_ms` / per-step `delay_ms` parse via `temporal.parseDurationMs`; invalid → warn, treat as absent/0.
- `loop.cycle` ∈ {once, continuous} (default once); `loop.off_delay_ms` / `loop.on_delay_ms` = `auto` | duration (both default auto; the ON-side gap only fires between an OFF run and the next ON run of a continuous cycle).
- Referenced devices resolved against DeviceContainer; missing ⇒ inert step (D10).

---

## 6. Class design

### 6.1 `SequenceBase` (`src/sequence/base/sequenceBase.js`)

One class for ALL sequences (plain and looping). Constructed by the container from
one validated YAML entry.

Private fields (suggested names):

```js
#name            // friendly name from config
#slug            // slugify(name) -- registry key & StateService prefix
#config          // raw normalized entry object
#stepsOn         // [{deviceName, payload, delayMs}] resolved ON steps
#stepsOff        // same shape for OFF runs
#defaultDelayMs  // sequence-level inter-step delay (0 when unset -> endpoint mode)
#loopConfig      // {cycle: 'once'|'continuous', offDelayMs/onDelayMs: number|null(auto)} or null
#devices         // Map<deviceName, deviceInstance> resolved in init()
#busy             // mutex: true while any run (single or loop phase) is active
#loopActive       // a loop session is engaged (survives across phases incl. timer wait)
#stopRequested    // set by stopLoop(); checked between cycles/phases
#phaseTimer       // TimedAction instance guarding the inter-phase slot
```

Public API:

| Method | Contract |
|--------|----------|
| `constructor(name, config)` | stores + normalizes; parses durations via `temporal.parseDurationMs` |
| `async init()` | resolves every referenced device through `DeviceContainer.findByName`; missing → warn + mark step inert (D10); clears stale StateService keys for this slug (fresh-process clean slate, D11) |
| `getName()` / `getSlug()` | identity accessors |
| `isActive()` | true while `#busy` |
| `isLoopActive()` | true while `#loopActive` |
| `async run(command = 'ON')` | **the blocking core** — see below |
| `startLoop()` → `Promise<boolean>` | public loop start — state machine below; false when rejected (no loop configured, already busy/active) with a warn log |
| `stopLoop()` → `boolean` | graceful stop per D6; false when nothing to stop |
| `getStateSummary()` | `{name, slug, active, phase, loopActive}` for UI/AI/status reporting |
| `cleanup()` | cancel timers, clear StateService keys (called by container on shutdown) |

`run(command)` algorithm:

```text
if #busy -> LoggerService.warn("...already running -- command ignored") ; return false
#busy = true ; set sequence.<slug>.active=true, .phase=command.toLowerCase()
try:
  steps = command === 'OFF' ? #stepsOff : #stepsOn
  for i, step of steps:
      device = #devices.get(step.deviceName)
      if !device -> continue            // inert step (warned at init)
      payload = step.payload ?? (command)   // simple form derives bare ON/OFF strings
      device.receiveCommand(payload, DeviceCommandSource.AUTOMATION)
      delay = step.delayMs > 0 ? step.delayMs : #defaultDelayMs
      if delay > 0 and i < last -> await sleep(delay)     // pacing only between steps
finally:
  #busy = false ; clear .active/.phase state keys
return true
```

Loop state machine (`startLoop` / internal driver):

```text
idle --startLoop--> RUNNING_ON
RUNNING_ON --on-run finished-->
    stopRequested?          --> IDLE
    off_delay_ms == auto?   --> immediately RUNNING_OFF
    else                    --> WAITING_OFF (TimedAction armed with offDelayMs; instance stays busy)
WAITING_OFF --timer fired--> RUNNING_OFF        (stopLoop during wait cancels the timer -> IDLE)
RUNNING_OFF --off-run finished-->
    stopRequested?          --> IDLE
    cycle != continuous?    --> IDLE
    on_delay_ms == auto?    --> immediately RUNNING_ON (next oscillation)
    else                    --> WAITING_ON (TimedAction armed with onDelayMs; instance stays busy)
WAITING_ON --timer fired---> RUNNING_ON         (stopLoop during wait cancels the timer -> IDLE)
IDLE: #loopActive=false, all state keys cleared, TimedAction released
```

Rules of engagement:

- `startLoop()` on an entry without a `loop:` block → warn + return false.
- While `#loopActive`, external `run()` calls are rejected by the same mutex check —
  every entry point checks BOTH flags (`#busy || #loopActive`). Nothing can override (D7).
- The loop driver keeps the instance engaged across phases: it sets `#busy` around each
  phase run and holds `#loopActive` through the inter-phase window.
- `stopLoop()` semantics (D6): set `#stopRequested`; if between phases (either wait slot) cancel
  the armed timer and go straight to IDLE; if mid-phase let that step-list finish, then exit
  without starting further work. Never aborts inside a step-list.
- Continuous mode with both gaps at `auto` produces back-to-back ON/OFF runs = the
  hazard-light oscillation effect.

### 6.2 `SSequenceContainer` (`src/sequence/container/sequenceContainer.js`)

Mirrors `SDeviceContainer` structure & style (JSDoc sections, singleton tail):

| Member | Contract |
|--------|----------|
| `async init()` | resolve path via `ConfigService.getConfigPath('sequence')`; `section = ConfigService.load(path, 'sequences')`; null → warn "no sequence config -- staying inert" + return; `await section.validate()` → log each error as warning; normalize entries (§5 rules), detect duplicate slugs (error log, skip dupes); instantiate `new SequenceBase(name, cfg)` per entry, `await seq.init()`, register under slug; info-log summary count |
| `async reloadSequences()` | /config-reload hook: builds a brand-new registry via the shared `#buildRegistry()` WITHOUT touching the live map until success; unreadable file → keep the current registry intact + report `{ok:false}`; otherwise stop engaged loops first (`stopLoop()`+`cleanup()`, D6 graceful semantics) then swap in the new Map; returns `{ok, loaded, added, removed}` slug-diff for UI reporting so `/config reload` picks up sequences.yaml edits without a restart |
| `isInitialized()` | true once bootstrap ran at least one build attempt — gates the /config-reload probe so half-built containers are never touched |
| `get(slug)` / `getAll()` / `getNames()` | registry access (Map keyed by slug) |
| `async callCommand(slug, command)` | resolves + delegates to `run(command)`; unknown slug → warn |
| `startLoop(slug)` / `stopLoop(slug)` / `isLoopActive(slug)` | delegate to instance loop API |
| `cleanupSequences()` | iterate instances calling `cleanup()` in try/catch like DeviceContainer.cleanupDevices |

Export: `const SequenceContainer = new SSequenceContainer(); Object.freeze(SequenceContainer); export default SequenceContainer`.

---

## 7. Integration points (exact edits)

1. **`src/service/configService.js`** — add to `DEFAULT_PATHS.configs` (~line 21):
   ```js
   sequence:    'etc/sequence/sequences.yaml'
   ```
   Optionally extend the commented `paths:` example block in `etc/automaton.yaml.dist`.

2. **`src/main.js`**:
   - import next to the other containers (~line 23).
   - In `bootstrap()` immediately AFTER `initService('DeviceContainer', ...)` (~line 338), BEFORE AutomationContainer:
     ```js
     await initService('SequenceContainer', () => SequenceContainer.init(), true)
     ```
     (`true` = optional-tolerant per D16.)
   - In `gracefulDeath()` Phase 1, insert between the InteractionContainer and
     AutomationContainer cleanup blocks (~lines 176-190):
     ```js
     if (initialized.has('SequenceContainer')) {
         LoggerService.debug('Cleaning up sequences...', 'Main')
         await Promise.resolve(SequenceContainer.cleanupSequences())
     }
     ```

3. **`src/ui/ui.js`** — import + add `sequenceContainer: SequenceContainer` to the ctx
   object built at ~line 147 (alongside `deviceContainer`, `automationContainer`).

4. **`src/ui/commands/sequenceCmd.js`** — auto-discovered by CommandContainer from
   `src/ui/commands/*.js` (no registration needed). Model it on `deviceCmd.js`:
   static `name = 'sequence'`, `description`, `takesArgs = true`; subcommand dispatch in
   `execute(args)`; tab completion via `completeNextToken(typedTokens)` returning
   `['list','run','loop']` then sequence names from `ctx.sequenceContainer.getNames()`.
   Subcommands:
   ```text
   /sequence                          list all sequences with live status (active/phase/loop)
   /sequence run <name> [ON|OFF]      single run, default ON; name may be slug or friendly name
   /sequence loop start <name>        start the loop (public API demo for CLI/AI integration)
   /sequence loop stop <name>         graceful stop
   ```
   Name resolution should accept both the slug and the original friendly name
   (case-insensitive compare against registry entries).

5. **`src/validators/sequences.js`** — shallow schema picked up automatically by
   ConfigBase when section name is "sequences":
   ```js
   export default {
       sequences: { type: 'array', required: false, items: { properties: {
           name:     { type: 'string', required: true },
           delay_ms: { type: ['number', 'string'] },
           devices:  { type: 'array' },
           on:       { type: 'array' },
           off:      { type: 'array' },
           loop: { type: 'object', properties: {
               enabled:      { type: 'boolean' },
               cycle:        { enum: ['once', 'continuous'] },
               off_delay_ms: { type: ['number', 'string'] },
               on_delay_ms:  { type: ['number', 'string'] }
           }}
       }}}
   }
   ```
   Deeper per-entry semantics (§5 rules) are validated in container init with warn+skip.

---

## 8. Test plan (`tests/test-sequences.js`)

Follow `tests/test-kitchen-countertop-led.js` conventions exactly (bootstrap block,
assert counters, mock device classes recording commands, `findByName` prototype patch
with restore). Scenarios:

- **A** — simple-form ON run walks the ordered list; recorded command order matches config order; inter-step delays respected (measure wall-time bounds with short durations like 30-60ms).
- **B** — multi-device-endpoint mode: no `delay_ms` ⇒ all steps fire without waiting (elapsed ≈ 0 within tolerance); OFF run sends `'OFF'`.
- **C** — rich form: explicit `on:`/`off:` payloads pass through verbatim to `receiveCommand` (hazard-light shape incl. per-channel brightness map); missing `off:` defaults to plain OFF over `on` devices.
- **D** — blocking: a second concurrent `run()` while one is active is rejected (returns false), and `startLoop()` during an active run is rejected too.
- **E** — loop `cycle: once`: start → ON-run → off-delay elapses → OFF-run → idle; state keys correct throughout; `stopLoop()` before the delay cancels cleanly (stopping DURING the wait goes straight to IDLE per §6.1).
- **F** — loop `cycle: continuous`: oscillates repeatedly until `stopLoop()`; stop mid-phase lets that phase finish, then halts (assert exact command count).
- **G** — missing device: inert step skipped with warning, remaining steps still execute.
- **H** — container smoke test: init against the shipped `.dist` template resolves entries without crashing; unknown slugs on callCommand/startLoop warn gracefully.
- **I** — continuous loops honor BOTH inter-phase gaps (`off_delay_ms` before OFF runs, `on_delay_ms` before ON runs) and still halt cleanly; stopping during/after an OFF phase cancels the pre-ON wait so no next ON is ever issued.

Acceptance gate for the whole change: `npm test` passes end-to-end (includes file-conventions, JSDoc coverage, dist-sync gates).

---

## 9. Documentation updates (do at implementation time)

- `doc/architecture/index.md` — add this doc to "In this section" line + project structure tree (`src/sequence/`, `etc/sequence/`).
- `doc/configuration.md` — new "Sequences" section mirroring existing per-file sections (schema reference + both example forms from §5).
- `doc/ui/commands/index.md` — `/sequence` quick-ref entry.
- `doc/TODO.md` — record completion bullet in the established `- DONE (...) -- was:` style.
- Regenerate API docs only if the repo owner asks (`npm run docs`) — not part of acceptance.

---

## 10. Explicitly OUT of scope / deferred follow-ups

1. **AI tools** (D14): two static tools in `toolBuilder.js` — `run_sequence {sequence_name, action: ON|OFF}` and `control_sequence_loop {sequence_name, operation: START|STOP}` — with i18n-backed descriptions (`tools.run_sequence.*` keys), execution branching before `resolveDevice()` like `get_time` does today. Public API is ready; wiring is a small later change.
2. **Restart persistence**: Redis marker for in-flight loops via CacheService (pattern exists in DeviceBase pending-command markers) so a restart can at least log/restore loop intent. LATER.
3. **Rule-based automation targets resolving sequence names** (today `targets:` resolves devices only) — natural extension now that sequences are registry entries. LATER.
4. Per-step abort-on-human-touch during runs. Not wanted for v1 (D13).

---

## 11. Implementation phases (execute in order)

Each phase ends green under `npm test` before starting the next.

- [ ] **Phase 1 — Base class.** Create `src/sequence/base/sequenceBase.js` per §6.1 (full JSDoc + license header, 4-space indent, no tabs).
- [ ] **Phase 2 — Config layer.** Create `etc/sequence/sequences.yaml.dist` (§5, fully commented) and `src/validators/sequences.js` (§7.5).
- [ ] **Phase 3 — Container.** Create `src/sequence/container/sequenceContainer.js` per §6.2 with S-prefix singleton pattern.
- [ ] **Phase 4 — Wiring.** Edits to `configService.js`, `main.js` (bootstrap + gracefulDeath), `ui.js` ctx per §7. Verify boot: `node src/main.js --no-ui` starts cleanly; SIGINT shuts down through sequence cleanup without errors.
- [ ] **Phase 5 — CLI command.** `src/ui/commands/sequenceCmd.js` per §7.4 incl. tab completion.
- [ ] **Phase 6 — Tests.** `tests/test-sequences.js` scenarios A–H per §8. Run full `npm test`; fix until green (convention gates included).
- [ ] **Phase 7 — Docs.** Apply §9 updates; flip TODO.md status.

Handoff sentence for a fresh agent: *"Read doc/architecture/sequence-entity.md in full, then execute its implementation phases 1–7 in order."*

