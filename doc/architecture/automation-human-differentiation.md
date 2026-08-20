# Automation vs Human Interaction Differentiation

## Overview

Roller shutters, lights, and other mechanisms are controlled over a shared MQTT bus by both automation systems and humans (physical remotes, wall switches, mobile apps). Because zigbee2mqtt publishes every state change to the same topic regardless of who caused it, the system must distinguish its own command echoes from genuine human-initiated state changes — otherwise automations fight with the user.

**Policy:** ONLY autonomous rule-engine actions count as `AUTOMATION`. Every other actor counts as `HUMAN`: physical remote presses, YAML interaction targets, Home Assistant / zigbee2mqtt UI actions routed through us, unmodeled wall switches, **and AI chat commands** (a person gave the AI the order, so the action traces back to a human). This policy is what keeps rules like `salon-rolety` from re-firing after a person takes over a device.

The classification system implements this policy using:

- an explicit **command provenance enum** (`DeviceCommandSource`) passed at dispatch time,
- a causal **token tracker** (CommandCorrelator) that only ever tracks rule-engine expectations,
- a **motion-stall watchdog** for travel commands,
- an explicit **Origin state machine** persisted in Redis, and
- a **Redis-backed cooldown** that makes automations back off.

---

## Core Concepts

### Provenance Enums

Three enums track different kinds of provenance:

- **`DeviceCommandSource`** (`src/enum/deviceCommandSource.js`) — who issued an outgoing command; passed explicitly as the second argument of `receiveCommand()`:

  | Caller | Source passed | Why |
  |--------|---------------|-----|
  | Rule-based automation base (`ruleBasedAutomationBase.js`) | `AUTOMATION` | Autonomous rule/timer decision |
  | AI tool builder (`ai/toolBuilder.js`) | `HUMAN` | A person gave the AI the order |
  | Remote action routing (`device/type/remote.js`) | `HUMAN` | Physical button press |
  | Interaction targets (`interaction/container/interactionContainer.js`) | `HUMAN` | Human-configured action |

- **`DeviceStateOrigin`** (`src/enum/deviceStateOrigin.js`) — who last changed a device's *state*. Used by DeviceBase for classification and by automations to decide whether to act.
- **`AiChatMessageOrigin`** (`src/enum/aiChatMessageOrigin.js`) — authorship of chat messages (user vs system periodic service). Unrelated to device state.

Every mechanism tracks the provenance of its current state via `stateOrigin`:

| Value | Meaning |
|---|---|
| `unknown` | Initial state or after restart with no cached origin. Conservative default: do not block automation. |
| `automation` | The current state was set by an autonomous rule-engine action. |
| `human` | The current state was set by any human-directed actor (see policy above). |

**Transition rules:**

```
unknown    -- rule-engine command     --> automation   (token registered at publish time)
unknown    -- human-directed command  --> human        (immediately, at dispatch; cooldown starts)
unknown    -- unmatched MQTT change   --> human        (cooldown starts)
automation -- echo / continuation     --> automation   (confirmed own motion)
automation -- conflicting motion      --> human        (external override detected mid-travel)
automation -- stalled motion          --> human        (watchdog: presumed external stop)
automation -- unmatched MQTT change   --> human        (no live token explains it)
human      -- rule-engine command     --> automation   (new expectation replaces nothing pending)
human      -- any other input         --> human        (no change)
```

The value is persisted to Redis under `zigbeedevice:<slug>:<id>` so it survives process restarts. In-flight rule-engine expectations are additionally persisted under a dedicated marker key (`zigbeedevice:<slug>:<id>:pending`, TTL = remaining token lifetime) and restored on boot, so a restart mid-motion does not lose attribution context or the ability to detect overrides.

### CommandCorrelator (`src/device/base/deviceBase.js`)

A causality-token tracker that holds **at most one active expectation per device** — always the most recent *rule-engine* command. Human-directed commands never register tokens; they cancel the pending one instead. A live token is therefore unambiguous evidence that the current motion was started by an automation, and anything contradicting it is by definition external intervention.

`register()` captures at dispatch time: the expected state (`ON/OFF/OPEN/CLOSE/STOP/TOGGLE` or `POS:N`), its family (`instant` | `travel` | `wildcard`), the anchor position/state from cached state, and a TTL chosen by family.

`matchEcho(payload)` returns one of four verdicts:

| Verdict | Meaning | Effect |
|---|---|---|
| `echo` | Report confirms the commanded outcome (direct label, ON/OFF alias, terminal threshold, exact target, settled STOP). | Token consumed; origin kept/written as `automation`. |
| `continuation` | Report shows the commanded motion still progressing (forward step beyond jitter tolerance, slow creep toward target, or STOP inertia within drift tolerance). | Token kept alive; expiry refreshed up to `MAX_TOKEN_LIFETIME_MS`; watchdog re-armed. |
| `conflict` | Report contradicts the expectation (position reversing against travel direction, or movement beyond stop-drift tolerance after STOP). | Token discarded; caller flips origin to `human` + cooldown. |
| `null` | No live token, or the token has no opinion (jitter around a fixed point, unrelated fields). | Caller falls back to change detection (§ Message Classification Flow). |

