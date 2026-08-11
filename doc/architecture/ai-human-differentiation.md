# AI vs Human Interaction Differentiation

## Overview

Roller shutters, lights, and other mechanisms are controlled over a shared MQTT bus by both the automation system and humans (physical remotes, wall switches, mobile apps). Because zigbee2mqtt publishes every state change to the same topic regardless of who caused it, the automation must distinguish its own command echoes from genuine human-initiated state changes — otherwise it will fight with the user.

This document describes the causal classification system that solves this problem using **causality tokens** (CommandCorrelator), an explicit **Origin state machine**, and a **Redis-backed cooldown**.

---

## Core Concepts

### Origin Enums

Two separate origin enums track provenance of states and messages:

- **`DeviceStateOrigin`** (`src/enum/deviceStateOrigin.js`) — Tracks who last changed a device's state (human vs automation). Used by DeviceBase for echo classification and cooldown logic.
- **`AiChatMessageOrigin`** (`src/enum/aiChatMessageOrigin.js`) — Tracks authorship of chat messages (user vs system periodic service). Used by AiAssistant for conversation caching decisions.

Every device tracks the provenance of its current state via `stateOrigin`:

| Value | Meaning |
|---|---|
| `unknown` | Initial state or after restart. Conservative default: do not block automation. |
| `automation` | The current state was set by the AI/automation system. |
| `human` | The current state was set by a human (remote, wall switch, etc.). |

**Transition rules:**

```
unknown    -- AI command     --> automation
unknown    -- human MQTT     --> human
automation -- echo matched   --> automation (no change)
automation -- human detected --> human
human      -- AI command     --> automation
human      -- human input    --> human (no change)
```

The value is persisted to Redis under `zigbeedevice:<slug>:<id>` so it survives process restarts. The correlator itself is NOT persisted because it only tracks in-flight commands.

### CommandCorrelator (`src/device/base/deviceBase.js`)

A causality-token tracker that solves the echo-vs-human problem deterministically:

1. When automation sends a command, a unique token is registered with the expected resulting state and a TTL (`AI_ECHO_WINDOW_MS = 30s`).
2. When an MQTT message arrives, `matchEcho()` checks whether its payload matches any pending token's expected state. A match = AI echo → consume the token.
3. No match + no remaining tokens = external interaction.

Key properties:
- **One-time use**: Tokens are consumed on first match.
- **TTL-based expiry**: Stale tokens auto-clean via `#expireStale()`.
- **Position-aware matching**: Handles roller shutter semantics (see §4).

---

## Message Classification Flow

When an MQTT message arrives for a device, `handleMqttMessage()` classifies it through this decision tree:

```
┌─────────────────────────────────────────────────────────────┐
│                    MQTT message received                     │
└───────────────────────┬─────────────────────────────────────┘
                         ▼
              ┌────────────────────┐
              │ matchEcho(payload) │
              └────┬───────────────┘
                   │
          ┌────────┴────────┐
          │                 │
        TRUE              FALSE
          │                 │
          ▼                 ▼
   ┌──────────────┐  ┌──────────────────────────┐
   │ AI Echo      │  │ #didStateChange(new)?     │
   │ Consume token│  └────┬──────────────────────┘
   │ Preserve     │       │
   │ origin=auto  │  ┌────┴────┐
   └──────────────┘  TRUE    FALSE
                       │         │
                       ▼         ▼
               ┌──────────────┐  ┌────────────────┐
               │ hasPending() │  │ Periodic report│
               │ AND          │  │ Ignore origin  │
               │ withinGrace? │  └────────────────┘
               └────┬─────────┘
                    │
            ┌───────┴───────┐
            YES             NO (= no pending tokens)
            │                │
            ▼                ▼
   ┌──────────────┐   ┌──────────────────┐
   │ AI           │   │ HUMAN INTERACTION│
   │ continuation │   │ origin = human   │
   │ preserve     │   │ set Redis        │
   │ origin       │   │ cooldown (15m)   │
   └──────────────┘   └──────────────────┘
```

### Classification Steps in Detail

