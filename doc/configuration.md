# Configuration Guide

A detailed walkthrough of every configuration file and section in Automaton. The shipped templates represent a real, working home deployment -- customize device names, network addresses, and automation rules to match your own setup.

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

> The AI and TTS services are optional — unset URLs disable those features at startup with a warning. The `--no-ai` / `--no-tts` startup flags disable them per-run without touching `.env`.

### Overriding settings from the command line

Any parameter of `etc/automaton.yaml` can be overridden for a single run using the repeatable `-c` / `--config-override` flag; values are interpreted as YAML and go through the same strict schema validation as the file itself (an unknown key or wrong type aborts startup):

```bash
sh bin/automaton -c "locale.language: en_US" -c "ai.temperature: 0.7"
```

---

## 2. Main Configuration (`etc/automaton.yaml`)

This is the central configuration file. All behavioral settings live here.

### Automation Section

```yaml
# How long automations skip a device after a human manually changes it.
# Accepts a duration ("90s", "25m", "1h") or legacy plain ms; default 15 min when omitted.
# Set to 0 to disable the cooldown entirely.
automation:
  human_interaction_cooldown_ms: "25m"
  # Optional origin-classification tuning (durations). Uncomment to override built-in defaults:
  # echo_window_instant_ms: "15s"    # token TTL for ON/OFF/TOGGLE commands
  # echo_window_travel_ms: "90s"     # token TTL for OPEN/CLOSE/POS:N/STOP travel
  # motion_stall_timeout_ms: "20s"   # no-progress window before assuming external stop
  # settle_absorb_window_ms: "10s"   # post-completion motor-status churn absorption
  # travel_echo_grace_ms: "2s"       # pre-motion near-target grace window
  # failed_command_backoff_ms: "10m" # retry backoff after an unresponsive command
```

This prevents automations from overriding manual device changes within the specified cooldown window. Like `timer_interval`, the value is polymorphic: plain numbers are milliseconds, strings use the `<integer><unit>` grammar (`d`, `h`, `m`, `s`). The optional origin-classification tuning keys fine-tune origin classification -- see [Automation vs Human Differentiation](architecture/automation-human-differentiation.md) for what each one controls.

### Locale Section

```yaml
locale:
  language: pl_PL      # Full BCP 47 code == dir under etc/i18n/. Available: pl_PL, en_US
  time_format: "12h"   # Display format: "12h" or "24h"
```

- **`locale.language`** -- Full BCP 47 locale code selecting the bundle directory under `etc/i18n/{code}/`. Determines the system prompt language, tool descriptions, UI greetings AND the TTS voice model/effects. Does NOT change the app/UI interface language.
- **`locale.time_format`** -- How time is displayed throughout the UI (`"12h"` or `"24h"`).

### TTS Configuration

TTS is configured entirely through environment variables and locale-specific i18n bundles — there is no `tts:` section in `automaton.yaml`.

- **`TTS_API_URL`** (`.env`) — TTS server API endpoint; service auto-enables when set
- **`TTS_TCP_ENDPOINT`** (`.env`) — Global audio playback destination (`ip:port`). Can also be overridden per-request via EventBus event payloads or per-locale in `etc/i18n/{locale}/tts.yaml`
- **Per-request extras** — Components emitting `tts:speak` events may attach extra TTS server parameters to individual utterances (e.g., intro/outro jingle waves); they merge into that request only, with runtime values winning over locale template defaults. Shipped example: the weatherman automation's optional `tts_options` block. See [Weather Man](automations/weatherman.md) and [TTS Integration](installation/tts-integration.md).

### AI Section

```yaml
ai:
  model: your-model-name
  max_tokens: -1              # -1 = unlimited (provider default)
  temperature: 1.0            # 0.0 (deterministic) to 1.0 (creative)
  fetch_timeout_ms: "5m"      # Per-request LLM HTTP timeout ("45s"/"5m"/... or plain ms); final, not retried
  conversation_ttl_sec: "15m" # Conversation history TTL in Redis ("45s"/"15m"/... or legacy seconds)
  max_conversation_turns: 15  # Max message turns retained in context (prevents token explosion)
  strip_ai_formatting: false  # Strip markdown/emoji from responses before UI/TTS
  include_chat_history_in_system_calls: false  # System-origin turns (announcements) receive prior chat history; false = standalone [default]
```

