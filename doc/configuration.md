# Configuration Guide

Configuration files, keys, and examples. Copy `.dist` templates to active names and set your own devices, hosts, and thresholds.

## Configuration Hierarchy

Automaton loads configuration from multiple sources in this order:

1. **Environment variables** (`.env` file or system environment) -- service connections and secrets
2. **Main config** (`etc/automaton.yaml`) -- behavior, UI, logging, AI parameters
3. **Device definitions** (`etc/device/*.yaml`) -- what devices exist and their types
4. **Automation rules** (`etc/automation/*.yaml`) -- scheduled rule evaluations
5. **Sequence definitions** (`etc/sequence/sequences.yaml`) -- ordered device choreography with optional loops
6. **Interaction mappings** (`etc/interaction/interaction.yaml`) -- event-driven responses
7. **i18n bundles** (`etc/i18n/{locale}/*`) -- language-specific prompts and templates

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
| `SMTP_HOST` | No | Mail relay hostname for notification emails; **unset disables the whole email channel** | `smtp.example.com` |
| `SMTP_PORT` | No | Mail relay port (default `465`) | `465` |
| `SMTP_SECURE` | No | `true` (TLS) or `false` (plain); default `true` | `true` |
| `SMTP_USER` | No | Relay login address; also the sender fallback when `email.from` is empty | `automaton@example.com` |
| `SMTP_PASS` | No | Relay login password | `…` |

AI, TTS, and email are optional. Unset their connection variables or use `--no-ai`, `--no-tts`, or `--no-email`. Email behavior and recipients live in the main config; see [Email Notifications](services/email.md).

### Overriding settings from the command line

Use repeatable `-c` / `--config-override` options for per-run main-config overrides. Values use YAML syntax; unknown keys and invalid types abort startup.

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
  human_interaction_cooldown: "25m"
  # Optional origin-classification tuning (durations). Uncomment to override built-in defaults:
  # echo_window_instant: "15s"    # token TTL for ON/OFF/TOGGLE commands
  # echo_window_travel: "90s"     # token TTL for OPEN/CLOSE/POS:N/STOP travel
  # motion_stall_timeout: "20s"   # no-progress window before assuming external stop
  # settle_absorb_window: "10s"   # post-completion motor-status churn absorption
  # travel_echo_grace: "2s"       # pre-motion near-target grace window
  # failed_command_backoff: "10m" # retry backoff after an unresponsive command
```

During the cooldown, automations skip manually changed devices. Numbers are milliseconds; duration strings accept `d`, `h`, `m`, and `s`. See [origin classification](architecture/automation-human-differentiation.md) for the tuning keys.

### Locale Section

```yaml
locale:
  language: pl_PL      # Full BCP 47 code == dir under etc/i18n/. Available: pl_PL, en_US
  time_format: "12h"   # Display format: "12h" or "24h"
```

- **`locale.language`** -- Full BCP 47 locale code selecting the bundle directory under `etc/i18n/{code}/`. Determines the system prompt language, tool descriptions, UI greetings AND the TTS voice model/effects. Does NOT change the app/UI interface language.
- **`locale.time_format`** -- How time is displayed throughout the UI (`"12h"` or `"24h"`).

### Geolocation (under `locale`)

Solar conditions use observer coordinates under `locale`:

```yaml
locale:
  geo_latitude: 52.2307   # WGS84 decimal degrees; positive = north (-90..90)
  geo_longitude: 21.0122  # WGS84 decimal degrees; positive = east  (-180..180)
```

- **`locale.geo_latitude`** / **`locale.geo_longitude`** -- Your site's position (decimal degrees, WGS84). Both are optional numbers; missing/invalid coordinates leave solar gates unresolvable so they fail closed. `sunrise-sunset-js` computes civil dawn and actual sunset for these gates; raw sunrise/sunset are also available through `getSunriseSunset()`.

### TTS Configuration

TTS is configured entirely through environment variables and locale-specific i18n bundles — there is no `tts:` section in `automaton.yaml`.

- **`TTS_API_URL`** (`.env`) — TTS server API endpoint; service auto-enables when set
- **`TTS_TCP_ENDPOINT`** (`.env`) — Global audio playback destination (`ip:port`). Can also be overridden per-request via EventBus event payloads or per-locale in `etc/i18n/{locale}/tts.yaml`
- **Per-request extras** — `tts:speak` payloads override locale defaults for that utterance. `tts_profile` selects a locale framing profile; `tts_options` overrides its fields. See [TTS Integration](installation/tts-integration.md).

### AI Section

```yaml
ai:
  model: your-model-name
  name: Automaton             # Assistant's own name: fills {% name %} in the system prompt, signs the AI window; blank = "AI"
  max_tokens: -1              # -1 = unlimited (provider default)
  temperature: 1.0            # 0.0 (deterministic) to 1.0 (creative)
  fetch_timeout: "5m"      # Per-request LLM HTTP timeout ("45s"/"5m"/... or plain ms); final, not retried
  conversation_ttl: "15m" # Conversation history TTL; bare numbers are milliseconds
  max_conversation_turns: 15  # Max message turns retained in context (prevents token explosion)
  strip_ai_formatting: false  # Strip markdown/emoji from responses before UI/TTS
  include_chat_history_in_system_calls: false  # System-origin turns (announcements) receive prior chat history; false = standalone [default]