| Step | Condition | Result | Action |
|------|-----------|--------|--------|
| 1 | `matchEcho(payload) → true` | **AI Echo** | Consume token, update state payload, preserve `origin = automation`. Do NOT update `stateLastAt` (already set when command was sent). |
| 2a | `matchEcho → false`, `#didStateChange → false` | **Periodic Report** | Update cached payload only. Origin untouched. Prevents zigbee2mqtt periodic advertisements from being misclassified. |
| 2b | `matchEcho → false`, `#didStateChange → true`, `withinGrace AND hasPendingTokens` | **AI Continuation** | Intermediate progress report from a slow-moving device during our own command travel. Preserve current origin and `stateLastAt`. |
| 2c | `matchEcho → false`, `#didStateChange → true`, `NOT withinGrace OR no pending tokens` | **Human Interaction** | Set `origin = human`, update timestamp, write Redis cooldown key (`cooldown:<slug>`, TTL 900s). Automation will skip this device for the cooldown duration. |

### The Grace Period + Token Check (Critical Fix)

The grace period (`AI_GRACE_PERIOD_MS = 90s`) exists because roller shutters take ~40-60 seconds to complete full travel, sending intermediate position reports along the way. However, checking *only* the time window creates a bug: after all correlator tokens are consumed by matched echoes, any subsequent state change — including a human pressing a remote — would be incorrectly treated as AI continuation if still within 90 seconds.

The fix adds a token-based guard: **grace period protection only applies when there are unmatched pending tokens**. Once all expected echoes have been consumed, any new state change is classified as human interaction regardless of elapsed time since the last automation command.

```typescript
const hasPendingTokens = this.#correlator.hasPending()

if (!withinGrace || !hasPendingTokens) {
    // Human interaction
} else {
    // AI continuation (within grace AND waiting for more echoes)
}
```

---

## Correlator Token Matching

`#statesMatch(expectedState, reportedState, reportedPosition)` handles multiple matching strategies:

### Direct String Match
```
Expected "ON"     matches reported state === "ON"
Expected "OFF"    matches reported state === "OFF"
Expected "STOP"   matches reported state === "STOP"
```

### Zigbee2MQTT Semantic Aliases
Roller shutters report `state: "ON"/"OFF"` instead of `"OPEN"/"CLOSE"`:
```
Expected "OPEN"  also matches reported state === "ON"
Expected "CLOSE" also matches reported state === "OFF"
```

### Position Thresholds
For end-of-travel detection on roller shutters:
```
Expected "OPEN"  matches position >= 90
Expected "CLOSE" matches position <= 10
```

### Exact Position Targets
Commands like `{ position: 30 }` create tokens with expected state `"POS:30"`:
```
Matches when |reportedPosition - targetPosition| <= POSITION_MATCH_TOLERANCE (±2)
```

### STOP Protection
A STOP token intentionally does NOT match based on position alone. This prevents a human-initiated CLOSE at position=58 from being consumed by a pending STOP token and misclassified as an AI echo. STOP only matches explicit `state = 'STOP'`.

---

## Command Pathways

### Outgoing Automation Command

```javascript
// Called from RuleBasedAutomationBase.execute() → dev.receiveCommand(payload, true)
device.receiveCommand({ position: 30 }, true);
//                                ^^^^^ fromAutomation flag
```

Flow:
1. Redundancy check against cached state — suppress if device already at target.
2. Activate grace period immediately (`#lastAiCommandAt = Date.now()`).
3. Queue MQTT publish to `zigbee2mqtt/<name>/set`.
4. **Deferred** correlator registration via `onPublish` callback — token is registered only when MqttService actually publishes the message. This eliminates the race condition where a stale token survives longer than queue latency.
5. Set `origin = automation`, persist to Redis.

### Human-Triggered Command (Remote / Interaction)

When a remote button press is detected, the Remote class routes it either through the Interaction YAML or the legacy action-map:

```javascript
// Remote.#executeAction() → mechanism.receiveCommand(state, extra)
mechanism.receiveCommand('OPEN');
// No second argument → fromAutomation defaults to false
```

Flow:
1. Same redundancy check as above.
2. Grace period NOT activated (`#lastAiCommandAt` unchanged).
3. Queue MQTT publish.
4. **No** correlator token registered in `onPublish` — echoes will be unrecognized and correctly classified as human input.
5. Set `origin = human`, persist to Redis.