**Periodic announcements:** there is no built-in periodic AI messenger -- rule-based automations fill that role instead (see [Automations](./automations/index.md); how system-originated announcements stay out of conversation caching is covered in [AI Conversation Caching](architecture/ai-conversation-caching.md)).

### UI Section

The UI section defines the terminal interface layout, status bar widgets, and windows.

#### Status Bar

```yaml
ui:
  status_bar:
    lines:
      - left:
          - type: time
            render_seconds: false
          - type: separator
            char: " |"
          - type: temp
            device: "Your Device Name"
            label: "Short Label"
            format: "{value}*C"
        right:
          - [{type: state, key: "mqtt.connected", iconTrue: "[o]", iconFalse: "[x]", label: "MQTT"}]
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
ui:
  layout:
    min_width: 60           # below this terminal width the UI shows a resize warning instead of rendering
  window_settings:
    max_buffer_lines: 2000  # per-window buffer cap (warning: >5000 raises memory/crash risk)
```

#### Windows

```yaml
ui:
  windows:
    - id: logs
      channel: "!log"
      title: "Logs"
      shortcut: 1            # Alt+1 to switch
      readonly: true
    - id: ai
      channel: "#automaton"
      title: "AI Chat"
      shortcut: 3
      readonly: false        # Accepts user input
    # ... device (!sensors) and tts (#tts) windows follow the same shape
```

Each window has an IRC-style channel name, display title, keyboard shortcut (`Alt+N`), and read-only flag. The AI window must have `readonly: false` to accept chat input. The `ai` and `tts` windows exist only when their backing services are configured.

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

Uses Winston for structured logging with file rotation; non-absolute paths resolve relative to the project root. A fifth **TRACE** level (raw MQTT payloads, token lifecycle events) routes exclusively to the dedicated `trace` log file -- never to the console or UI log window. Passing `--no-trace` at startup suppresses the stream entirely.

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

Each host is pinged via `arping` to detect presence on the local network. The short name (e.g., `hostname1`) is used as a key in automation rules. Sweep mechanics and the `presence` condition are covered in [Network Presence Monitor](monitors/network-presence.md).

#### Video Players (`videoPlayers`)

Polls media players over their HTTP APIs and exposes a normalized status (`playing`, `paused`, `stopped`, `unreachable`) to rules via the `videoPlayer` condition. Each entry is an object -- **not** a bare IP string -- so the presence monitor does not treat it as a ping target:

```yaml
videoPlayers:
  hostname1:
    port: 8080
    path: /requests/status.json
    parser: vlc
  hostname2:
    port: 13579
    path: /variables.html
    parser: mpc
```

Each player's IP resolves from the same-named `computers` entry; an optional `host` key overrides that lookup, and a player with neither is skipped with an error log.

| `parser` | Player | Endpoint |
|----------|--------|----------|
| `vlc` | VLC HTTP interface | `/requests/status.json` (JSON) |
| `mpc` | MPC-HC web interface | `/variables.html` (HTML) |

Optional per-player keys: `username` / `password` (VLC basic auth) and `timeout_ms` (default 500 ms). Player-side setup (MPC-HC web interface, VLC Lua HTTP password), polling mechanics, and the `videoPlayer:<host>` status events are covered in [Video Player Monitor](monitors/video-player.md); subscribe automations to status changes via `triggers_video`.

---

## 4. Automation Rules (`etc/automation/*.yaml`)

Automations are YAML files paired with optional JavaScript classes: the `.yaml` defines the rules, an accompanying `<Name>Automation.js` provides custom logic extending `RuleBasedAutomationBase`. Working examples are documented in [Automations](automations/index.md).

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

