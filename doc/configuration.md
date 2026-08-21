# Configuration Guide

This document provides a detailed walkthrough of every configuration file and section in Automaton. The shipped examples represent a real, working home deployment -- you will need to customize device names, network addresses, and automation rules to match your own setup.

## Configuration Hierarchy

Automaton loads configuration from multiple sources in this order:

1. **Environment variables** (`.env` file or system environment) -- service connections and secrets
2. **Main config** (`etc/automaton.yaml`) -- behavior, UI, logging, AI parameters
3. **Device definitions** (`etc/device/*.yaml`) -- what devices exist and their types
4. **Automation rules** (`etc/automation/*.yaml`) -- scheduled rule evaluations
5. **Interaction mappings** (`etc/interaction/interaction.yaml`) -- event-driven responses
6. **i18n bundles** (`etc/i18n/{locale}/*`) -- language-specific prompts and templates

---

## 1. Environment Variables (`.env`)

Copy `.env.example` to `.env` and adjust values. This file is gitignored and should never be committed.

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `MQTT_URL` | Yes | MQTT broker connection URL | `mqtt://localhost:1883` |
| `MQTT_PREFIX` | Yes | Topic prefix used by Zigbee2MQTT | `zigbee2mqtt` |
| `REDIS_URL` | Yes | Redis server connection URL | `redis://localhost:6379` |
| `AI_API_URL` | No | AI provider API base URL (OpenAI-compatible) | `http://localhost:8080/v1` |
| `AI_API_KEY` | No | AI provider API key | `sk-your-key-here` |
| `TTS_API_URL` | No | TTS server API endpoint | `http://localhost:7423/tts` |
| `TTS_TCP_ENDPOINT` | No | Audio playback destination (`ip:port`) | `192.168.1.x:12345` |

> The AI and TTS services are optional. If their URLs are not set, those features will be disabled at startup with a warning. You can also disable them per-run without touching `.env`: starting Automaton with `--no-ai` or `--no-tts` behaves exactly as if the corresponding variables were unset.

---

## 2. Main Configuration (`etc/automaton.yaml`)

This is the central configuration file. All behavioral settings live here.

### Automation Section

```yaml
# How long automations skip a device after a human manually changes it.
# Accepts a human-readable duration ("90s", "25m", "1h") or legacy plain milliseconds;
# defaults to 15 minutes when omitted. Set to 0 to disable the cooldown entirely.
human_interaction_cooldown_ms: "25m"

# Optional origin-classification tuning (all accept "30s"/"25m"-style durations).
# Uncomment to override the built-in safe defaults:
# ai_echo_window_instant_ms: "15s"   # token TTL for ON/OFF/TOGGLE commands
# ai_echo_window_travel_ms: "90s"    # token TTL for OPEN/CLOSE/POS:N/STOP travel
# ai_motion_stall_timeout_ms: "20s"  # no-progress window before assuming external stop
# ai_settle_absorb_window_ms: "10s"  # how long post-completion motor-status churn is absorbed
# ai_failed_command_backoff_ms: "10m" # retry backoff after a command produced no observable response
```

This prevents automations from overriding manual device changes within the specified cooldown window. Like `timer_interval`, the value is polymorphic: plain numbers are interpreted as milliseconds, strings use the same `<integer><unit>` grammar (`d`, `h`, `m`, `s`). The optional `ai_*` keys fine-tune origin classification — echo windows, stall watchdog, settle absorption of post-completion tails, and retry backoff for unresponsive devices; see [Automation vs Human Differentiation](architecture/automation-human-differentiation.md) for what each one controls.

### i18n Section

```yaml
ai_language: pl        # Available: pl, en
time_format: "12h"     # Display format: "12h" or "24h"
```

- **`ai_language`** -- Selects which language bundle to load from `etc/i18n/{locale}/`. This determines the system prompt language, tool descriptions, and UI greetings for the AI assistant.
- **`time_format`** -- Controls how time is displayed throughout the UI.

### TTS Configuration

TTS is configured entirely through environment variables and locale-specific i18n bundles — there is no `tts:` section in `automaton.yaml`.