Key properties:

- **Single active expectation**: a newer command supersedes an older one — the latest rule-engine intent defines what we expect next.
- **Position beats labels**: when both are present, positional evidence is evaluated before state-label aliases so a stale label can never paper over contradictory position data.
- **Slow-creep aware**: sub-tolerance steps that steadily approach the target count as progress, so slow shutters are not falsely flipped mid-motion.
- **One-shot wildcard**: `TOGGLE` tokens are consumed by the first report that actually differs from the pre-command snapshot; identical periodic reports do not consume them.
- **Bounded lifetime**: continuation refreshes never extend a token past `MAX_TOKEN_LIFETIME_MS` from issuance.

### Motion-Stall Watchdog

Travel commands (`OPEN`/`CLOSE`/`POS:N`) imply continued motion until their target is reached. DeviceBase arms a watchdog timer at registration and re-arms it on every `continuation`. If the timer fires while the same expectation is still unresolved — i.e., motion stopped without reaching its target — the device flips to `human` with a cooldown (presumed external stop, e.g., wall switch STOP on an unmodeled device). `STOP`, instant, and wildcard expectations do not arm the watchdog: for our own STOP command, halting *is* the expected outcome.

---

## Message Classification Flow

When an MQTT message arrives for a device, `handleMqttMessage()` first checks `shouldTrackOrigin()`: only mechanism devices participate in origin classification; sensors/remotes/bridges just refresh their cached payload (they are never automation targets, so classifying them would be noise). For tracking devices the decision tree is:

```
┌─────────────────────────────────────────────────────────────┐
│                    MQTT message received                     │
└───────────────────────┬─────────────────────────────────────┘
                        ▼
              ┌──────────────────┐
              │ shouldTrackOrigin?│
              └────┬─────────┬───┘
             NO    │         │  YES
                   ▼         ▼
        payload-only   matchEcho(payload) -> verdict
        cache update      │
                          ├── 'echo'          → keep AUTOMATION (token consumed)
                          ├── 'continuation'  → keep AUTOMATION (watchdog re-armed)
                          ├── 'conflict'      → HUMAN + cooldown (external override)
                          └── null            │
                                              ▼
                                   #didStateChange(new)?
                                    ├─ NO → periodic report: payload-only update
                                    └─ YES ─┬─ live token exists → preserve current origin
                                            └─ no live token     → HUMAN + cooldown
```

The key insight: a state change with **no** live rule-engine expectation can only have been caused by someone else. And a change that **contradicts** an active expectation is, by construction, external intervention — there is no timestamp heuristic involved anywhere.

### Position & Label Matching Semantics

| Situation | Verdict |
|---|---|
| `CLOSE` command, reported `position <= 10` or label `OFF`/`CLOSE` | `echo` (reached closed end / terminal alias) |
| `OPEN` command, reported `position >= 90` or label `ON`/`OPEN` | `echo` (reached open end / terminal alias) |
| `POS:N` command, `\|position - N\| <= 2` | `echo` (exact target reached) |
| Travel step beyond ±2% in the expected direction vs last seen point | `continuation` |
| Sub-±2% step strictly closer to the commanded end than before (slow creep) | `continuation` |
| Step beyond ±2% against the expected travel direction | `conflict` (external reversal) |
| Jitter within ±2% around a fixed point | `null` (watchdog decides if motion truly stalled) |
| `STOP` command: explicit `state='STOP'` | `echo` |
| `STOP` command: drift ≤ 5% from stop anchor | `continuation` (motor inertia); two consecutive settled reports → `echo` |
| `STOP` command: movement > 5% from stop anchor | `conflict` (something else drove it) |
| `TOGGLE`: first report differing from pre-command snapshot | `echo`; identical periodic reports do not consume |

Cold start protection: when cached state is empty (first boot or after Redis wipe), incoming data is treated as calibration — no token exists yet and origin stays `unknown`, so initial z2m advertisements are never misclassified.

---

## Human Interaction Cooldown

### Setting the Cooldown

The cooldown starts **immediately** in either of these cases:

1. A human-directed command is dispatched (`receiveCommand(cmd, HUMAN)`), even before any MQTT echo arrives — including commands suppressed by redundancy checking, since the person still expressed intent.
2. Classification flips a device to `human` (unmatched change, conflicting motion, or watchdog stall).

```javascript
CacheService.setHumanCooldown(slugify(deviceName), cooldownSeconds)
// Key: cooldown:<slug>   TTL: human_interaction_cooldown_ms (default 15 min)
```

Failures are logged loudly (warn/error): a silent miss here means automations may fight the user.

### Checking the Cooldown

