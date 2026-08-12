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

The input mode determines how the bottom line is interpreted:

- **command** — typed text logs to the buffer and triggers slash-command dispatch if it starts with `/`
- **chat** — typed text sent silently to AI without logging to the visible buffer

## Channels

Windows are routed through *channels* defined in `etc/automaton.yaml`. The `ChannelManager` singleton loads these definitions at startup and provides lookup by id and shortcut key.

Channels use an IRC-style naming convention:

```yaml
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