- **`TTS_API_URL`** (`.env`) — TTS server API endpoint; service auto-enables when set
- **`TTS_TCP_ENDPOINT`** (`.env`) — Global audio playback destination (`ip:port`). Can also be overridden per-request via EventBus event payloads or per-locale in `etc/i18n/{locale}/tts.yaml`
- **Per-request extras** — Components emitting `tts:speak` events may attach extra TTS server parameters to individual utterances (e.g., intro/outro jingle waves); they merge into that request only, with runtime values winning over locale template defaults. Shipped example: the weatherman automation's optional `tts_options` block. See [Weather Man](examples/weatherman.md) and [TTS Integration](installation/tts-integration.md).

### AI Section

```yaml
model: your-model-name
max_tokens: -1          # -1 = unlimited (provider default)
temperature: 1.0        # 0.0 (deterministic) to 1.0 (creative)
conversation_ttl_sec: "15m"   # Conversation history TTL ("45s"/"15m"/... or legacy seconds)
max_conversation_turns: 15   # Max message turns retained in context
stupid_ai_engine: true       # Treat the model as weak -- components pre-render linguistic content instead of relying on it
```

| Setting | Description |
|---------|-------------|
| `model` | Model name sent to the LLM provider with every chat request |
| `max_tokens` | Maximum response tokens; use `-1` to omit (provider default) |
| `temperature` | Sampling temperature: lower = more deterministic, higher = more creative |
| `conversation_ttl_sec` | After this period of inactivity, conversation history is purged from Redis (accepts human-readable durations like `"15m"` or plain seconds) |
| `max_conversation_turns` | Caps the number of message turns in the context window to prevent token explosion |
| `stupid_ai_engine` | Weak-model accommodation switch (default `true`): when enabled, components simplify prompts by pre-rendering linguistic content up front -- e.g., TtsWeatherMan ships its opening time line with clock parts as plain digits (*"Jest 32 minut po godzinie 9 rano"*) instead of asking the model to spell out `{% time %}`. Set `false` only with a capable model; further small-model accommodations will hook into this flag |

**Periodic announcements:** there is no built-in periodic AI messenger -- rule-based automations fill that role instead (e.g., TtsWeatherManAutomation announces on its own timer with silence windows and day-position markers; system-originated messages still appear with a yellow `<system>` prefix and stay out of conversation caching). See [Example Automations](./examples/index.md).

### UI Section

The UI section defines the terminal interface layout, status bar widgets, and windows.

#### Status Bar

```yaml
status_bar:
  lines:
    - left:
        - type: time
          render_seconds: false
        - type: separator
          char: " |"
        - type: time_of_day
      right: []
    - left:
        - type: temp
          device: "Your Device Name"
          label: "Short Label"
          format: "{value}*C"
        # ... more widgets ...
      right:
        - [{type: state, key: "mqtt.connected", iconTrue: "[o]", iconFalse: "[x]", label: "MQTT"}]
        - [{type: state, key: "redis.connected", iconTrue: "[o]", iconFalse: "[x]", label: "Redis"}]
```

Available widget types for the status bar:

| Type | Purpose | Required Fields |
|------|---------|-----------------|
| `time` | Current clock | `render_seconds` (bool) |
| `time_of_day` | Day period label (morning/afternoon/evening/night) | none |
| `temp` | Temperature from a sensor device | `device`, `label`, `format` |
| `separator` | Visual divider | `char` |
| `state` | Boolean system state indicator | `key`, `iconTrue`, `iconFalse`, `label` |

#### Layout Settings

```yaml
layout:
  min_width: 60           # Minimum terminal width before UI clamps rendering

window_settings:
  max_buffer_lines: 2000  # Max buffered entries per window (warning: >5000 increases memory usage)
```

#### Windows

```yaml
windows:
  - id: logs
    channel: "!log"
    title: "Logs"
    shortcut: 1            # Alt+1 to switch
    readonly: true
  - id: device
    channel: "!sensors"
    title: "Devices"
    shortcut: 2
    readonly: true
  - id: ai
    channel: "#automaton"
    title: "AI Chat"
    shortcut: 3
    readonly: false        # Accepts user input
```