Before automation dispatches commands to any device, `AutomationBase.checkAndLogHumanInteraction()` checks the Redis key. As defense in depth it also consults the live device itself: if `stateOrigin === 'human'` and `stateLastAt` falls inside the same cooldown window, the device is skipped even when Redis is unavailable. The recency bound guarantees a stale origin from long ago can never block automation forever. This replaces the old pure fail-open behavior on Redis outages.

---

## Redundant Command Suppression

Before publishing any command, `#isCommandRedundant()` compares it against cached state:

| Command Type | Suppress When |
|-------------|---------------|
| `{state: 'ON'}` | Cached `state === 'ON'` |
| `{state: 'OFF'}` | Cached `state === 'OFF'` |
| `{state: 'OPEN'}` | Cached `position >= 98` |
| `{state: 'CLOSE'}` | Cached `position <= 2` |
| `{position: N}` | `\|cachedPosition - N\| <= 2` |
| `'TOGGLE'` / `'STOP'` | Never suppressed (no deterministic target) |

When suppressed, no MQTT message is published and no token is registered; origin still reflects the provenance of the attempt — and a suppressed HUMAN command still starts the cooldown.

---

## Key Constants & Config Knobs

All durations accept human-readable strings ("30s", "25m") or plain milliseconds via `temporal.parseDurationMs()`.

| Constant / config key | Default | Purpose |
|----------|---------|---------|
| `ai_echo_window_instant_ms` (`INSTANT_ECHO_WINDOW_DEFAULT_MS`) | 15,000 ms | Token TTL for ON/OFF/TOGGLE commands. Covers delayed z2m confirmations while keeping the attribution window short. |
| `ai_echo_window_travel_ms` (`TRAVEL_ECHO_WINDOW_DEFAULT_MS`) | 90,000 ms | Token TTL for OPEN/CLOSE/POS:N/STOP. Must outlive full travel (~40-60 s); forward progress refreshes it. |
| `ai_motion_stall_timeout_ms` (`MOTION_STALL_TIMEOUT_DEFAULT_MS`) | 20,000 ms | Watchdog: no forward progress this long during commanded travel → presumed external stop. |
| `MAX_TOKEN_LIFETIME_MS` | 600,000 ms | Hard cap on token lifetime even with continuous continuation refreshes. |
| `HUMAN_INTERACTION_COOLDOWN_SECONDS` / `human_interaction_cooldown_ms` | 900 s (15 min) | Redis cooldown duration after human interaction; 0 disables entirely. |
| `POSITION_MATCH_TOLERANCE` | ±2% | Jitter tolerance for position comparisons and reversal detection. |
| `OPEN_ECHO_POSITION_MIN` / `CLOSED_ECHO_POSITION_MAX` | 90% / 10% | Terminal thresholds for echo matching. |
| `STOP_DRIFT_TOLERANCE` | 5% | Max drift from a STOP anchor still attributable to motor inertia. |
| `POSITION_NEARLY_OPEN_THRESHOLD` / `POSITION_NEARLY_CLOSED_THRESHOLD` | 98% / 2% | Redundancy-check thresholds. |
| `ILLUMINANCE_CHANGE_THRESHOLD` | 500 lux | Minimum meaningful illuminance change. |
| `TEMPERATURE_CHANGE_THRESHOLD` | 0.5°C | Minimum meaningful temperature change. |
| `HUMIDITY_CHANGE_THRESHOLD` | 1% | Minimum meaningful humidity change. |

---

## File Map

| Component | File Path |
|-----------|-----------|
| DeviceCommandSource enum | `src/enum/deviceCommandSource.js` |
| DeviceStateOrigin enum | `src/enum/deviceStateOrigin.js` |
| AiChatMessageOrigin enum | `src/enum/aiChatMessageOrigin.js` |
| DeviceBase (correlator, watchdog, classification, commands) | `src/device/base/deviceBase.js` |
| Mechanism device type (opts into origin tracking) | `src/device/type/mechanism.js` |
| Remote device type (action routing → HUMAN) | `src/device/type/remote.js` |
| AI tool builder (chat actions → HUMAN) | `src/ai/toolBuilder.js` |
| Interaction container (targets → HUMAN) | `src/interaction/container/interactionContainer.js` |
| AutomationBase (cooldown check + live-origin fallback) | `src/automation/base/automationBase.js` |
| RuleBasedAutomationBase (execute flow → AUTOMATION) | `src/automation/base/ruleBasedAutomationBase.js` |

---

## Related Documentation

| Document | Relation |
|----------|----------|
| [AI Conversation Caching](./ai-conversation-caching.md) | Sibling deep-dive: how chat history persistence interacts with message origin |
| [Configuration Guide](../configuration.md) | All config keys referenced here (`human_interaction_cooldown_ms`, echo windows, stall timeout, settle absorption, failed-command backoff) |
| [Architecture Overview](./index.md) | Project structure and core concepts |