The key distinction: automation commands register a correlator token; human commands do not. Incoming MQTT messages with no matching token are therefore attributed to human interaction.

---

## State Change Detection

`#didStateChange(newPayload)` compares meaningful fields against cached state with per-field tolerances:

| Field | Comparison Method | Threshold |
|-------|------------------|-----------|
| `state` | Exact string comparison | Any difference |
| `position` | Numeric absolute difference | > 2% |
| `illuminance` | Numeric absolute difference | > 500 lux |
| `temperature` | Numeric absolute difference | > 0.5°C |
| `humidity` | Numeric absolute difference | > 1% |

If none of these changed meaningfully, the message is treated as a periodic report / status advertisement rather than a state change. Origin is untouched.

Cold start protection: if cached state is empty (first boot or after Redis wipe), incoming data is treated as calibration, not a state change. This prevents zigbee2mqtt's initial reports from being misclassified as human interactions.

---

## Human Interaction Cooldown

### Setting the Cooldown

When DeviceBase classifies a message as human interaction (§3, step 2c):

```javascript
CacheService.setHumanCooldown(slugify(deviceName), HUMAN_INTERACTION_COOLDOWN_SECONDS)
// Key: cooldown:<slug>
// TTL: 900 seconds (15 minutes)
```

### Checking the Cooldown

Before automation dispatches commands to any device, `AutomationBase.checkAndLogHumanInteraction()` checks the Redis key:

```javascript
async checkAndLogHumanInteraction(device) {
    const remainingMs = await CacheService.getHumanCooldownRemaining(slugify(device.getName()))
    if (remainingMs != null && remainingMs > 0) {
        this.log(`Recent human interaction on ${device.getName()}, skipping`)
        return true // Skip this device
    }
    return false // Proceed with automation
}
```

If Redis is unavailable, the check returns `false` (allow automation to proceed) — fail-open rather than fail-closed.

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
| `'TOGGLE'` | Never suppressed (no deterministic target) |

When suppressed, origin is still updated based on `fromAutomation`, but no MQTT message is published and no correlator token is registered.

---

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `AI_ECHO_WINDOW_MS` | 30,000 ms | Correlator token TTL. Covers delayed Zigbee2MQTT confirmations (typically 500ms–3s). |
| `AI_GRACE_PERIOD_MS` | 90,000 ms | Window after AI command for continuation messages. Roller shutters take ~40-60s full travel. |
| `CORRELATOR_DEFAULT_TTL_MS` | 30,000 ms | Default expiry for tokens without explicit TTL. |
| `HUMAN_INTERACTION_COOLDOWN_SECONDS` | 900 s (15 min) | Redis cooldown duration after human interaction detected. |
| `POSITION_MATCH_TOLERANCE` | ±2% | Tolerance for exact position comparisons. |
| `POSITION_NEARLY_OPEN_THRESHOLD` | 98% | Threshold for "fully open" comparison in redundancy check. |
| `POSITION_NEARLY_CLOSED_THRESHOLD` | 2% | Threshold for "fully closed" comparison in redundancy check. |
| `ILLUMINANCE_CHANGE_THRESHOLD` | 500 lux | Minimum meaningful illuminance change. |
| `TEMPERATURE_CHANGE_THRESHOLD` | 0.5°C | Minimum meaningful temperature change. |
| `HUMIDITY_CHANGE_THRESHOLD` | 1% | Minimum meaningful humidity change. |

---

## File Map

| Component | File Path |
|-----------|-----------|
| DeviceStateOrigin enum | `src/enum/deviceStateOrigin.js` |
| AiChatMessageOrigin enum | `src/enum/aiChatMessageOrigin.js` |
| DeviceBase (correlator, classification, commands) | `src/device/base/deviceBase.js` |
| Mechanism device type | `src/device/type/mechanism.js` |
| Remote device type (action routing) | `src/device/type/remote.js` |
| AutomationBase (cooldown check) | `src/automation/base/automationBase.js` |
| RuleBasedAutomationBase (execute flow) | `src/automation/base/ruleBasedAutomationBase.js` |