videoPlayer_suppression:       # Optional: stand-down guard -- suppress all rules while any listed
  hostname1: [playing, paused, stopped]   # player is in one of the listed statuses (OR across hosts)

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
timer_interval: "90s"      # every 90 seconds
timer_interval: "3m 45s"   # tokens combine: every 3 minutes 45 seconds
```

- Omitting the key disables the timer entirely -- the automation becomes event-driven only. Legacy numeric `timer_interval_ms` remains supported; when both keys are present, `timer_interval` wins.
- Invalid values log a warning and disable the timer (fail-open). Values above ~24.8 days (the 32-bit `setInterval` limit) are rejected.

### Silence Periods (`silence_between`)

The optional `silence_between` key defines a time window during which an automation's `execute()` call is suppressed entirely. It applies per-automation file — each `.yaml` can have its own independent schedule.

```yaml
silence_between: "HHmm-HHmm"   # e.g., "0500-0900" or overnight "2300-0600"
```

Times use compact four-digit **NATO-style** notation (hours then minutes, no separators):

| Example | Meaning |
|---------|---------|
| `"0500-0900"` | Suppress from 5:00 AM until 8:59 AM |
| `"2300-0600"` | Suppress from 11:00 PM through midnight into 5:59 AM next day |

Start time is **inclusive**, end time **exclusive**. Suppression blocks **all trigger sources**, not just timer ticks — unlike omitting `timer_interval`, which only disables the periodic timer while leaving event-driven triggers active. Invalid formats warn once and fall through to normal behavior (fail-open); if omitted, no silence period applies.

### Condition Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `lt` | Less than | `{ lt: 25 }` |
| `lte` | Less than or equal | `{ lte: 25 }` |
| `gt` | Greater than | `{ gt: 25 }` |
| `gte` | Greater than or equal | `{ gte: 25 }` |

Multiple operators on the same field create a range: `{ gt: 1800, lte: 11000 }`.

### Video Player Conditions

The optional `videoPlayer` condition gates a rule on media-player status (see `videoPlayers` under Network Hosts). Values accept a single status or a list per host:

```yaml
conditions:
  videoPlayer:
    hostname1: [paused, stopped, unreachable]   # "not actively playing"
    hostname2: playing                          # single value shorthand
```

An **unknown** player status (host offline or not yet polled) matches ONLY condition lists that explicitly include the `unknown` token -- each rule decides whether an unknown state is safe to act on (e.g. ambient-restore rules opt in with `[paused, stopped, unreachable, unknown]`; ownership hand-back guards use `[unknown, unreachable]`). `triggers_video: [<host>, ...]` subscribes the automation to status-change events so rules re-evaluate immediately.

### Video Player Suppression (`videoPlayer_suppression`)

The optional top-level `videoPlayer_suppression` key is an automation-wide **stand-down guard** with inverted semantics: instead of listing statuses a rule requires, it lists statuses that make the whole automation stand down. While **any** listed host (OR across hosts) reports one of its listed statuses, `execute()` suppresses the automation -- typically so it does not fight the [Home Theater Mode](automations/home-theater-mode.md) automation over the same devices while a movie runs:

```yaml
videoPlayer_suppression:
  htpc: [playing, paused, stopped]   # stand down while actively playing
```

- Statuses use the same vocabulary as the `videoPlayer` condition; a null (unknown) status maps to the explicit `unknown` token, so it suppresses only when listed.
- Individual rules may opt out with `ignore_videoPlayer_suppression: true`. While the guard is active, only exempt rules are evaluated; when no rule opts out, the automation returns early without even building context.
- Unlike `silence_between`, the guard is **never bypassed by `/automation force`** -- a forced run must not create device fights.
- The per-rule `videoPlayer` condition remains the tool for rules that need to *distinguish* player states (e.g. Home Theater Mode's ownership hand-back); the suppression key only replaces the repetitive "not actively playing" allow-list guard duplicated across rules.

With `restore_state_aware: true` (automation level), restore commands are filtered through pre-command snapshots so an automation only undoes changes it made itself; a rule can mark its targets as unconditional with `force_restore: true`. Full snapshot, ownership, and no-op suppression semantics are covered in [Rule Engine Restore & Ownership](architecture/rule-engine-restore-semantics.md).

### Daily Once Markers (`once`)

Adding `once: true` to a rule makes it act **at most once per local calendar day**. When its conditions first match and commands are dispatched -- or every targeted device is deferred due to recent human interaction -- the rule records a daily marker in Redis and stands down for the rest of that day; humans then have full control until the next window opens. If nothing happened at all (no dispatches, no deferrals), the rule keeps retrying on later ticks. The marker self-resets each day; storage failures fail open.

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

Create `<Name>Automation.js` in `etc/automation/` alongside your YAML, extending `RuleBasedAutomationBase` and overriding methods as needed. The autoloader expects PascalCase naming matching the YAML filename prefix (`bedroom-rollers.yaml` → `bedroomRollersAutomation.js`). See the [Automations](automations/index.md) section for working examples.

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

Both can be combined in a single action entry; `targets` execute first, then the `calls` delegation runs.

### Custom JavaScript Interactions

Create `<Name>Interaction.js` in `etc/interaction/`, extending `InteractionBase`. The autoloader uses the same PascalCase naming convention as automations.

---

## 6. i18n Bundles

Language bundles live in `etc/i18n/{locale}/` where `{locale}` matches BCP 47 tags (`en_US`, `pl_PL`, etc.). Each locale contains an AI bundle, a TTS bundle, and (for the weatherman automation) a speech bundle plus a date bundle:

### AI Bundle (`ai.yaml`)

Defines the system prompt sent to the LLM, tool descriptions, device role annotations, and UI messages:

```yaml
system_prompt: |
  Your system prompt text here...

