# Configuration Guide

A detailed walkthrough of every configuration file and section in Automaton. The shipped templates represent a real, working home deployment -- customize device names, network addresses, and automation rules to match your own setup.

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

### Geolocation (under `locale`)

Observer coordinates that power the sun-based rule shorthands (`sundawn` / `sundusk`) used by the merged-gate conditions and `hour:` bounds described in [Automation Rules](#4-automation-rules-etcautomationyaml). They live inside the `locale:` section alongside language/time format:

```yaml
locale:
  geo_latitude: 52.2307   # WGS84 decimal degrees; positive = north (-90..90)
  geo_longitude: 21.0122  # WGS84 decimal degrees; positive = east  (-180..180)
```

- **`locale.geo_latitude`** / **`locale.geo_longitude`** -- Your site's position (decimal degrees, WGS84). Both are optional numbers; when missing/invalid the sun shorthands resolve to nothing and any gate relying on them fails closed (the rule simply never fires) rather than guessing. The values feed `sunrise-sunset-js`, which computes today's **civil** dawn/dusk instants -- the sun 6° below the horizon, when the sky is effectively day -- for the current calendar day. Geometric sunrise/sunset are computed alongside them and exposed to automations as the `sunrise`/`sunset` context fields for the rare rule that wants the disc edge itself.

### TTS Configuration

TTS is configured entirely through environment variables and locale-specific i18n bundles — there is no `tts:` section in `automaton.yaml`.

- **`TTS_API_URL`** (`.env`) — TTS server API endpoint; service auto-enables when set
- **`TTS_TCP_ENDPOINT`** (`.env`) — Global audio playback destination (`ip:port`). Can also be overridden per-request via EventBus event payloads or per-locale in `etc/i18n/{locale}/tts.yaml`
- **Per-request extras** — Components emitting `tts:speak` events may attach extra TTS server parameters to individual utterances (e.g., intro/outro jingle waves); they merge into that request only, with runtime values winning over locale template defaults. Framing is resolved for every speaker by one shared owner (`src/lib/ttsProfiles.js`) from two optional keys -- `tts_profile:` (a named entry of the locale `tts.yaml` `profiles:` registry) and `tts_options:` (explicit fields, winning over the profile field by field). Wired speakers: the weatherman, greeter and gardener automations, the [spoken offline alerts](monitors/offline-alerts.md) and the UI speak window (`ui.tts_profile`). See [TTS Integration](installation/tts-integration.md).

### AI Section

```yaml
ai:
  model: your-model-name
  name: Gerwazy               # Assistant's own name: fills {% name %} in the system prompt, signs the AI window; blank = "AI"
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
      readonly: true         # Read-only: the rule-match table is written by the automations
```

Each window has an IRC-style channel name, display title, keyboard shortcut (`Alt+N`), and read-only flag. The AI window must have `readonly: false` to accept chat input. The `ai` and `tts` windows exist only when their backing services are configured. The `rules` window lists recent automation rule matches (see [UI Windows](ui/index.md)).

```yaml
ui:
  tts_profile: ''            # Optional: framing profile for text typed into the TTS speak window
```

`ui.tts_profile` names an entry of the active locale's `tts.yaml` `profiles:` registry; unset (the default) means typed utterances are spoken plain, with no jingle. See [UI Windows](ui/index.md).

### Alerts Section

Spoken warnings for notable system events -- Zigbee devices leaving the mesh and mission-critical LAN hosts dropping offline. Every key is read per event, so `/config reload` applies changes without a restart.

```yaml
alerts:
  zigbee_offline_tts: true            # master switch (default ON)
  zigbee_offline_cooldown_ms: "30m"   # per-device re-warning window ("90s"/"15m"/plain ms; 0 disables)
  zigbee_offline_ignore: []           # device names never announced
  zigbee_offline_tts_profile: ''      # framing profile from the locale tts.yaml profiles: registry
  # zigbee_offline_tts_options: { intro: 'alarm.wav' }   # explicit framing, wins over the profile

  network_offline_tts: true
  network_offline_cooldown_ms: "30m"
  network_offline_ignore: []
  network_offline_tts_profile: ''
  network_offline_announce_boot: true       # announce hosts already down at startup
  network_offline_announce_recovery: false  # speak the way back (opt-in)
  network_offline_devices:                  # allow-list; names from etc/device/network.yaml
    core-server:                            # null = family defaults
    wifi-router: { cooldown_ms: "5m", tts_profile: 'alarm' }   # per-host overrides
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

Uses Winston for structured logging with file rotation; non-absolute paths resolve relative to the project root. A fifth **TRACE** level (raw MQTT payloads, token lifecycle events, rule-miss explanations from rule-based automations) routes exclusively to the dedicated `trace` log file -- never to the console or UI log window. Passing `--no-trace` at startup suppresses the stream entirely.

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

Names must match the bridge's `friendly_name` **exactly** — renaming a device in Zigbee2MQTT breaks its mapping here. A device with no mapping is judged by the definition the bridge reports: a measurement-only device (temperature / humidity / soil moisture / illuminance, with nothing actuating) is auto-classified as `sensor` with a warning naming it, while anything that actuates falls back to a dummy that only mirrors state. The startup line `Instantiated by type: Sensor:9 Mechanism:8 Device:1 ...` counts every device by resolved type, so a stray `Device:N` is the tripwire for a drifted name, and the device window lists unmapped devices under **Unclassified** instead of presenting them as controllable mechanisms. The soil-probe case end to end: [TTS Gardener](automations/gardener.md).

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

Optional per-player keys: `username` / `password` (VLC basic auth) and `timeout_ms` (default 500 ms). Player-side setup (MPC-HC web interface, VLC Lua HTTP password), polling mechanics, and the `videoPlayer:<host>` status events are covered in [Video Player Monitor](monitors/video-player.md); subscribe automations to status changes via `triggers_video`.

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
      Device_Name_B: CLOSE              # e.g. "Kuchnia Gniazdo LED" -> Kuchnia_Gniazdo_LED
```

**Condition key naming.** All rule condition keys use snake_case (`time_of_day`, `video_player`, `state_changed_ago_minutes`, `after_latest_of`, `any_of`, ...). The legacy kebab-case spellings (`time-of-day`, `video-player`, `state-changed-ago-minutes`) no longer evaluate -- a stale key simply never matches -- and there is no silent alias period. At activation, every rule still carrying one logs a loud warning pinning down the exact location in its conditions tree (including nested `any_of`/`all_of` groups) together with the replacement name; rename them when you see it.

### Day Periods (`time_of_day`)

The `time_of_day:` condition matches against five **fixed clock-based** periods that are identical year-round (hour-granular, no gaps or overlaps):

| Period    | Hours   |
|-----------|---------|
| night     | 00–04   |
| morning   | 05–10   |
| noon      | 11–12   |
| afternoon | 13–17   |
| evening   | 18–23   |

These replaced the older sun-derived boundaries in commit `c1e8c6f` -- rules written before that change may silently miss hours they used to cover (or fire where they shouldn't). See [Time-of-Day Periods](architecture/time-of-day-periods.md) for the full rationale, old-vs-new comparison and impact analysis; use `/automation coverage <name> legacy` inside a running instance to diff any automation's behavior against both schemes.

### Wall-Clock Hour (`hour`)

The optional `hour:` condition gates rules against the **actual local clock hour** (0-23) instead of calendar-derived day-period labels. It accepts either an exact number or comparison bounds (`lt`/`lte`/`gt`/`gte`); each bound may also be a sun-event token that resolves to today's real dawn/dusk moment:

| Form | Meaning |
|------|---------|
| `hour: 4` | Exactly 04:00-04:59 |
| `hour: { gt: 22 }` / `{ gte: 23 }` | After / at-or-after that hour |
| `hour: { lt: 5 }` / `{ lte: 2 }` | Before / up-to-and-including that hour |
| `hour: { gte: 'sunrise' }` / `{ lte: 'sunset' }` | At/after real first light, before/at real end of day (also `sundawn`/`sundusk`) |
| `hour: { gte: 'predusk' }` | At/after **civil dusk minus 30 minutes** -- a dusk-anchored offset (see below) |
| `hour: { gte: 1230 }` / `{ lte: '12:30' }` | At/after 12:30, before/at 12:30 -- minute-precision clock bounds |

Unlike `time_of_day`, it is evaluated directly from the live clock on every tick -- no period table, no season logic -- which makes it the right tool for wall-clock schedules like 'close everything after 23h' where winter dusk can arrive during calendar afternoon. It composes with other conditions as usual (all must hold), so `hour: { gte: 23 }` + `illuminance: { lte: 15 }` fires only in true darkness past 23h and stays inert at pre-dawn hours even when equally dark. Plain numeric bounds keep one-hour granularity; a bound written as a sun token (`'sunrise'`/`'sunset'`) switches that comparison to exact sub-hour precision against the computed dawn/dusk instant, so `hour: { gte: 'sunrise' }` opens right at first light rather than the next whole hour. Malformed values or an unresolvable sun token fail closed (the rule never matches) rather than passing silently.

**Minute-precision clock bounds.** A plain hour bound tops out at 23, so a mid-day boundary such as "the sun is over the building from 12:30" was previously unwriteable. Bounds now also accept clock times, accepted as integers or strings in three spellings:

| Spelling | Example | Resolves to |
|----------|---------|-------------|
| NATO-style `HHMM` | `1230`, `'0030'`, `2359` | 12:30, 00:30, 23:59 |
| Colon clock time | `'12:30'`, `'22:00:30'` | 12:30, 22:00:30 |
| Fractional hour | `12.5` | 12:30 |

Values in `0..23` stay plain hours, so `hour: { gte: 23 }` keeps its existing meaning. A number that parses as a clock time is always read as a clock time: `100` is `01:00`, not 100 o'clock. Anything outside both readings (`24`, `99`, `1299`, `'abc'`) is malformed and fails closed. The static analyzer resolves these bounds to fractional hours before sweeping the clock grid, so a `lte: 1230` bound correctly stops covering the day at 13h.

**Sun tokens are civil twilight.** `sundawn`/`sunrise` and `sundusk`/`sunset` resolve to the *civil* twilight boundaries -- the sun 6° below the horizon, when the sky is effectively day -- not the geometric disc edge. At 52°N that is roughly 33 minutes earlier than sunrise in the morning and 34 minutes later than sunset in the evening, and the gap widens with latitude. This is deliberate: rules gated on "daylight" that read a street illuminance sensor must not fire in pre-dawn darkness, and civil twilight is the boundary that matches what the sensor reports. The geometric instants stay available in the automation context as `sunrise`/`sunset` for rules that genuinely want the disc edge.

**Named clock anchors (`midnight`, `noon`).** A bound may name a fixed point on the axis instead of spelling out a number: `hour: { gte: 'midnight' }` and `hour: { gte: 'noon' }` resolve to `00:00` and `12:00`. They are accepted in any bound slot, case-insensitively and with surrounding whitespace ignored; an unrecognised word fails closed like any malformed bound.

**Dusk-anchored offset (`predusk`).** A bound may also name a *sun event shifted by a fixed offset*: `hour: { gte: 'predusk' }` resolves to today's civil dusk **30 minutes ahead** -- the moment lamps are worth switching on, while the sky is still dimming, rather than at the very end of twilight. It is written for rules that mean "a little before dusk" and cannot afford a hard-coded clock time, which drifts by hours across the year. Like the sun tokens it hangs on, `predusk` is resolved from the real civil instants computed from `locale.geo_latitude`/`locale.geo_longitude`, so it inherits their civil-twilight meaning and **fails closed when no location is configured**. It is accepted in `hour:` bounds and as a candidate in the merged gates below. The offset is applied on the current calendar day, so at extreme latitudes where civil dusk lands just after midnight the floor sits below the axis start and a `gte` bound is trivially satisfied.

**The hour axis starts at midnight and never wraps.** Bounds compare on one day's axis running `00:00 → 23:59`, so a bound pair cannot cross midnight: `hour: { gte: 22, lt: 6 }` is unsatisfiable and matches nothing, and a rule that means "the whole night" must be written as an explicit OR -- `any_of: [{ hour: { gte: sunset } }, { hour: { lt: sunrise } }]`. Two consequences are worth remembering:

- **A lower bound at midnight is never needed.** `hour: { lt: sunrise }` already means *midnight → civil dawn*, because nothing on the axis lies below `00:00`. Writing `hour: { gte: 'midnight', lt: sunrise }` describes the same window with a bound that can only ever be true -- accepted, harmless, but it hides the intent, so prefer the single bound.
- **A bare `gte: sunset` is only half a night.** On its own it covers civil dusk → `23:59` and silently drops `00:00` → civil dawn; the morning half has to be added as its own arm.

The static coverage analyzer mirrors these semantics exactly and treats `hour` as reserved, so it never appears as a sensor dimension in scenario grids or gap reports; a sun-token bound is treated as satisfied there since real dawn/dusk times are not part of the static clock grid.

### Merged Sun/Clock Gate Conditions (`after_latest_of` / `after_earliest_of`)

Where `time_of_day`, `hour` and `season` each assert one fixed boundary, these two conditions let a single rule wait for the **later** of several candidate moments ("whichever is later") or open at the **earlier** of them ("whichever is earlier"). Each condition takes a list of candidates; the rule fires once "now" has passed the selected extreme of those candidates' resolved instants:

| Key | Fires when now >= ... | Use case |
|-----|----------------------|----------|
| `after_latest_of: [a, b]` | the **latest** (max) of the candidates | "at dusk *but not before* 19h" -- summer sunset ~21h wins, winter falls back to 19h |
| `after_earliest_of: [a, b]` | the **earliest** (min) of the candidates | "at dawn *or by* morning start" -- early summer dawn wins, late winter defers to 05h |

Each candidate resolves to an absolute instant on the current day:

| Candidate form | Resolves to |
|----------------|-------------|
| `"sundusk"` / `"sunset"` | today's civil dusk (`sunrise-sunset-js`, from `locale.geo_latitude`/`locale.geo_longitude`) |
| `"sundawn"` / `"sunrise"` | today's civil dawn |
| `"predusk"` | today's civil dusk **minus 30 minutes** (a sun event with a fixed offset; fails closed without geo) |
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

They compose with every other condition as usual (all must hold), so a rule can pair them with strict gates -- e.g. `season: spring` + `illuminance: { lte: 15 }` + `after_latest_of: [sundusk, { hour: 19 }]`. Unresolvable candidates are dropped; if **none** resolve (no geo configured, unknown shorthand, empty list) the gate fails closed and the rule never fires. The static coverage analyzer treats both keys as reserved/satisfied (like `state_changed_ago_minutes`) since they depend on real sun times rather than the clock-hour grid.

### Composite Condition Groups (`any_of` / `all_of`)

By default every condition in one rule combines with AND. The two composite keys add OR logic (and explicit grouping) without duplicating rules:

| Key | Passes when | Empty list |
|-----|-------------|------------|
| `any_of:` | **at least one** sub-group fully matches (inclusive -- several branches may match at once) | fails closed |
| `all_of:` | **every** sub-group fully matches | passes vacuously |

Each list entry is a full condition group in its own right, so composites nest to arbitrary depth and every group keeps combining its scalar entries with AND as usual:

```yaml
rules:
  - name: 'After sunset - someone home - full salon ambient'
    once: true
    conditions:
      hour: { gte: sunset }          # top-level scalars still AND together
      illuminance: { lt: 600 }       # with the composite groups below
      any_of:                        # ... "someone" = at least one of these hosts
        - presence: kyeno
        - presence: meerkat
        - presence: htpc
```

Notes:

- A bare `presence:` map is an AND over all listed hosts; use `any_of` for "anyone home"-style OR gates.
- Malformed shapes fail closed: a non-array gate value, an empty `any_of`, or a subgroup that is not a plain object never matches instead of passing silently.
- The static coverage analyzer (`/automation coverage`) mirrors these semantics exactly -- including recursing into groups when collecting sensor bounds and presence/video-player scenario dimensions.
- Under `trigger_on_change_only`, monitored subjects are collected from inside composite groups too, so a transition of a host referenced only within an `any_of` branch wakes scheduled ticks just like a top-level reference would.

### Target Keys (`targets:`)

There is no separate declaration section: each rule's `targets:` map addresses devices directly by **target key** — the registered friendly name trimmed, whitespace runs collapsed to single underscores, original casing preserved (`Salon Roleta Okno Lewe` → `Salon_Roleta_Okno_Lewe`). The union of all rule-level keys defines an automation's addressable set; there are no separate aliases to invent or keep in sync.

**Every matching rule acts — commands are merged, not first-won.** One evaluation pass collects *all* rules whose conditions hold and folds their contributions target by target, in config order. A rule targeting devices A and B and a later rule targeting C both dispatch in the same tick; nothing is shadowed by an earlier match:

| Contributions to one target | Result |
|-----------------------------|--------|
| Two rules, disjoint targets | Both dispatch in the same pass |
| Same target named by two rules | **Last rule in config order wins** the field it names |
| Same target named by one rule only | That rule's command, untouched |
| Two structured payloads (`{state, brightness}`) | Field-wise merge — later values override, fields the later rule omits keep the earlier value |
| Two `brightness` maps on a dimmer | Merged per channel — `{l1: 50}` then `{l2: 25}` yields both channels |
| `OPEN` / `CLOSE` from two rules | Terminal: the later rule's value, nothing is merged |
| Two position integers (rollers) | Last rule wins |

A rule that wins a target and resolves to nothing (unknown key, a device sitting in human-interaction cooldown) contributes nothing, so an earlier rule's contribution to that target survives. Single-rule behavior is unchanged.

**`priority:` does not participate in device dispatch.** It is honored only by the Weather Man's speech rules (highest wins) and is surfaced as a label by `/automation coverage`. For device automations, the ordering that matters is **the order of rules in the YAML** — move a rule later in the file to let it win a shared target.

Every automation validates this wiring at activation time against the live device container and logs warnings for problems that would otherwise be silently inert: unknown keys (typos or renamed devices), keys resolving to non-actuator device types (sensors, remotes...), and duplicate keys (two friendly names collapsing onto one key, so only one of the devices is addressable). An automation whose declared targets ALL fail validation fails fast -- the container skips registering just that instance instead of running it silently inert. Automations that declare no targets at all (speech-only or pure `invoke_automation` flows) are valid and simply skip device dispatch.

### Timer Interval (`timer_interval`)

The optional `timer_interval` key controls how often an automation evaluates on its periodic timer. It accepts human-readable durations made of `<integer><unit>` tokens where the unit is `d` (days), `h` (hours), `m` (minutes) or `s` (seconds):

```yaml
timer_interval: "90s"      # every 90 seconds
timer_interval: "3m 45s"   # tokens combine: every 3 minutes 45 seconds
```

- Omitting the key disables the timer entirely -- the automation becomes event-driven only. Legacy numeric `timer_interval_ms` remains supported; when both keys are present, `timer_interval` wins.
- Invalid values log a warning and disable the timer (fail-open). Values above ~24.8 days (the 32-bit `setInterval` limit) are rejected.
- Manual `/automation run <n>` / `/automation force <n>` pokes perform a single one-shot evaluation and never touch this schedule -- no tick is started, skipped or re-anchored by them.

### React-On-Change Gate (`trigger_on_change_only`)

The optional `trigger_on_change_only: true` key turns the periodic timer into a pure safety net. When enabled, a scheduled (`timer`) tick is **skipped entirely** unless one of the automation's monitored subjects actually transitioned since its last evaluation. Monitored subjects are derived automatically from the `presence` (network) and `video_player` rule conditions -- including hosts referenced inside nested `any_of`/`all_of` condition groups -- the hosts those conditions watch. Event-driven runs (a real EventBus topic) and forced runs always proceed regardless, since they already represent an explicit reason to act.

This is what stops a "sticky" automation (one that opts into `override_human_interaction`) from re-firing its rules on every timer tick while its conditions still hold -- e.g., a home-theater instance whose player is stably offline used to re-assert its restore rule on every 15-minute tick. With the gate, the rule fires once on the transition that made its conditions true, then stays quiet until a monitored subject changes again. The gate fails open: if no subjects are monitored, or the state-history store is unavailable, the tick proceeds as usual.

```yaml
timer_interval: "15m"          # safety-net cadence
trigger_on_change_only: true   # skip a tick unless a monitored player/presence state changed
```

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

The optional `video_player` condition gates a rule on media-player status (see `videoPlayers` under Network Hosts). Values accept a single status or a list per host:

```yaml
conditions:
  video_player:
    hostname1: [paused, stopped, offline]   # "not actively playing or gone"
    hostname2: playing                      # single value shorthand
```

An absent status (host offline, player not answering, or not yet polled) enumerates to the single **`offline`** status -- each rule decides whether that is safe to act on by listing it (e.g. ambient-restore rules use `[paused, stopped, offline]`; ownership hand-back guards use `[offline]`), while playback requirements like `[playing]` stay inert. The raw cause behind `offline` is log-only and never a status transition of its own. `triggers_video: [<host>, ...]` subscribes the automation to status-change events so rules re-evaluate immediately.

### Video Player Suppression (`video_player_suppression`)

The optional top-level `video_player_suppression` key is an automation-wide **stand-down guard** with inverted semantics: instead of listing statuses a rule requires, it lists statuses that make the whole automation stand down. While **any** listed host (OR across hosts) reports one of its listed statuses, `execute()` suppresses the automation -- typically so it does not fight the [Home Theater Mode](automations/home-theater-mode.md) automation over the same devices while a movie runs:

```yaml
video_player_suppression:
  htpc: [playing, paused, stopped]   # stand down while actively playing
```

- Statuses use the same vocabulary as the `video_player` condition; a host with no recorded status enumerates to `offline`, so it suppresses only when `offline` is listed.
- Individual rules may opt out with `ignore_video_player_suppression: true`. While the guard is active, only exempt rules are evaluated; when no rule opts out, the automation returns early without even building context.
- Unlike `silence_between`, the guard is **never bypassed by `/automation force`** -- a forced run must not create device fights.
- The per-rule `video_player` condition remains the tool for rules that need to *distinguish* player states (e.g. Home Theater Mode's ownership hand-back); the suppression key only replaces the repetitive "not actively playing" allow-list guard duplicated across rules.

With `restore_state_aware: true` (automation level), restore commands are filtered through pre-command snapshots so an automation only undoes changes it made itself; a rule can mark its targets as unconditional with `force_restore: true`. Full snapshot, ownership, and no-op suppression semantics are covered in [Rule Engine Restore & Ownership](architecture/rule-engine-restore-semantics.md).

### Delegating to Other Automations (`invoke_automation`)

A rule can hand control to one or more loaded automations instead of -- or alongside -- issuing device commands itself. This is how [Home Theater Mode](automations/home-theater-mode.md) hands a room back to its owners when a player goes offline: a single gone rule force-fires both the roller owner and the ambient-lights owner in one rule.

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
- Invocations fire **after** a rule matches but **before** any device dispatch, so a rule whose only action is invoking still works even though it issues no device command of its own (the automation just needs at least one device in scope for `execute()` to proceed).
- If several matched rules -- or several entries within one rule -- reference the same target within one run, that automation fires **once**; `force: true` is OR-merged across all those references.
- A mutual `A -> B -> A` chain is capped at a fixed nesting depth (5) to break accidental cycles.

### Force Semantics and Once Markers

`/automation force <n>` -- and any forced `invoke_automation` -- bypasses both the *checking* and the *writing/updating* of per-rule once-per-day markers as well as the silent-period guard. In other words a forced or delegated poke never consumes an automation's daily budget, so repeated forced runs stay safe. Human-interaction cooldowns are intentionally **not** bypassed either way, and the top-level `video_player_suppression` stand-down guard is also never bypassed by force.

### Daily Once Markers (`once`)

Adding `once: true` to a rule makes it act **at most once per local calendar day -- per time window when the rule declares a `time_of_day` condition**. A rule covering several periods (e.g. `[evening, night]`) therefore gets one slot in EACH listed window: an early pre-dawn firing consumes only that window's budget and never blocks actual dusk, while re-firing inside the same window stays blocked. When its conditions first match and commands are dispatched -- or every targeted device is deferred due to recent human interaction -- the rule records a marker in Redis (`auto:<name>:once:<rule slug>`, suffixed with the active period as `<...>:<period>` for window-scoped rules) storing the local calendar day, and stands down for the rest of that window; humans then keep full control until the next window opens. If nothing happened at all (no dispatches, no deferrals), the rule keeps retrying on later ticks. Markers self-reset each day; storage failures fail open.

**A `time_of_day` gate counts no matter where it sits in the conditions tree** -- at the top level, or nested inside `any_of:` / `all_of:`. A rule whose window list lives in an `any_of` branch gates on that window exactly like a top-level one, so it must get the same per-window budget; a rule whose gate is nested used to receive a single bare all-day marker, which let a 00:26 pre-dawn firing silently eat the 18:33 dusk firing. Only rules with **no** `time_of_day` gate anywhere are all-day-scoped (one slot per calendar day, resetting at local midnight). `/automation debug <name>` shows the condition summary, and the skip log names the window (`already acted today during evening`) when the rule is window-scoped.

### Invoke-Only Rules (`forced_only`)

Adding `forced_only: true` to a rule makes it participate **only in forced or delegated runs** -- `/automation force <n>` or another automation's forced `invoke_automation`. Natural timer/sensor ticks skip such rules entirely, even when their conditions hold and no once-marker is set. This is useful for rules that should only act when explicitly poked by another automation (e.g., a restore rule that answers a hand-off) without ever firing on their own. Because forced runs neither check nor write once-markers, an invoke-only rule can re-fire on every delegation.

### Re-Assert State (`reassert_state`)

Adding `reassert_state: true` to a rule tells the engine to dispatch its commands with **no-op suppression bypassed**: each targeted device receives `{bypassNoOpSuppression: true}` and sends the command onto the wire even if its last *reported* state already equals the commanded value.

Why this exists: a device can execute an automation command and never report back (a plug relay flips off while still advertising `state:"ON"`). The cache then keeps describing the pre-command world, and a later restore command gets dropped as "already at target" -- freezing the stale value in place. That is exactly how the home-theater ambient lights failed to come back after the player went offline (see [ht-lights-bug](../ht-lights-bug.md)). Forcing the command guarantees a hand-off/restore reaches the radio.

Scope and safety:

- It is **per-rule** and applies only to devices targeted by *that* rule; it does not leak onto other rules' targets in the same run.
- It covers **natural** runs too. Forced/delegated runs already bypass suppression automatically, so the flag matters for restore paths that fire on their own schedule -- e.g. the `paused`/`stopped` ambient-lighting restore in `home-office-video.yaml`, which is triggered naturally rather than forced.
- It complements the automatic unverified-state bypass in `DeviceBase` (which fires whenever any prior automation command expired without confirmation); the explicit flag additionally guarantees a re-send even when no such marker is present.
- Spam-safe: each flagged dispatch sends at most one extra publish per device, and healthy confirmed states are untouched unless the flag is set. `/automation debug <name>` and `/automation coverage <name>` render a `[reassert]` tag next to `[once/day]` / `[invoke-only]` so the flag stays visible.


### Rule Match History

Every rule that matches is recorded by the automation that evaluated it: the last 25 matches per automation, newest first, each carrying the automation name, rule name, timestamp, what triggered the run (`timer`, a device topic, `manual`), the forced flag and whether the match led to an action. Matches are published live on the EventBus (`automation:ruleMatched`, then `automation:ruleActed` when the run dispatches a command, defers a device to recent human interaction, or delegates), which is what feeds the [UI rules window](ui/index.md). `/automation debug <name>` prints the same history for one automation. Recording is in-memory only -- a restart starts from an empty history, and a match is recorded even when it produced nothing, which is exactly the case the rules window shows as `matched` rather than `acted`.

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
- **Dimmers**: structured object commands pass through verbatim -- e.g., `Salon_Dimmer: { state: 'ON', brightness: { l1: 50, l2: 25 } }`; the DualDimmer maps each percentage into its channel's level range at publish time (a bare `{brightness: N}` sets levels only and never switches the relay on)
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

Ordered device choreography with an optional loop driver. Each entry under `sequences:` is one sequence instance — a first-class being alongside devices and automations. Copy `etc/sequence/sequences.yaml.dist` to `sequences.yaml` and customize; a missing file or bad entries warn at startup but never crash it. Edits on disk take effect immediately through `/config reload` — engaged loops stop gracefully first, then the registry is rebuilt from the fresh file (an unreadable file keeps the current registry intact); no restart needed. Full design rationale lives in [doc/architecture/sequence-entity.md](./architecture/sequence-entity.md).

### Entry schema

| Key | Required | Meaning |
|-----|----------|---------|
| `name` | yes | Friendly name; internally slugified (`'Salon Hazard Light'` → `salon_hazard_light`). Slugs must be unique across all sequences |
| `delay_ms` | no | Sequence-level inter-step pause (duration like `"500ms"` / `"2s"`, or plain ms number). Absent ⇒ **multi-device endpoint mode** — every step fires back-to-back |
| `devices` | simple form | Ordered list of names (or `{device, command?, delay_ms?}` objects). ON sends each device `'ON'`; OFF sends each device `'OFF'` in the same order |
| `on` / `off` | rich form | Explicit step lists; a step is `{device, payload?, delay_ms?}`. `payload` passes through `receiveCommand()` verbatim (any shape: strings, `{state}`, `{position:N}`, `{state,brightness:{l1,l2}}`, ...). Missing `off:` defaults to plain OFF over the `on` devices |
| `loop` | no | Block making this a looping sequence: `enabled: true`, `cycle: once \| continuous`, `off_delay_ms: auto \| duration` (gap between end of ON run and start of OFF run), `on_delay_ms: auto \| duration` (gap between end of OFF run and next ON run; only fires on continuous cycles). `auto` = phase starts right when the previous one finishes |

Exactly one of `devices:` (simple) or `on:` (rich) must be present per entry. Durations parse via `temporal.parseDurationMs()` (`"500ms"`, `"3m 45s"`, plain ms numbers); invalid values warn and degrade to absent/auto. Referenced devices that don't exist make their steps inert with a warning — remaining steps still execute.

### Simple form + pacing

```yaml
sequences:
  - name: 'Ambient Lights'
    delay_ms: '500ms'
    devices:
      - 'Salon Ambient Left'
      - 'Bedroom Ambient'
      - device: 'Kitchen LED Strip'   # object entries allow per-step overrides
        command: 'ON'
        delay_ms: '800ms'
```

### Rich form + loop (hazard light oscillation)

```yaml
  - name: 'Salon Hazard Light'
    loop:
      enabled: true
      cycle: continuous
      off_delay_ms: '2s'   # dwell before the OFF swing
      on_delay_ms: '2s'    # dwell before the next ON swing
    on:                               # phase A -- low values
      - device: 'Salon Dimmer'
        payload: { state: 'ON', brightness: { l1: 1, l2: 25 } }
    off:                              # phase B -- high values (the swing back)
      - device: 'Salon Dimmer'
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

periodic:
  message: "What is the temperature and humidity outside?..."  # Periodic prompt sent at configured intervals

ui:
  default_greeting: "Hello! How can I help?"
```

> The `devices.mechanism` section only needs entries for devices with **non-obvious** names. A device named "Kitchen Light" doesn't need an annotation, but a socket named "Patio Outlet" powering the garden light strip does.

### TTS Bundle (`tts.yaml`)

Defines voice model settings and audio effects per locale. Referenced by the TTS service when generating speech output. It also carries the optional `profiles:` registry of named framing sets (`intro` / `outro` / `intro_spacing`) that speakers reference by name through `tts_profile:`; profiles never carry `output_endpoint`. See [TTS Integration](installation/tts-integration.md).

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

A plain text file: **one proverb per line**, separated by a line feed. The weatherman automation draws a random line from it (via `src/lib/randomLine.js`, which streams the file instead of loading it) and interpolates it into the `{% proverb %}` token of the `ai_proverb` / `tts_proverb` keys in `weatherman.yaml` when `add_proverb: true` is set in `etc/automation/tts-weatherman.yaml`.

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