Each window has an IRC-style channel name, display title, keyboard shortcut (`Alt+N`), and read-only flag. The AI window must have `readonly: false` to accept chat input. The `ai` and `tts` windows are created only when their backing services are configured -- if AI or TTS is disabled/unconfigured, that window simply does not exist in the UI.

### Logger Section

```yaml
logger:
  file:
    max_size: 5242880     # 5MB in bytes
    max_files: 8
    tailable: true
  console:
    console_warn_levels: [warn]
    stderr_levels: [error]
  path:
    debug: var/log/debug.log
    warn: var/log/warn.log
    trace: var/log/trace.log
```

Uses Winston for structured logging with file rotation. Non-absolute paths are resolved relative to the project root. In addition to `debug` through `error`, a fifth **TRACE** level exists for high-volume diagnostic detail (raw MQTT payloads, per-report verdict context, token lifecycle events). TRACE entries are routed exclusively to the dedicated `trace` log file -- they never appear on the console or in the UI log window, so you can leave them on permanently without spamming the TUI. Passing `--no-trace` at startup suppresses the stream entirely (the transport is not built at all).

---

## 3. Device Definitions

### Zigbee Devices (`etc/device/zigbee.yaml`)

Lists all Zigbee devices grouped by type. Each entry is the device's **unique name** as configured in Zigbee2MQTT:

```yaml
mechanism:                # Switchable outlets, lights, roller shutters
  - Device Name One
  - Device Name Two

remote:                   # Wireless remotes and controllers
  - Remote Controller A

sensor:                   # Sensors providing readings
  - Temperature Sensor X
  - Illuminance Sensor Y
```

Device types determine behavior:
| Type | Description |
|------|-------------|
| `mechanism` | Actuator devices that can be controlled (lights, outlets, shutters) |
| `remote` | Input devices that trigger interactions (wall switches, wireless controllers) |
| `sensor` | Read-only devices providing measurements (temperature, humidity, illuminance) |

### Network Hosts (`etc/device/network.yaml`)

Defines hosts monitored for network presence detection:

```yaml
computers:
  hostname1: 192.168.1.10
  hostname2: 192.168.1.11
```

Each host is pinged via `arping` to detect presence on the local network. The short name (e.g., `hostname1`) is used as a key in automation rules.

---

## 4. Automation Rules (`etc/automation/*.yaml`)

Automations are defined as YAML files paired with optional JavaScript classes. Each `.yaml` file defines the rules; an accompanying `<Name>Automation.js` file provides custom logic extending `RuleBasedAutomationBase`.

### YAML Structure

```yaml
devices:                  # For simple automations (list of device names)
  - 'Device Name'

targets:                  # For complex automations (named target mappings)
  - name: 'Device Name A'
    id: alias_a           # Short ID used in rule actions
  - name: 'Device Name B'
    id: alias_b

sensors:                  # Sensor references for condition evaluation
  illuminance: 'Light Sensor Name'
  temperature: 'Temp Sensor Name'

triggers_zigbee:          # Zigbee topics that trigger re-evaluation
  - 'Sensor Name One'
  - 'Sensor Name Two'

triggers_network:         # Network hosts that trigger re-evaluation
  - hostname1
  - hostname2

timer_interval: "1m"       # How often to evaluate rules ("90s", "3m 45s", "1h"; legacy timer_interval_ms still works)

silence_between: "0500-0900"   # Optional: suppress execution between these local times (HHmm-HHmm format). Supports overnight ranges like "2300-0600".

rules:
  - name: 'Human-readable rule name'
    once: true                          # Optional: act at most once per calendar day
    conditions:
      time-of-day: [morning, noon]     # Day period(s)
      season: [winter]                 # Season(s), optional -- spring/summer/autumn/winter
      illuminance: { gte: 20 }          # Sensor threshold
      temperature: { lt: 25 }
      presence: hostname1               # Network host present
    targets:                            # Per-target actions when conditions match
      alias_a: OPEN                     # Named target action
      alias_b: CLOSE
```

### Timer Interval (`timer_interval`)

