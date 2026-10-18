# Terminal UI

> **In this section:** [Commands Reference](./commands/index.md)

The optional terminal-kit UI shows logs, devices, rules, AI chat, and speech output. Start with `--no-ui` to disable it.

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

Below `ui.layout.min_width` (default 74 columns), the UI shows a resize warning.

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
| `RulesWindow` | `rules` | command | Automation call boxes, one tab per automation |

> The `ai` and `tts` windows are created only when their backing services are configured (`AI_API_URL` + model for AI, `TTS_API_URL` for TTS). When a service is disabled or unconfigured its window simply does not exist in the UI.

**Device header:** localized date plus raw sunrise and sunset (`HH:MM`), refreshed every five seconds. Missing coordinates show `--:--`.

**Device sections:** Sensors, Mechanisms, Remotes, and Unclassified. Unclassified devices need a type/name mapping in `etc/device/zigbee.yaml`. The Humid column shows air humidity, falling back to soil moisture.

**Device columns:** widths fit content without truncating names. Shared columns align across sections; missing values are blank. Mechanisms show Name, State, and Origin; battery devices also show Batt.

**Rules window:** one tab per automation, showing its last three calls with trigger, outcome, matched rules, and reason. Forced calls have `!`. Green means acted; grey means no action; yellow means suppressed/skipped; red means context build failed. Calls arrive live and refresh every five seconds. `/rules <name>` focuses a tab; `/rules all` shows all boxes; `/automation debug <name>` shows full history.

**Typed speech:** `ui.tts_profile` selects a locale framing profile. Empty or unknown profiles add no jingle; see [TTS Integration](../installation/tts-integration.md).

The input mode determines how the bottom line is interpreted:

- **command** — typed text logs to the buffer and triggers slash-command dispatch if it starts with `/`
- **chat** — typed text sent silently to AI without logging to the visible buffer

### AI Transcript Prefixes

AI transcript lines use `ai:userMessage` / `ai:assistantMessage` events for both local input and the MQTT bridge:

| Prefix | Meaning |
|--------|---------|
| `<you>` | prompt typed in this window (`source: 'ui'`) |
| `<remote>` | prompt from an external client — MQTT web client / STT backend (`source: 'mqtt'`) |
| `<system>` | periodic system prompt (weatherman, greeter, gardener) |
| `<NAME>` | assistant reply — the name is `ai.name` (`<AI>` when unset); rendered red as `[ERROR: …]` when the turn failed |

Lines starting with `*` are status notes rather than conversation: `* AI is thinking...` and
`* AI thought for N seconds` around each turn, and `* AI turned ON Living Room Light` for every device
interaction the assistant performs.

**Assistant name:** `ai.name` fills the system-prompt name, transcript prefix, and action lines. Empty values use `AI`; `/config reload` applies changes.

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

Start GNU Screen with an xterm profile for full key and color support:

```bash
screen -T xterm-256color
```

The default `TERM=screen` profile uses basic colors.

---

## Source Code Layout

| Path | Contents |
|------|----------|
| `src/ui/ui.js`, `channels.js` | UI lifecycle and channel routing |
| `src/ui/layout/` | Screen layout |
| `src/ui/widgets/` | Input, status bar, and slot widgets |
| `src/ui/windows/` | Window rendering and buffers |
| `src/ui/commands/` | Slash commands and registry |