sections:                  # Strings framing the device list in the prompt
  devices_header: "=== AVAILABLE DEVICES ==="
  device_instruction: 'Mappings (device_name -> function):'

devices:
  mechanism:               # Only non-obvious name->function mappings
    "Device Name": "human description"

tools:                     # LLM tool descriptions and their parameter docs
  set_device_state: { description: "Change device state...", parameters: { device_name: 'Description...', action: "Available actions..." } }
  get_device_state: { description: "Check device state...", parameters: { device_name: "Device to check." } }

formatting:                # Locale-specific number formatting
  decimal_separator: ","
  thousand_separator: " "

periodic:
  message: "What is the temperature and humidity outside?..."  # Periodic prompt sent at configured intervals

ui:
  default_greeting: "Hello! How can I help?"
```

> The `devices.mechanism` section only needs entries for devices with **non-obvious** names. A device named "Kitchen Light" doesn't need an annotation, but a socket named "Patio Outlet" powering the garden light strip does.

### TTS Bundle (`tts.yaml`)

Defines voice model settings and audio effects per locale. Referenced by the TTS service when generating speech output.

### Date Bundle (`date.yaml`)

Owned by the date helper (`src/lib/date.js`): localized day-of-week and month names, the `date_sentence` fragment, `period_words` for `{% time_of_day %}`, and `duration_units` for `{% next_interval %}` -- the vocabulary behind [Weatherman Speech Rendering](architecture/weatherman-speech-rendering.md). A system file (force-tracked in git, no `.dist` template), not a user-customizable speech template.

---

## Adding a New Language

1. Create a new directory: `etc/i18n/{locale}/`
2. Copy and translate `ai.yaml` from an existing bundle
3. Create `tts.yaml` with appropriate voice model settings
4. If you use the weatherman automation, copy and translate `weatherman.yaml` and `date.yaml` (the date bundle holds day/month names, period words, and duration units)
5. Set `locale.language` in `etc/automaton.yaml` to your full locale code (e.g., `de_DE` for German)

---

## Troubleshooting

### Configuration validation errors

`etc/automaton.yaml` is validated against a schema at startup; a missing key or wrong type produces a descriptive error listing each problem (check the console or `var/log/debug.log`).

### Device not found

Device names in automations and interactions must exactly match the name configured in Zigbee2MQTT — names are case-sensitive.

### Automation never triggers

Verify that `timer_interval` is reasonable, at least one trigger topic matches active MQTT topics, conditions use correct operator syntax (`lt`, `lte`, `gt`, `gte`), and `triggers_network` hosts match keys in `etc/device/network.yaml`.

### AI doesn't recognize devices

Add annotations for non-obvious device names to `devices.mechanism` in `etc/i18n/{locale}/ai.yaml` — the AI uses these mappings to understand which device does what.

---

→ [Documentation Home](./index.md) · See also: [Architecture Overview](architecture/index.md) · [Automations](automations/index.md) · [Monitors](monitors/index.md)