The optional `timer_interval` key controls how often an automation evaluates on its periodic timer. It accepts human-readable durations made of `<integer><unit>` tokens where the unit is `d` (days), `h` (hours), `m` (minutes) or `s` (seconds):

```yaml
timer_interval: "90s"     # every 90 seconds
timer_interval: "3m 45s"  # every 3 minutes 45 seconds
timer_interval: "1h"      # hourly
timer_interval: "2d 4h"   # multi-day cadences
```

- Omitting the key disables the timer entirely -- the automation becomes event-driven only (same as legacy `timer_interval_ms: 0`).
- Legacy numeric `timer_interval_ms` remains supported; when both keys are present, `timer_interval` wins.
- Invalid values log a warning and disable the timer (fail-open). Values above ~24.8 days (the 32-bit `setInterval` limit) are rejected for the same reason.

### Silence Periods (`silence_between`)

The optional `silence_between` key defines a time window during which an automation's `execute()` call is suppressed entirely. It applies per-automation file — each `.yaml` can have its own independent schedule.

```yaml
silence_between: "HHmm-HHmm"   # e.g., "0500-0900" or overnight "2300-0600"
```

#### Format

Times use compact four-digit **NATO-style** notation without separators: hours followed by minutes. A dash separates start from end.

| Example | Meaning |
|---------|---------|
| `"0500-0900"` | Suppress from 5:00 AM until 8:59 AM |
| `"2300-0600"` | Suppress from 11:00 PM through midnight into 5:59 AM next day |
| `"0730-0815"` | Suppress from 7:30 AM to 8:14 AM |

Start time is **inclusive** (execution at exactly that minute is blocked). End time is **exclusive** (execution resumes at the end boundary).

#### Scope

Silence suppression blocks **all trigger sources**, not just timer ticks. If a zigbee sensor fires an MQTT event or a network host comes online during the silent window, the automation will still be suppressed and log `Suppressed during silent period` at debug level. This differs from setting `timer_interval_ms: 0`, which only disables periodic execution while leaving event-driven triggers active.

#### Error Handling

Invalid formats produce a one-time warning in logs and fall through to normal behavior (fail-open). Examples of invalid input treated as "no silence":

- `"05:00-09:00"` — colons instead of compact digits
- `"50-90"` — too few characters
- `null` / number / non-string type
- `"1200-1200"` — start equals end (treated as no-op)

If omitted entirely, automations run normally with no silence period applied.

### Condition Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `lt` | Less than | `{ lt: 25 }` |
| `lte` | Less than or equal | `{ lte: 25 }` |
| `gt` | Greater than | `{ gt: 25 }` |
| `gte` | Greater than or equal | `{ gte: 25 }` |

Multiple operators on the same field create a range: `{ gt: 1800, lte: 11000 }`.

### Daily Once Markers (`once`)

Adding `once: true` to a rule makes it act **at most once per local calendar day**. When its conditions first match and commands are dispatched -- or every targeted device is deferred due to recent human interaction -- the rule records a daily marker in Redis and stands down for the rest of that day; humans then have full control until the next window opens. If nothing happened at all (no dispatches, no deferrals), the rule keeps retrying on later ticks. The marker stores the local date and self-resets each day without cleanup logic; storage failures fail open so an unavailable cache never blocks automation.

### Season Conditions

The optional `season` condition restricts a rule to specific meteorological seasons:

| Value | Months |
|-------|--------|
| `spring` | March - May |
| `summer` | June - August |
| `autumn` | September - November |
| `winter` | December - February |

Accepts a single value or a list: `season: spring`, `season: [winter]`. Detection lives in `src/lib/date.js` (`getCurrentSeason()`), consistent with the existing season predicates.

### Target Actions

- **Mechanisms** (lights/outlets): `ON`, `OFF`, `TOGGLE`
- **Mechanisms** (roller shutters): `OPEN`, `CLOSE`, `STOP`, or integer percentage (`0-100`)
- **Simple automations**: `action: OFF` applies to all listed devices

### Custom JavaScript Automations