```

**Periodic announcements:** configured by individual [automations](./automations/index.md). Their AI turns do not persist; see [AI Conversation Caching](architecture/ai-conversation-caching.md).

### Email Section

Email sends grouped frozen-sensor detections from the [Frozen Sensor Monitor](monitors/frozen-sensors.md). Configure `SMTP_*` in `.env`, behavior under `email`, and recipients under top-level `house_owners`.

```yaml
house_owners:                     # who gets the mail
  - name: 'Anna'
    email: 'anna@example.com'

email:
  enabled: true                   # false disables the channel even with a relay set
  from: ''                        # sender address; falls back to SMTP_USER when empty
  subject_prefix: 'Automaton'     # prepended to every subject: "Automaton: <subject>"
  cooldown: "60m"              # per-kind silence after one notification; 0 = mail every event
  notify:                        # per-kind switches; a kind set to false never mails
    sensor_frozen: true
```

- **`house_owners`** — list of `{ name, email }` (a bare address string is also accepted). Entries without a well-formed address are dropped; a missing name falls back to the local part of the address.
- **`email.enabled`** — master switch. `false` disables the channel even when `SMTP_HOST` is set.
- **`email.from`** — sender address; empty falls back to `SMTP_USER`.
- **`email.subject_prefix`** — prepended to every subject; empty string drops it.
- **`email.cooldown`** — per-kind re-notification window; `0` mails every event.
- **`email.notify`** — map of kind → boolean; a kind set to `false` is muted, a kind with no entry is allowed.

Templates live in `etc/i18n/<locale>/email.yaml`. Email is independent of TTS availability and speech silence. See [Email Notifications](services/email.md).

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
    min_width: 74           # below this terminal width the UI shows a resize warning instead of rendering
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
    - id: rules
      channel: "!rules"
      title: "Rules"
      shortcut: 5
      readonly: true         # Read-only: the automation call boxes are written by the automations
```

Windows have a channel, title, `Alt+N` shortcut, and input flag. AI chat requires `readonly: false`. AI and TTS windows appear only when configured; the rules window shows recent automation calls. See [Terminal UI](ui/index.md).

```yaml
ui:
  tts_profile: ''            # Optional: framing profile for text typed into the TTS speak window
```

`ui.tts_profile` selects a locale TTS framing profile for typed speech; empty means no jingle.

### AI MQTT Bridge

The MQTT bridge belongs to the AI settings:

```yaml
ai:
  bridge:
    enabled: true
    topic_base: "automaton/ai"
    forward_events: true
```

### Duration Names and Migration

Application duration keys use unit-free names. Values accept strings such as `"90s"`,
`"3m 45s"` and `"1h"`, or numbers measured in **milliseconds**, including
`ai.conversation_ttl`. Redis's seconds-only TTL API is handled internally (rounded
up to a whole second). Existing per-setting zero/disabled/default behavior still
applies. Low-level numeric JavaScript APIs and database timestamp columns retain
explicit units; TTS server framing fields retain their documented protocol units.

| Former file key | Canonical key |
|-----------------|---------------|
| `ai_bridge.*` | `ai.bridge.*` |
| `ai.fetch_timeout_ms` | `ai.fetch_timeout` |
| `ai.conversation_ttl_sec` | `ai.conversation_ttl` |
| `automation.human_interaction_cooldown_ms` | `automation.human_interaction_cooldown` |
| `automation.echo_window_instant_ms` / `echo_window_travel_ms` | Same names without `_ms` |
| `automation.motion_stall_timeout_ms` / `settle_absorb_window_ms` | Same names without `_ms` |
| `automation.travel_echo_grace_ms` / `failed_command_backoff_ms` | Same names without `_ms` |
| `email.cooldown_ms` | `email.cooldown` |
| `alerts.zigbee_offline_cooldown_ms` / `network_offline_cooldown_ms` | Same names without `_ms` |
| `alerts.network_offline_devices.<host>.cooldown_ms` | `...cooldown` |
| Player `timeout_ms` | `timeout` (also accepts duration strings) |
| Sequence/step `delay_ms` | `delay` |
| Sequence loop `off_delay_ms` / `on_delay_ms` | `off_delay` / `on_delay` |
| Automation `timer_interval_ms` | `timer_interval` (also accepts numeric milliseconds) |

Known former names are normalized **when YAML files load**, including reloads.
If both names exist, the canonical value wins, including zero and false values.
The old bridge block can supply fields missing from a partial `ai.bridge` block.
Unknown user data and raw device command payloads are never renamed.

