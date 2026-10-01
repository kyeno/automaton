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

### Geolocation (under `locale`)

Observer coordinates that power the sun-based rule shorthands (`sundawn` / `sundusk`) used by the merged-gate conditions and `hour:` bounds described in [Automation Rules](#4-automation-rules-etcautomationyaml). They live inside the `locale:` section alongside language/time format:

```yaml
locale:
  geo_latitude: 52.2307   # WGS84 decimal degrees; positive = north (-90..90)
  geo_longitude: 21.0122  # WGS84 decimal degrees; positive = east  (-180..180)
```

- **`locale.geo_latitude`** / **`locale.geo_longitude`** -- Your site's position (decimal degrees, WGS84). Both are optional numbers; when missing/invalid the sun shorthands resolve to nothing and any gate relying on them fails closed (the rule simply never fires) rather than guessing. The values feed `sunrise-sunset-js`, which computes real dawn/dusk instants for the current calendar day.

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

Polls media players over their HTTP APIs and exposes a normalized status (`playing`, `paused`, `stopped`, `offline`) to rules via the `video-player` condition. Each entry is an object -- **not** a bare IP string -- so the presence monitor does not treat it as a ping target:

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

rules:
  - name: 'Human-readable rule name'
    once: true                          # Optional: act at most once per calendar day (per time-window for rules with a time-of-day condition)
    forced_only: true                   # Optional: participate only in forced/delegated runs (e.g., delegated light restore); natural ticks skip it entirely
    conditions:
      time-of-day: [morning, noon]     # Day period(s)
      season: [winter]                 # Season(s), optional -- spring/summer/autumn/winter
      illuminance: { gte: 20 }          # Sensor threshold
      temperature: { lt: 25 }
      presence: hostname1               # Network host present
    targets:                            # Per-target actions; key = registered device name
      Device_Name_A: OPEN               # with spaces replaced by underscores, casing kept
      Device_Name_B: CLOSE              # e.g. "Kuchnia Gniazdo LED" -> Kuchnia_Gniazdo_LED
```

### Day Periods (`time-of-day`)

The `time-of-day:` condition matches against five **fixed clock-based** periods that are identical year-round (hour-granular, no gaps or overlaps):

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
| `hour: { gte: 'sunrise' }` / `{ lte: 'sunset' }` | At/after real sunrise, before/at real sunset (also `sundawn`/`sundusk`) |

Unlike `time-of-day`, it is evaluated directly from the live clock on every tick -- no period table, no season logic -- which makes it the right tool for wall-clock schedules like 'close everything after 23h' where winter dusk can arrive during calendar afternoon. It composes with other conditions as usual (all must hold), so `hour: { gte: 23 }` + `illuminance: { lte: 15 }` fires only in true darkness past 23h and stays inert at pre-dawn hours even when equally dark. Plain numeric bounds keep one-hour granularity; a bound written as a sun token (`'sunrise'`/`'sunset'`) switches that comparison to exact sub-hour precision against the computed dawn/dusk instant, so `hour: { gte: 'sunrise' }` opens right at first light rather than the next whole hour. Malformed values or an unresolvable sun token fail closed (the rule never matches) rather than passing silently.

The static coverage analyzer mirrors these semantics exactly and treats `hour` as reserved, so it never appears as a sensor dimension in scenario grids or gap reports; a sun-token bound is treated as satisfied there since real dawn/dusk times are not part of the static clock grid.

### Merged Sun/Clock Gate Conditions (`after_latest_of` / `after_earliest_of`)

Where `time-of-day`, `hour` and `season` each assert one fixed boundary, these two conditions let a single rule wait for the **later** of several candidate moments ("whichever is later") or open at the **earlier** of them ("whichever is earlier"). Each condition takes a list of candidates; the rule fires once "now" has passed the selected extreme of those candidates' resolved instants:

| Key | Fires when now >= ... | Use case |
|-----|----------------------|----------|
| `after_latest_of: [a, b]` | the **latest** (max) of the candidates | "at dusk *but not before* 19h" -- summer sunset ~21h wins, winter falls back to 19h |
| `after_earliest_of: [a, b]` | the **earliest** (min) of the candidates | "at dawn *or by* morning start" -- early summer dawn wins, late winter defers to 05h |

Each candidate resolves to an absolute instant on the current day:

| Candidate form | Resolves to |
|----------------|-------------|
| `"sundusk"` / `"sunset"` | today's real sunset (`sunrise-sunset-js`, from `locale.geo_latitude`/`locale.geo_longitude`) |
| `"sundawn"` / `"sunrise"` | today's real sunrise |
| `19` or `{ hour: 19 }` | today at 19:00 local |
| `'morning'` / `{ 'time-of-day': 'morning' }` | the start-of-day hour of that period (e.g. morning -> 05:00) |

Examples:

```yaml
# Turn ambient lamps on at dusk, but never before 7pm (the later of the two governs).
conditions:
  after_latest_of: [sundusk, { hour: 19 }]

# Switch off leftover lights at first light, no later than the morning window opens.
conditions:
  after_earliest_of: [sundawn, 'morning']
```

They compose with every other condition as usual (all must hold), so a rule can pair them with strict gates -- e.g. `season: spring` + `illuminance: { lte: 15 }` + `after_latest_of: [sundusk, { hour: 19 }]`. Unresolvable candidates are dropped; if **none** resolve (no geo configured, unknown shorthand, empty list) the gate fails closed and the rule never fires. The static coverage analyzer treats both keys as reserved/satisfied (like `state-changed-ago-minutes`) since they depend on real sun times rather than the clock-hour grid.

### Target Keys (`targets:`)

There is no separate declaration section: each rule's `targets:` map addresses devices directly by **target key** — the registered friendly name trimmed, whitespace runs collapsed to single underscores, original casing preserved (`Salon Roleta Okno Lewe` → `Salon_Roleta_Okno_Lewe`). The union of all rule-level keys defines an automation's addressable set; there are no separate aliases to invent or keep in sync.

Every automation validates this wiring at activation time against the live device container and logs warnings for problems that would otherwise be silently inert: unknown keys (typos or renamed devices), keys resolving to non-actuator device types (sensors, remotes...), and duplicate keys (two friendly names collapsing onto one key, so only one of the devices is addressable). An automation whose declared targets ALL fail validation fails fast -- the container skips registering just that instance instead of running it silently inert. Automations that declare no targets at all (speech-only or pure `invoke_automation` flows) are valid and simply skip device dispatch.

### Timer Interval (`timer_interval`)

The optional `timer_interval` key controls how often an automation evaluates on its periodic timer. It accepts human-readable durations made of `<integer><unit>` tokens where the unit is `d` (days), `h` (hours), `m` (minutes) or `s` (seconds):

```yaml
timer_interval: "90s"      # every 90 seconds
timer_interval: "3m 45s"   # tokens combine: every 3 minutes 45 seconds
```

- Omitting the key disables the timer entirely -- the automation becomes event-driven only. Legacy numeric `timer_interval_ms` remains supported; when both keys are present, `timer_interval` wins.
- Invalid values log a warning and disable the timer (fail-open). Values above ~24.8 days (the 32-bit `setInterval` limit) are rejected.

### React-On-Change Gate (`trigger_on_change_only`)

The optional `trigger_on_change_only: true` key turns the periodic timer into a pure safety net. When enabled, a scheduled (`timer`) tick is **skipped entirely** unless one of the automation's monitored subjects actually transitioned since its last evaluation. Monitored subjects are derived automatically from the `presence` (network) and `video-player` rule conditions -- the hosts those conditions watch. Event-driven runs (a real EventBus topic) and forced runs always proceed regardless, since they already represent an explicit reason to act.

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

The optional `video-player` condition gates a rule on media-player status (see `videoPlayers` under Network Hosts). Values accept a single status or a list per host:

```yaml
conditions:
  video-player:
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

- Statuses use the same vocabulary as the `video-player` condition; a host with no recorded status enumerates to `offline`, so it suppresses only when `offline` is listed.
- Individual rules may opt out with `ignore_video_player_suppression: true`. While the guard is active, only exempt rules are evaluated; when no rule opts out, the automation returns early without even building context.
- Unlike `silence_between`, the guard is **never bypassed by `/automation force`** -- a forced run must not create device fights.
- The per-rule `video-player` condition remains the tool for rules that need to *distinguish* player states (e.g. Home Theater Mode's ownership hand-back); the suppression key only replaces the repetitive "not actively playing" allow-list guard duplicated across rules.

With `restore_state_aware: true` (automation level), restore commands are filtered through pre-command snapshots so an automation only undoes changes it made itself; a rule can mark its targets as unconditional with `force_restore: true`. Full snapshot, ownership, and no-op suppression semantics are covered in [Rule Engine Restore & Ownership](architecture/rule-engine-restore-semantics.md).

### Delegating to Other Automations (`invoke_automation`)

A rule can hand control to one or more loaded automations instead of -- or alongside -- issuing device commands itself. This is how [Home Theater Mode](automations/home-theater-mode.md) hands a room back to its owners when a player goes offline: a single gone rule force-fires both the roller owner and the ambient-lights owner in one rule.

```yaml
rules:
  - name: 'HTPC: player gone - hand back to the room owners'
    conditions: { video-player: { htpc: [offline] } }
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

Adding `once: true` to a rule makes it act **at most once per local calendar day -- per time window when the rule declares a `time-of-day` condition**. A rule covering several periods (e.g. `[evening, night]`) therefore gets one slot in EACH listed window: an early pre-dawn firing consumes only that window's budget and never blocks actual dusk, while re-firing inside the same window stays blocked. When its conditions first match and commands are dispatched -- or every targeted device is deferred due to recent human interaction -- the rule records a marker in Redis (`auto:<name>:once:<rule slug>`, suffixed with the active period as `<...>:<period>` for window-scoped rules) storing the local calendar day, and stands down for the rest of that window; humans then keep full control until the next window opens. If nothing happened at all (no dispatches, no deferrals), the rule keeps retrying on later ticks. Markers self-reset each day; storage failures fail open.

### Invoke-Only Rules (`forced_only`)

Adding `forced_only: true` to a rule makes it participate **only in forced or delegated runs** -- `/automation force <n>` or another automation's forced `invoke_automation`. Natural timer/sensor ticks skip such rules entirely, even when their conditions hold and no once-marker is set. This is useful for rules that should only act when explicitly poked by another automation (e.g., a restore rule that answers a hand-off) without ever firing on their own. Because forced runs neither check nor write once-markers, an invoke-only rule can re-fire on every delegation.

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

## 6. i18n Bundles

Language bundles live in `etc/i18n/{locale}/` where `{locale}` matches BCP 47 tags (`en_US`, `pl_PL`, etc.). Each locale contains an AI bundle, a TTS bundle, and (for the weatherman automation) a speech bundle, a date bundle, and a proverb list:

| File | Purpose | Tracked as |
|------|---------|-----------|
| `ai.yaml` | LLM system prompt, tool descriptions, device roles, UI strings | `.yaml` + `.yaml.dist` |
| `tts.yaml` | Voice model and audio effect settings per locale | `.yaml` + `.yaml.dist` |
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

Defines voice model settings and audio effects per locale. Referenced by the TTS service when generating speech output.

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