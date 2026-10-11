# Terminal UI

> **In this section:** [Commands Reference](./commands/index.md)

Automaton includes an optional IRC-style terminal UI built on [`terminal-kit`](https://github.com/cronvel/terminal-kit). It provides multi-window browsing, live log streaming, device monitoring, AI chat, and slash-command input — all within a single terminal session. The UI is **disabled** when running as a system service (`--no-ui`).

## Layout

The screen is partitioned into three fixed slots by `UiLayoutManager`:

```
┌──────────────────────────────────────┐
│                                      │
│          Main Slot                   │
│      (window content area)           │
│         height = rows - 3            │
│                                      │
├──────────────────────────────────────┤
│ Status Bar (2 lines)                 │
├──────────────────────────────────────┤
│ Input Line (1 line)                  │
└──────────────────────────────────────┘
```

| Slot | Height | Purpose |
|------|--------|---------|
| **Main** | `rows − 3` | Active window content (logs, devices, AI chat) |
| **Status** | 2 lines | Dynamic widgets: time, channel name, backscroll indicator, activity pings |
| **Input** | 1 line | Slash commands or AI chat messages |

If the terminal width drops below 50 columns, rendering is suppressed and a "TERMINAL TOO NARROW" warning is shown instead.

### Status Bar Widgets

The status bar renders configurable widget groups per line from configuration (`etc/automaton.yaml`). Available widget types:

| Widget Type | Description |
|-------------|-------------|
| `time` | Current clock time |
| `time_of_day` | Period label (morning / afternoon / evening / night) |
| `state` | Key-value state indicators with true/false icons (e.g., `[o] MQTT`) |
| `temp` | Temperature display from device state |
| `separator` | Visual divider between left/right sections |

## Windows

Windows are the primary content area displayed in the main slot. Each window extends `BaseWindow`, which provides:

- **Line buffering** — up to 2000 entries per window (configurable), older lines evicted automatically
- **Scroll offsets** — PgUp/PgDown scroll through history; offset of 0 means following live tail
- **Incremental rendering** — only new lines re-rendered when at tail; full redraw on resize or clear
- **Structured message support** — messages stored as `{ text, prefix }` objects for proper ANSI wrapping on terminal resize

### Window Types

| Class | Channel ID | Input Mode | Purpose |
|-------|-----------|------------|---------|
| `LogWindow` | `logs` | command | Live Winston log stream via custom transport |
| `DeviceWindow` | `device` | command | Zigbee device status monitor |
| `AiWindow` | `ai` | chat | LLM conversation interface |
| `TtsWindow` | `tts` | chat | Live TTS monitor and direct speak input |
| `RulesWindow` | `rules` | command | Recent automation rule matches |

> The `ai` and `tts` windows are created only when their backing services are configured (`AI_API_URL` + model for AI, `TTS_API_URL` for TTS). When a service is disabled or unconfigured its window simply does not exist in the UI.

**Device window header:** the `device` window opens with a line carrying the localized current date (the `date_sentence` template of the active locale's date bundle) plus today's sunrise and sunset, rendered `HH:MM` from the configured coordinates. The times are the raw sunrise/sunset, not the civil-twilight instants used for daylight gating in rules; a location without coordinates shows `--:--`. The header is part of the window's 5-second refresh, so the midnight date rollover and the next day's solar times appear by themselves.

**Device window sections:** the table groups devices by what they are — **Sensors** (readings), **Mechanisms** (actuators: mechanisms, dual switches, dual dimmers), **Remotes** (last action) and, only when any exist, **Unclassified**: devices the container could not map to a type, shown with their last-seen time and battery. Unclassified is deliberately *not* Mechanisms — an unmapped device is a dummy that answers power commands by faking a state change, so a mechanism row for a renamed soil probe would claim control over hardware that cannot be controlled. A row here means the friendly name no longer matches `etc/device/zigbee.yaml`; see [Device Definitions](../configuration.md#3-device-definitions). The Sensors **Humid** column shows `humidity` and falls back to `soil_moisture` when a device reports no air humidity, so soil probes are readable there; air humidity wins whenever a device reports both.

**Rules window:** the `rules` window is a read-only table of the most recent automation rule matches — time, automation, rule name, what triggered the run (`timer`, a device topic, `manual`, and `!` for forced runs) and the outcome: `matched` in grey when the rule fired but produced no action, `acted` in green when it led to a device command, a human-interaction deferral or a delegated automation. The newest match is at the bottom, where the live tail is. Opening the window seeds the table from each automation's own history (the last 25 matches per automation), and rows then arrive live on the `automation:ruleMatched` / `automation:ruleActed` EventBus channels published by `RuleBasedAutomationBase`. `/automation debug <name>` prints the same history for one automation.

**Spoken framing in the TTS window:** text you type into the `tts` window is spoken through the same shared framing rules as every other speaker, using the profile named by `ui.tts_profile` (see [TTS Integration](../installation/tts-integration.md)). Unset or unknown means a plain `{ text }` utterance — no jingle is invented for typed input.

The input mode determines how the bottom line is interpreted:

- **command** — typed text logs to the buffer and triggers slash-command dispatch if it starts with `/`
- **chat** — typed text sent silently to AI without logging to the visible buffer

### AI Transcript Prefixes

The `ai` window keeps one transcript of the whole shared conversation, whoever authored each line. Every
line is rendered from the same EventBus channels (`ai:userMessage` / `ai:assistantMessage`), so a prompt
typed at the keyboard and one published on the MQTT AI bridge (`src/monitor/aiBridgeMonitor.js`, topics
`automaton/ai/*`) take the identical path to the screen:

| Prefix | Meaning |
|--------|---------|
| `<you>` | prompt typed in this window (`source: 'ui'`) |
| `<remote>` | prompt from an external client — MQTT web client / STT backend (`source: 'mqtt'`) |
| `<system>` | periodic system prompt (weatherman, greeter, gardener) |
| `<NAME>` | assistant reply — the name is `ai.name` (`<AI>` when unset); rendered red as `[ERROR: …]` when the turn failed |

Lines starting with `*` are status notes rather than conversation: `* AI is thinking...` and
`* AI thought for N seconds` around each turn, and `* AI turned ON Salon Light` for every device
interaction the assistant performs.

**Assistant name:** `ai.name` in `etc/automaton.yaml` is the single source of truth for how the
assistant is named. It fills the `{% name %}` token in the i18n system prompt (`etc/i18n/<locale>/ai.yaml`),
signs the transcript prefix above, and appears in the device-interaction action lines. Change it and
`/config reload` picks it up on the next turn; leave it blank and every naming site falls back to `AI`.

## Channels

Windows are routed through *channels* defined in `etc/automaton.yaml`. The `ChannelManager` singleton loads these definitions at startup and provides lookup by id and shortcut key.

Channels use an IRC-style naming convention:

```yaml
ui:
  windows:
    - id: logs
      channel: '!log'        # ! = read-only (no user input)
      title: 'Logs'
      shortcut: 1
      readonly: true
    - id: ai
      channel: '#automaton'  # # = interactive
      title: 'AI Assistant'
      shortcut: 3
      readonly: false
    - id: tts
      channel: '#tts'
      title: 'TTS'
      shortcut: 4
      readonly: false
    - id: rules
      channel: '!rules'
      title: 'Rules'
      shortcut: 5
      readonly: true
```

### Channel Prefixes

| Prefix | Meaning | Example |
|--------|---------|---------|
| `!` | Read-only channel | `!log`, `!sensors` |
| `#` | Interactive channel | `#automaton`, `#general` |

### Navigation

Switch between windows using either method:

| Method | Example | Result |
|--------|---------|--------|
| Slash command | `/win 2` | Switch to window with shortcut `2` |
| Keyboard shortcut | `Esc` then `2` | Same as above |

## Input Bar Behavior

The single-line input bar at the bottom of the screen behaves differently depending on the active window's input mode:

### Command Mode (`inputMode = 'command'`)

Used by LogWindow and DeviceWindow. When you press Enter:

1. Text is printed into the current window buffer (visible in history)
2. If text starts with `/`, it triggers slash-command dispatch
3. Otherwise it's treated as a no-op echo

Slash commands are routed through a two-phase dispatcher in CommandContainer:

1. **Exact match** — if input equals a registered verb (e.g., `/clear`, `/quit`), execute immediately
2. **Prefix match** — if input starts with a verb + space, extract everything after the space as arguments and pass them to that command's handler (e.g., `/win 2`)

See [Commands Reference](./commands/index.md) for full list and custom command guide.

### Chat Mode (`inputMode = 'chat'`)

Used by AiWindow. When you press Enter, your message is sent directly to the AI assistant without being logged to the visible window buffer. The response appears in the main content area. Slash commands are still supported via `/help`, etc.

### Running Under GNU Screen

The UI works inside `screen`, but start the session with a modern terminal type so
terminal-kit receives the full xterm keymap and color support instead of its
conservative fallback profile:

```bash
screen -T xterm-256color
```

With the default `TERM=screen` everything still functions correctly (basic colors only);
the flag above simply restores 256-color output and keeps detach/reattach across
differently sized terminals behaving consistently.

---

## Source Code Layout

```
src/ui/
├── ui.js                        # Main Ui class (initialization, event loop, dispatch)
├── channels.js                  # ChannelManager singleton (config-driven routing)
├── layout/
│   └── uiLayoutManager.js       # Three-slot screen partitioner
├── widgets/
│   ├── statusBar.js             # Status bar renderer + activity tracking
│   ├── inputComponent.js        # Input line handler (readline wrapper)
│   └── slotWidgets/             # Individual status bar widget renderers
│       ├── separatorWidget.js
│       ├── stateWidget.js
│       ├── tempWidget.js
│       ├── textWidget.js
│       ├── timeOfDayWidget.js
│       ├── timeWidget.js
│       └── widgetBase.js
├── windows/
│   ├── baseWindow.js            # Abstract base (buffering, scrolling, rendering)
│   ├── logWindow.js             # Winston transport → live log display
│   ├── deviceWindow.js          # Device status monitor
│   └── aiWindow.js              # AI chat interface
└── commands/                    # Pluggable slash-command system
    ├── base/commandBase.js      # Abstract command contract
    ├── container/commandContainer.js  # Autodiscover + registry
    └── *.Cmd.js                 # Concrete implementations
```