Numeric values under the former `conversation_ttl_sec` key retain their old
seconds meaning: `900` becomes canonical `900000` milliseconds. Duration strings
such as `"15m"` retain their meaning. Prefer explicit duration strings when editing
files. Public schemas, `/config` commands and CLI override paths use the canonical
names; custom scripts reading ConfigService keys should use those names too.


### Numeric Sensor History

`sensor_history` in the main configuration controls event-driven numeric recording:
`enabled` (default true), `properties` (default temperature/humidity/pressure), and
`retention` (default seven days). SQLite samples are independent of transition
history and frozen-sensor incident state. WeatherMan's own `history` block controls
comparison windows and coverage. See [Historical trends](automations/weatherman.md#historical-trends).

### Alerts Section

Independent freeze detection is configured under `alerts.frozen_sensors`. See
[Frozen Sensor Monitor](monitors/frozen-sensors.md) for the device map, 24-hour
unchanged threshold, 15-minute grouped reminders, initial email and quiet hours.


Spoken warnings for notable system events -- Zigbee devices leaving the mesh and mission-critical LAN hosts dropping offline. Every key is read per event, so `/config reload` applies changes without a restart.

```yaml
alerts:
  zigbee_offline_tts: true            # master switch (default ON)
  zigbee_offline_cooldown: "30m"   # per-device re-warning window ("90s"/"15m"/plain ms; 0 disables)
  zigbee_offline_ignore: []           # device names never announced
  zigbee_offline_tts_profile: ''      # framing profile from the locale tts.yaml profiles: registry
  # zigbee_offline_tts_options: { intro: 'alarm.wav' }   # explicit framing, wins over the profile

  network_offline_tts: true
  network_offline_cooldown: "30m"
  network_offline_ignore: []
  network_offline_tts_profile: ''
  network_offline_announce_boot: true       # announce hosts already down at startup
  network_offline_announce_recovery: false  # speak the way back (opt-in)
  network_offline_devices:                  # allow-list; names from etc/device/network.yaml
    core-server:                            # null = family defaults
    wifi-router: { cooldown: "5m", tts_profile: 'alarm' }   # per-host overrides
```

Sentences live in the locale's `alerts.yaml` bundle. Full key reference, cooldown semantics and the legacy `device_offline_*` key family: [Offline Alerts](monitors/offline-alerts.md).

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

Winston rotates structured logs. Relative paths resolve from the project root. TRACE contains MQTT payloads, command tokens, and rule skips; it goes only to the trace file. `--no-trace` disables it.

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
| `sensor` | Read-only devices providing measurements (temperature, humidity, soil moisture, illuminance) |

Names must exactly match Zigbee2MQTT `friendly_name`. Unmapped measurement-only devices can be auto-classified as sensors; other unmapped devices become dummies under Unclassified. Startup warnings and type counts identify missing mappings.

### Network Hosts (`etc/device/network.yaml`)

Defines hosts monitored for network presence detection:

```yaml
computers:
  hostname1: 192.168.1.10
  hostname2: 192.168.1.11
```

Each host is pinged via `arping` to detect presence on the local network. The short name (e.g., `hostname1`) is used as a key in automation rules. Sweep mechanics and the `presence` condition are covered in [Network Presence Monitor](monitors/network-presence.md).

#### Video Players (`videoPlayers`)

Polls media players over their HTTP APIs and exposes a normalized status (`playing`, `paused`, `stopped`, `offline`) to rules via the `video_player` condition. Each entry is an object -- **not** a bare IP string -- so the presence monitor does not treat it as a ping target:

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

Optional per-player keys: `username` / `password` (VLC basic auth) and `timeout` (default 1200 ms). Player-side setup (MPC-HC web interface, VLC Lua HTTP password), polling mechanics, and the `videoPlayer:<host>` status events are covered in [Video Player Monitor](monitors/video-player.md); subscribe automations to status changes via `triggers_video`.

---

## 4. Automation Rules (`etc/automation/*.yaml`)

Automations are YAML files paired with optional JavaScript classes: the `.yaml` defines the rules, an accompanying `<Name>Automation.js` provides custom logic extending `RuleBasedAutomationBase`. Working examples are documented in [Automations](automations/index.md).

### YAML Structure

```yaml
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

video_player_suppression:       # Optional: stand-down guard -- suppress all rules while any listed
  hostname1: [playing, paused, stopped]   # player is in one of the listed statuses (OR across hosts)

tts_profile: 'report'           # Optional (TTS-speaking automations): framing profile from the
                                # active locale's tts.yaml profiles: registry
tts_options:                    # Optional: explicit framing, wins over the profile field by field
  intro: 'intro.wav'            # wave played before the synthesized speech
  outro: 'outro.wav'            # wave played after the synthesized speech
  intro_spacing: -2.5           # seconds between intro end and speech start; negative = overlap

rules:
  - name: 'Human-readable rule name'
    once: true                          # Optional: act at most once per calendar day (per time-window for rules with a time_of_day condition)
    forced_only: true                   # Optional: participate only in forced/delegated runs (e.g., delegated light restore); natural ticks skip it entirely
    reassert_state: true                # Optional: force commands onto the wire even if cached state already matches (hand-off/restore rules that must never be no-op suppressed)
    conditions:
      time_of_day: [morning, noon]     # Day period(s)
      season: [winter]                 # Season(s), optional -- spring/summer/autumn/winter
      illuminance: { gte: 20 }          # Sensor threshold
      temperature: { lt: 25 }
      presence: hostname1               # Network host present
    targets:                            # Per-target actions; key = registered device name
      Device_Name_A: OPEN               # with spaces replaced by underscores, casing kept
      Device_Name_B: CLOSE              # e.g. "Kitchen LED Outlet" -> Kitchen_LED_Outlet
```

**Condition key naming.** Use snake_case: `time_of_day`, `video_player`, `state_transition`, etc. Legacy kebab-case keys never match and log their location and replacement at activation.

### Day Periods (`time_of_day`)

The `time_of_day:` condition matches against five **fixed clock-based** periods that are identical year-round (hour-granular, no gaps or overlaps):

| Period    | Hours   |
|-----------|---------|
| night     | 00–04   |
| morning   | 05–10   |
| noon      | 11–12   |
| afternoon | 13–17   |
| evening   | 18–23   |

Periods are fixed clock labels. Use solar bounds for daylight schedules and `/automation coverage <name> [legacy]` to inspect coverage. See [Time-of-Day Periods](architecture/time-of-day-periods.md).

### Wall-Clock Hour (`hour`)

`hour` accepts an exact local hour or `lt` / `lte` / `gt` / `gte` bounds. Bounds may use clock times or solar tokens:

| Form | Meaning |
|------|---------|
| `hour: 4` | Exactly 04:00-04:59 |
| `hour: { gt: 22 }` / `{ gte: 23 }` | After / at-or-after that hour |
| `hour: { lt: 5 }` / `{ lte: 2 }` | Before / up-to-and-including that hour |
| `hour: { gte: 'sunrise' }` / `{ lte: 'sunset' }` | At/after real first light, before/at real end of day (also `sundawn`/`sundusk`) |
| `hour: { gte: 'predusk' }` | At/after **sunset minus 30 minutes** -- a dusk-anchored offset (see below) |
| `hour: { gte: 1230 }` / `{ lte: '12:30' }` | At/after 12:30, before/at 12:30 -- minute-precision clock bounds |

Combine `hour` with other conditions using AND. Integer-hour bounds retain hour granularity; clock-time and solar bounds use sub-hour precision. Invalid or unresolvable bounds fail closed.

**Minute-precision clock bounds.** Accepted forms:

| Spelling | Example | Resolves to |
|----------|---------|-------------|
| NATO-style `HHMM` | `1230`, `'0030'`, `2359` | 12:30, 00:30, 23:59 |
| Colon clock time | `'12:30'`, `'22:00:30'` | 12:30, 22:00:30 |
| Fractional hour | `12.5` | 12:30 |

Values `0..23` are hours; `100` is 01:00. Malformed bounds such as `24`, `99`, `1299`, or `abc` fail closed. Static coverage converts clock bounds to fractional hours before sweeping.

**Sun tokens.** `sundawn`/`sunrise` resolve to civil dawn (sun 6° below the horizon). `sundusk`/`sunset` resolve to actual sunset, not civil dusk. The solar provider also exposes raw sunrise/sunset through `getSunriseSunset()`.

**Named clock anchors (`midnight`, `noon`).** Resolve to 00:00 and 12:00. Names are case-insensitive and trimmed; unknown words fail closed.

**Dusk-anchored offset (`predusk`).** Actual sunset minus 30 minutes, using the configured coordinates. Accepted in `hour` bounds and merged gates; fails closed without a usable location. The offset may fall before midnight at extreme latitudes.

**Overnight windows.** Hours do not wrap: `{ gte: 22, lt: 6 }` never matches.
Use `any_of: [{ hour: { gte: sunset } }, { hour: { lt: sunrise } }]` for sunset through
civil dawn. `lt: sunrise` already includes midnight; no lower bound is needed.

Static coverage excludes `hour` from sensor dimensions and treats solar bounds as satisfied; it does not compute solar timing.

### Merged Sun/Clock Gate Conditions (`after_latest_of` / `after_earliest_of`)

These conditions select the latest or earliest resolved instant on the current day:

| Key | Fires when now >= ... | Use case |
|-----|----------------------|----------|
| `after_latest_of: [a, b]` | the **latest** (max) of the candidates | "at dusk *but not before* 19h" -- summer sunset ~21h wins, winter falls back to 19h |
| `after_earliest_of: [a, b]` | the **earliest** (min) of the candidates | "at dawn *or by* morning start" -- early summer dawn wins, late winter defers to 05h |

Each candidate resolves to an absolute instant on the current day:

| Candidate form | Resolves to |
|----------------|-------------|
| `"sundusk"` / `"sunset"` | today's sunset (`sunrise-sunset-js`, from `locale.geo_latitude`/`locale.geo_longitude`) |
| `"sundawn"` / `"sunrise"` | today's civil dawn |
| `"predusk"` | today's sunset **minus 30 minutes** (a sun event with a fixed offset; fails closed without geo) |
| `19` or `{ hour: 19 }` | today at 19:00 local |
| `1230` / `'12:30'` | today at 12:30 local (minute-precision clock time, same spellings as `hour:` bounds) |
| `'morning'` / `{ 'time_of_day': 'morning' }` | the start-of-day hour of that period (e.g. morning -> 05:00) |

Examples:

```yaml
# Turn ambient lamps on at dusk, but never before 7pm (the later of the two governs).
conditions:
  after_latest_of: [sundusk, { hour: 19 }]

# Switch off leftover lights at first light, no later than the morning window opens.
conditions:
  after_earliest_of: [sundawn, 'morning']
```

Other conditions still apply. Unresolvable candidates are ignored; if none resolve, the gate fails closed. Static coverage treats these gates as satisfied.

### Transition Origin Gate (`state_transition`)

`state_transition` checks the origin and/or destination of the subject's last SQLite
transition. Use it on restore rules to distinguish `playing → stopped` from
`offline → stopped` during player startup:

```yaml
    conditions:
      video_player: { my-pc: [paused, stopped] }
      state_transition: { 'videoPlayer:my-pc': { from: playing } }
```

| Form | Meaning |
|------|---------|
| `'domain:subject': playing` | Last transition came **from** `playing` (bare value is shorthand for `from`) |
| `'domain:subject': [playing, paused]` | Came from any listed state |
| `'domain:subject': { from: playing, to: stopped }` | Pins **both** sides of the transition |
| `'domain:subject': { to: offline }` | Origin unconstrained; the destination pinned (`from` absent matches anything) |

Subjects use `<domain>:<subject>` and combine with AND. Video player references use `videoPlayer:<host>`.

**Availability.** Missing history leaves the gate inactive and does not block the rule. An initial row with null `from_state` does not satisfy a `from` list.

**Restore rules.** Require `from: playing` on pause/stop restores. The separate offline delegation rule can remain ungated.

Static coverage treats `state_transition` as satisfied; it does not simulate history.

### Composite Condition Groups (`any_of` / `all_of`)

By default every condition in one rule combines with AND. The two composite keys add OR logic (and explicit grouping) without duplicating rules:

| Key | Passes when | Empty list |
|-----|-------------|------------|
| `any_of:` | **at least one** sub-group fully matches (inclusive -- several branches may match at once) | fails closed |
| `all_of:` | **every** sub-group fully matches | passes vacuously |

Entries are condition groups and can nest. Scalar conditions in each group combine with AND:

```yaml
rules:
  - name: 'After sunset - someone home - full living room ambient'
    once: true
    conditions:
      hour: { gte: sunset }          # top-level scalars still AND together
      illuminance: { lt: 600 }       # with the composite groups below
      any_of:                        # ... "someone" = at least one of these hosts
        - presence: hostname1
        - presence: hostname2
        - presence: htpc
```

Notes:

- A bare `presence:` map is an AND over all listed hosts; use `any_of` for "anyone home"-style OR gates.
- Malformed shapes fail closed: a non-array gate value, an empty `any_of`, or a subgroup that is not a plain object never matches instead of passing silently.
- The static coverage analyzer (`/automation coverage`) mirrors these semantics exactly -- including recursing into groups when collecting sensor bounds and presence/video-player scenario dimensions.
- Under `trigger_on_change_only`, monitored subjects are collected from inside composite groups too, so a transition of a host referenced only within an `any_of` branch wakes scheduled ticks just like a top-level reference would.

### Target Keys (`targets:`)

Target keys are friendly names with surrounding whitespace trimmed and internal whitespace replaced by underscores, preserving case (`Kitchen Outlet` → `Kitchen_Outlet`). The union of rule targets defines the automation’s device set.

**All matching rules contribute commands**, merged per target in YAML order:

| Contributions to one target | Result |
|-----------------------------|--------|
| Two rules, disjoint targets | Both dispatch in the same pass |
| Same target named by two rules | **Last rule in config order wins** the field it names |
| Same target named by one rule only | That rule's command, untouched |
| Two structured payloads (`{state, brightness}`) | Field-wise merge — later values override, fields the later rule omits keep the earlier value |
| Two `brightness` maps on a dimmer | Merged per channel — `{l1: 50}` then `{l2: 25}` yields both channels |
| `OPEN` / `CLOSE` from two rules | Terminal: the later rule's value, nothing is merged |
| Two position integers (rollers) | Last rule wins |

A rule contributing no command leaves earlier contributions unchanged.

**`priority` selects Weather Man speech rules only.** Device command precedence follows YAML order.

Activation warns about unknown targets, non-actuators, and colliding target keys. If all declared targets are invalid, that automation is not registered. Speech-only and delegation-only automations may declare no targets.

### Timer Interval (`timer_interval`)

`timer_interval` sets periodic evaluation cadence. Duration tokens use `d`, `h`, `m`, or `s`:

```yaml
timer_interval: "90s"      # every 90 seconds
timer_interval: "3m 45s"   # tokens combine: every 3 minutes 45 seconds
```

- Omitting the key disables the timer entirely -- the automation becomes event-driven only. Legacy numeric `timer_interval_ms` remains supported; when both keys are present, `timer_interval` wins.
- Invalid values log a warning and disable the timer (fail-open). Values above ~24.8 days (the 32-bit `setInterval` limit) are rejected.
- Manual `/automation run <n>` / `/automation force <n>` pokes perform a single one-shot evaluation and never touch this schedule -- no tick is started, skipped or re-anchored by them.

### React-On-Change Gate (`trigger_on_change_only`)

With `trigger_on_change_only: true`, timer ticks run only after a monitored presence/player transition since the last evaluation. Subjects are collected from `presence` and `video_player` conditions, including nested groups. Sensor changes and clock boundaries do not qualify. Event-driven and forced runs bypass this gate.

If no subjects are monitored or history is unavailable, timer ticks proceed normally.

```yaml
timer_interval: "15m"          # safety-net cadence
trigger_on_change_only: true   # skip a tick unless a monitored player/presence state changed
```

### Silence Periods (`silence_between`)

`silence_between` suppresses execution during a local time range, independently per automation:

```yaml
silence_between: "HHmm-HHmm"   # e.g., "0500-0900" or overnight "2300-0600"
```

Times use compact four-digit **NATO-style** notation (hours then minutes, no separators):

| Example | Meaning |
|---------|---------|
| `"0500-0900"` | Suppress from 5:00 AM until 8:59 AM |
| `"2300-0600"` | Suppress from 11:00 PM through midnight into 5:59 AM next day |

Start is inclusive; end is exclusive. All trigger sources are suppressed unless forced. Missing or invalid values impose no silence; invalid formats warn once.

### Condition Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `lt` | Less than | `{ lt: 25 }` |
| `lte` | Less than or equal | `{ lte: 25 }` |
| `gt` | Greater than | `{ gt: 25 }` |
| `gte` | Greater than or equal | `{ gte: 25 }` |

Multiple operators on the same field create a range: `{ gt: 1800, lte: 11000 }`.

### Video Player Conditions

The optional `video_player` condition gates a rule on media-player status (see `videoPlayers` under Network Hosts). Values accept a single status or a list per host:

```yaml
conditions:
  video_player:
    hostname1: [paused, stopped, offline]   # "not actively playing or gone"
    hostname2: playing                      # single value shorthand
```

Missing, unreachable, and unpolled players map to `offline`. List that status explicitly to match it. Raw offline-cause changes do not emit status transitions. `triggers_video` subscribes to status-change events.

### Video Player Suppression (`video_player_suppression`)

`video_player_suppression` suppresses the automation while any listed host has a listed status:

```yaml
video_player_suppression:
  htpc: [playing, paused, stopped]   # stand down while actively playing
```

- Statuses use the same vocabulary as the `video_player` condition; a host with no recorded status enumerates to `offline`, so it suppresses only when `offline` is listed.
- Individual rules may opt out with `ignore_video_player_suppression: true`. While the guard is active, only exempt rules are evaluated; when no rule opts out, the automation returns early without even building context.
- Unlike `silence_between`, the guard is **never bypassed by `/automation force`** -- a forced run must not create device fights.
- Use per-rule `video_player` conditions when individual rules need different statuses.

Restore uses explicit rules, not snapshots. `restore_state_aware` and `force_restore` are not implemented. See [Restore & Ownership](architecture/rule-engine-restore-semantics.md).

### Delegating to Other Automations (`invoke_automation`)

`invoke_automation` runs other loaded automations, with or without device targets. Example: delegate to roller and ambient owners when a player goes offline.

```yaml
rules:
  - name: 'HTPC: player gone - hand back to the room owners'
    conditions: { video_player: { htpc: [offline] } }
    invoke_automation:
      - { name: HomeOfficeRollersAutomation, force: true }
      - { name: AmbientLightsAutomation, force: true }
```

Every form below resolves to the same set of `{name, force}` targets:

- **Bare string** -- `invoke_automation: SomeName` (equivalent to `{ name: SomeName }`, no force).
- **Single object** -- `invoke_automation: { name: SomeName, force: true }`.
- **Array** -- `invoke_automation: [NameA, { name: NameB, force: true }]`; each element is a bare name or a `{name, force}` object, and per-element force is honored.
- **Names object** -- `invoke_automation: { names: [NameA, NameB], force: true }`; one shared force flag applied to every listed name.

- `name` must match an automation registered by the container exactly; unknown names log a warning and are skipped without aborting the run.
- Invocations run after matching and before device dispatch. Rules may contain only invocations.

### Force Semantics and Once Markers

Forced runs bypass silence and daily-marker checks/writes. They retain human cooldowns and video suppression, and do not consume the daily budget.

### Daily Once Markers (`once`)

`once: true` grants one action per local calendar day. With a `time_of_day` condition
anywhere in the condition tree, the budget is per active period instead.

A marker is written after dispatch or human-cooldown deferral. Runs that do neither retry
on later evaluations. Redis keys are `auto:<name>:once:<rule-slug>`, with `:<period>` for
window-scoped rules. Markers store the local date; storage failures fail open.
Forced runs neither check nor write markers. Debug output and skip logs show the window.

### Invoke-Only Rules (`forced_only`)

`forced_only: true` includes a rule only in `/automation force` or forced `invoke_automation` runs. Natural timer, sensor, and unforced manual runs skip it. Forced rules can run repeatedly without consuming daily markers.

### Re-Assert State (`reassert_state`)

`reassert_state: true` passes `{bypassNoOpSuppression: true}` for the rule's targets,
sending commands even when cached state matches. Use it for restores that must reach
stale devices. Forced runs already bypass suppression automatically.

The flag applies only to contributing targets. It complements DeviceBase's automatic
bypass after an unconfirmed command. Debug and coverage output display `[reassert]`.

### Rule Match History

Each automation keeps its last 25 rule matches in memory: rule, time, trigger, forced flag, action result, and run id. Events are `automation:ruleMatched` and `automation:ruleActed`. Restart clears the history; `/automation debug <name>` displays it.

### Automation Call History

Each automation also retains its last 10 calls: run id, time, trigger, forced flag, matched rules, reason, and outcome:

| Outcome | Meaning |
|---------|---------|
| `acted` | Dispatched a command, deferred a device to recent human interaction, or delegated an automation |
| `noop` | Rules matched, nothing was dispatched |
| `no-match` | Conditions were evaluated and no rule matched |
| `suppressed` | Silent period, or the `video_player_suppression` stand-down, silenced the call before any work |
| `skipped` | `trigger_on_change_only` gating found no monitored state change, so the scheduled tick was dropped |
| `blocked` | The context build failed, so no rule could be evaluated |

`automation:runCompleted` feeds the [rules window](ui/index.md). Rule-match events share the run id; forced calls are recorded normally.

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
- **Dimmers**: structured object commands pass through verbatim -- e.g., `Living_Room_Dimmer: { state: 'ON', brightness: { l1: 50, l2: 25 } }`; the DualDimmer maps each percentage into its channel's level range at publish time (a bare `{brightness: N}` sets levels only and never switches the relay on)
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

## 6. Sequences (`etc/sequence/sequences.yaml`)

Sequences send ordered commands with optional loops. Copy `etc/sequence/sequences.yaml.dist` to its active name. `/config reload` rebuilds entries and stops active loops gracefully; unreadable configuration retains the current registry. See [Sequence Entity](./architecture/sequence-entity.md).

### Entry schema

| Key | Required | Meaning |
|-----|----------|---------|
| `name` | yes | Friendly name; internally slugified (`'Living Room Hazard Light'` → `living_room_hazard_light`). Slugs must be unique across all sequences |
| `delay` | no | Sequence-level inter-step pause (duration like `"500ms"` / `"2s"`, or plain ms number). Absent ⇒ **multi-device endpoint mode** — every step fires back-to-back |
| `devices` | simple form | Ordered list of names (or `{device, command?, delay?}` objects). ON sends each device `'ON'`; OFF sends each device `'OFF'` in the same order |
| `on` / `off` | rich form | Explicit step lists; a step is `{device, payload?, delay?}`. `payload` passes through `receiveCommand()` verbatim (any shape: strings, `{state}`, `{position:N}`, `{state,brightness:{l1,l2}}`, ...). Missing `off:` defaults to plain OFF over the `on` devices |
| `loop` | no | Block making this a looping sequence: `enabled: true`, `cycle: once \| continuous`, `off_delay: auto \| duration` (gap between end of ON run and start of OFF run), `on_delay: auto \| duration` (gap between end of OFF run and next ON run; only fires on continuous cycles). `auto` = phase starts right when the previous one finishes |

Use exactly one of `devices` or `on`. Invalid durations warn and use defaults. Missing devices warn and their steps are skipped.

### Simple form + pacing

```yaml
sequences:
  - name: 'Ambient Lights'
    delay: '500ms'
    devices:
      - 'Living Room Ambient Left'
      - 'Bedroom Ambient'
      - device: 'Kitchen LED Strip'   # object entries allow per-step overrides
        command: 'ON'
        delay: '800ms'
```

### Rich form + loop (hazard light oscillation)

```yaml
  - name: 'Living Room Hazard Light'
    loop:
      enabled: true
      cycle: continuous
      off_delay: '2s'   # dwell before the OFF swing
      on_delay: '2s'    # dwell before the next ON swing
    on:                               # phase A -- low values
      - device: 'Living Room Dimmer'
        payload: { state: 'ON', brightness: { l1: 1, l2: 25 } }
    off:                              # phase B -- high values (the swing back)
      - device: 'Living Room Dimmer'
        payload: { state: 'ON', brightness: { l1: 100, l2: 75 } }
```

Setting brightness values automatically creates the transition on the wire — no extra "transition" field needed.

### Runtime behaviour & state keys

- Runs are **blocking**: a second `run()` or `startLoop()` while an instance is busy is rejected with a warning (never queued, never overridden).
- Loops stop gracefully (`/sequence loop stop <name>`): between phases the inter-phase timer cancels and the sequence goes straight to idle; mid-phase the in-flight step-list always finishes so no device ends half-configured.
- Live status is exposed under StateService keys `sequence.<slug>.active`, `sequence.<slug>.phase` (`on`|`off`) and `sequence.<slug>.loop.active`; all cleared at idle. Commands carry AUTOMATION provenance.
- Drive from the UI: `/sequence run <name> [ON|OFF]`, `/sequence loop start|stop <name>` — names may be slugs or friendly names (case-insensitive); bare `/sequence` lists everything with live status. See [UI commands](./ui/commands/index.md) for details.

---

## 7. i18n Bundles

Language bundles live in `etc/i18n/{locale}/` where `{locale}` matches BCP 47 tags (`en_US`, `pl_PL`, etc.). Each locale contains an AI bundle, a TTS bundle, an alerts bundle, and (for the weatherman automation) a speech bundle, a date bundle, and a proverb list:

| File | Purpose | Tracked as |
|------|---------|-----------|
| `ai.yaml` | LLM system prompt, tool descriptions, device roles, UI strings | `.yaml` + `.yaml.dist` |
| `tts.yaml` | Voice model and audio effect settings per locale, plus the named `profiles:` framing registry | `.yaml` + `.yaml.dist` |
| `alerts.yaml` | Spoken sentences for system events (offline alerts) | `.yaml` + `.yaml.dist` |
| `frozen-sensors.yaml` | Independent frozen-sensor warning and AI instruction | `.yaml.dist` (optional `.yaml` override) |
| `weatherman.yaml` | Weather announcement sentence templates | `.yaml` + `.yaml.dist` |
| `date.yaml` | Day/month names, period words, duration units (date helper) | system file, no template |
| `proverbs.txt.dist` | Starter list to copy to `proverbs.txt`; one proverb per line, drawn at random by the weatherman proverb segment | `.dist` template |

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

ui:
  default_greeting: "Hello! How can I help?"
```

> The `devices.mechanism` section only needs entries for devices with **non-obvious** names. A device named "Kitchen Light" doesn't need an annotation, but a socket named "Patio Outlet" powering the garden light strip does.

### TTS Bundle (`tts.yaml`)

Defines the voice model, effects, and optional framing `profiles` registry. Profiles contain only `intro`, `outro`, and `intro_spacing`. See [TTS Integration](installation/tts-integration.md).

### Alerts Bundle (`alerts.yaml`)

Sentences spoken by the [offline alert monitors](monitors/offline-alerts.md). A key is either a plain sentence with a `{device}` placeholder, or a per-device map with a `default` entry:

```yaml
zigbee_device_offline: "Attention, device {device} has left the Zigbee network."

network_device_offline:
  default: "Attention, {device} is offline."
  core-server: "Attention, the core server is offline."

network_device_online:
  default: "{device} is back online."
```

### Date Bundle (`date.yaml`)

Owned by the date helper (`src/lib/date.js`): localized day-of-week and month names, the `date_sentence` fragment, `period_words` for `{% time_of_day %}`, and `duration_units` for `{% next_interval %}` -- the vocabulary behind [Weatherman Speech Rendering](architecture/weatherman-speech-rendering.md). A system file (force-tracked in git, no `.dist` template), not a user-customizable speech template.

### Proverb List (`proverbs.txt`)

With `add_proverb: true`, Weather Man reads a random line from `etc/i18n/{locale}/proverbs.txt` into `{% proverb %}`. The reader streams the file with bounded memory.

Format rules, enforced by the reader:

- Exactly one proverb per line -- no quoting, no numbering, no embedded newlines.
- Blank lines are skipped, so entries can be grouped with empty lines.
- A trailing newline at end of file is fine and never yields an empty proverb.
- Lines whose first non-blank character is `#` are treated as comments, so a documented header is safe. A proverb that genuinely starts with `#` would need that marker disabled.

Ships as a clean starter template (`proverbs.txt.dist`, tracked); copy it to `proverbs.txt` in the same directory and add your own lines -- the active list is git-ignored so personal entries never get committed.

---

## Adding a New Language

1. Create a new directory: `etc/i18n/{locale}/`
2. Copy and translate `ai.yaml` from an existing bundle
3. Create `tts.yaml` with appropriate voice model settings
4. If you use the weatherman automation, copy and translate `weatherman.yaml` and `date.yaml` (the date bundle holds day/month names, period words, and duration units), and copy `proverbs.txt.dist` to `proverbs.txt`, adding one proverb per line
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