Create `<Name>Automation.js` in `etc/automation/` alongside your YAML. The autoloader expects PascalCase naming matching the YAML filename prefix:

```
bedroom-rollers.yaml -> bedroomRollersAutomation.js
ambient-lights.yaml -> ambientLightsAutomation.js
```

Extend `RuleBasedAutomationBase` and override methods as needed. See existing examples for reference.

---

## 5. Interactions (`etc/interaction/interaction.yaml`)

Interactions define event-driven responses to Zigbee remote actions (button presses). They are triggered when a remote device sends an action message via MQTT.

### Structure

```yaml
interactions:
  - name: 'remote_identifier'       # Matches Zigbee2MQTT action topic
    actions:
      - type: 'single'               # Action type (e.g., single click)
        targets:                     # Direct device commands
          - device: 'Device Name'
            command: 'TOGGLE'
        calls: 'customInteraction'   # Optional: delegate to JS interaction
```

### Action Types

| Type | Description |
|------|-------------|
| `targets` | Array of `{device, command}` objects -- direct device control |
| `calls` | String referencing a custom JavaScript interaction class |

Both can be combined in a single action entry. The `targets` execute first, then the `calls` delegation runs.

### Custom JavaScript Interactions

Create `<Name>Interaction.js` in `etc/interaction/`. Extend `InteractionBase` and implement custom logic. The autoloader uses the same PascalCase naming convention as automations.

---

## 6. i18n Bundles

Language bundles live in `etc/i18n/{locale}/` where `{locale}` matches BCP 47 tags (`en_US`, `pl_PL`, etc.). Each locale contains two files:

### AI Bundle (`ai.yaml`)

Defines the system prompt sent to the LLM, tool descriptions, device role annotations, and UI messages:

```yaml
system_prompt: |
  Your system prompt text here...

sections:
  devices_header: "=== AVAILABLE DEVICES ==="
  device_instruction: 'Mappings (device_name -> function):'

devices:
  mechanism:                     # Only non-obvious name->function mappings
    "Device Name": "human description"

tools:
  set_device_state:
    description: "Change device state..."
    parameters:
      device_name: 'Description...'
      action: "Available actions..."

get_device_state:
  description: "Check device state..."
  parameters:
    device_name: "Device to check."

formatting:
  decimal_separator: ","         # Locale-specific number formatting
  thousand_separator: " "

periodic:
  message: "What is the temperature and humidity outside?..."  # Periodic prompt sent at configured intervals

ui:
  default_greeting: "Hello! How can I help?"
```

> The `devices.mechanism` section only needs entries for devices with **non-obvious** names. A device named "Kitchen Light" doesn't need an annotation, but a socket named "Patio Outlet" powering the garden light strip does.

### TTS Bundle (`tts.yaml`)

Defines voice model settings and audio effects per locale. Referenced by the TTS service when generating speech output.

---

## Adding a New Language

1. Create a new directory: `etc/i18n/{locale}/`
2. Copy and translate `ai.yaml` from an existing bundle
3. Create `tts.yaml` with appropriate voice model settings
4. Set `ai_language` in `etc/automaton.yaml` to your locale's language code (e.g., `de` for German)

---

## Troubleshooting

### Configuration validation errors

Automaton validates `etc/automaton.yaml` against a schema at startup. If a required key is missing or has the wrong type, you'll see a descriptive error listing each problem. Check the console output or `var/log/debug.log`.

### Device not found

Ensure every device name in your automations and interactions exactly matches the name configured in Zigbee2MQTT. Names are case-sensitive.

### Automation never triggers

Verify that:
- The `timer_interval_ms` is reasonable (not too high)
- At least one trigger topic matches active MQTT topics
- Conditions use correct operator syntax (`lt`, `lte`, `gt`, `gte`)
- Network presence hosts in `triggers_network` match keys in `etc/device/network.yaml`

### AI doesn't recognize devices

Check that your `etc/i18n/{locale}/ai.yaml` includes device annotations for any non-obvious device names. The AI uses these mappings to understand which device does what.

---

→ [Documentation Home](./index.md) · See also: [Architecture Overview](architecture/index.md) · [Example Automations](examples/index.md)