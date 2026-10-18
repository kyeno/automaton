# Terminal UI Commands

> **[← Back to Terminal UI](../index.md)**

Slash commands are available in interactive UI mode. `--no-ui` disables them.

## Quick Reference

| Command | Description |
|---------|-------------|
| `/help` | List all available commands |
| `/clear` | Clear current window buffer |
| `/pgup` | Scroll page up (back through history) |
| `/pgdn` | Scroll page down (forward to live tail) |
| `/status` | Dump StateService contents |
| `/config [arg]` | Inspect the main config & apply live overrides: `debug` dumps it in full, `set <path> <value...>` targets the main section, `reload` re-reads files from disk (bare invocation shows usage) |
| `/automation [arg]` | Manage automations: `list`, `debug <name>`, `coverage <name> [legacy]` (static timing-gap analysis), `run <name>`, `force <name> [first]` (bare invocation shows usage) |
| `/interaction [arg]` | Manage interactions: `list`, `debug <name>`, `run <name> [actionType]` (bare invocation shows usage) |
| `/device [arg]` | List & inspect Zigbee + network devices: bare counts/help, `list [zigbee\|network]`, `debug <name>` cross-registry lookup |
| `/sequence [arg]` | Run device sequences & control their loops: bare list with live status, `run <name> [ON\|OFF]`, `loop start <name>`, `loop stop <name>` (names may be slugs or friendly names) |
| `/quit` (`/exit`, `/q`) | Exit Automaton |
| `/win [arg]` | Switch window by shortcut number or id |
| `/rules [arg]` | Drive the rules window tabs: bare lists the automations, `<name>` focuses one automation's box, `all` shows every box again |

`/automation run <name>` evaluates immediately with normal guards. `force` bypasses silence and daily-marker checks/writes, but retains human cooldowns and video suppression. Add `first` to force the dated first-of-day opening line.

`/config set <path> <value>` applies schema-validated YAML values in memory only. Invalid changes are rejected. `debug` and `set` target the main config.

`/config reload` validates candidate files before swapping them into memory. Failure keeps the live configuration; success discards runtime overrides and reports them. Changed locale/AI/TTS settings refresh their initialized services and relevant window output; AI changes reset the conversation. Window-definition changes require a restart. Sequence reload stops loops gracefully and rebuilds entries; unreadable sequence files retain the existing registry.

### Keyboard Shortcuts

Window switching can also be triggered via keyboard shortcut `Esc + <number>` (e.g., `Esc 1` switches to logs). This bypasses the command system and works synchronously.

---

## Architecture Overview

Commands use a pluggable container pattern that auto-discovers implementations at startup:

```
src/ui/commands/
├── base/commandBase.js           # Abstract base class
├── container/commandContainer.js # Singleton registry + autoloader
├── automationCmd.js              # /automation list|debug|run
├── clearCmd.js                   # /clear command
├── configCmd.js                  # /config debug|set|reload (main config only)
├── deviceCmd.js                  # /device list|debug
├── helpCmd.js                    # /help command
├── interactionCmd.js             # /interaction list|debug|run
├── pgdnCmd.js                    # /pgdn command
├── pgupCmd.js                    # /pgup command
├── quitCmd.js                    # /quit, /exit, /q
├── rulesCmd.js                   # /rules <name> | all (rules window tabs)
├── statusCmd.js                  # /status command
└── winCmd.js                     # /win <shortcut_or_id>
```

### Two-Phase Dispatch

All commands are routed through CommandContainer's two-phase dispatcher:

1. **Exact match** — if input equals a registered verb name or alias, execute immediately with no arguments
2. **Prefix match** — split at first space; if any registered verb + " " is a prefix of the input, extract everything after the space as the argument and pass it to that command's `execute()` method

`/clear` uses exact lookup; `/win 2` dispatches `win` with argument `2`.

### How It Works

The autoloader scans `src/ui/commands/*.js`, constructs each `CommandBase` subclass
with shared context, and registers its name and aliases. UI input drops the leading `/`
and calls `CommandContainer.handle()`, which selects the command and calls `execute(args)`.

---

## Writing Custom Commands

Create a new file in `src/ui/commands/` following this template:

```javascript
/**
 * My Debug Command -- brief description of what it does.
 */
'use strict'

import CommandBase from './base/commandBase.js'

class MyDebugCmd extends CommandBase {
    /** Command verb without leading slash (use hyphens for multi-word names) */
    static name = 'my-debug'

    /** One-line description shown in /help output */
    static description = 'Run my custom debug action'

    /** Set to true if your execute() method parses an argument string */
    static takesArgs = false

    /** Alternative verbs that route to this same command (optional) */
    // static aliases = ['md']  // would also match /md

    /**
     * Called when user types "/my-debug" or "/my-debug [args]"
     * @param {string} args - Raw argument string after the verb (empty string if no args)
     */
    async execute(args) {
        // Print text to the active window
        this.ctx.print(`Running my-debug with args: ${args}`)
    }
}

export default MyDebugCmd
```

The command is automatically discovered on next startup — no configuration or registration needed.

### Static Properties Reference

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | **Yes** | Command verb without leading slash. Use hyphens for multi-word names (`'debug-state'`). |
| `description` | `string` | No | One-line description shown in `/help` output. Defaults to empty string. |
| `takesArgs` | `boolean` | No | Whether the command accepts a free-form argument. When true, `/help` annotates the entry with `[arg]`. Defaults to `false`. |
| `aliases` | `Array<string>` | No | Alternative verbs routing to this same instance. E.g., `['exit', 'q']` means `/quit`, `/exit`, and `/q` all work. Each alias is registered alongside the primary name for instant exact-match dispatch. |

### Naming Conventions

- **File names**: lowercase with `.Cmd.js` suffix (e.g., `debugStateCmd.js`)
- **Static `name`**: use hyphens for multi-word verbs (e.g., `'debug-state'`)
- The resulting slash command would be `/debug-state`

---

## Context Object Reference

Each command receives a context object (`this.ctx`) at construction time providing access to services and helpers:

| Property | Type | Description |
|----------|------|-------------|
| `print(...args)` | Function | Print text to the currently active window |
| `activeWindow` | BaseWindow \| null | Getter returning the current active window instance |
| `switchWindow(idOrShortcut)` | Function | Switch to a named window by id or shortcut number |
| `stateService` | StateService | Access application state key-value store |
| `logger` | LoggerService | Log messages via debug/info/warn/error levels |
| `shutdown()` | Function | Exit Automaton gracefully |
| `commandContainer` | CommandContainer | Reference back to the container itself (for introspection) |

### Example: Using the Context

```javascript
async execute(args) {
    // Check if we have an active window before printing
    const win = this.ctx.activeWindow
    if (!win) {
        this.ctx.logger.warn('No active window available', 'MyDebug')
        return
    }

    // Query state service
    const dump = this.ctx.stateService.dump()
    const keys = Object.keys(dump).filter(k => dump[k] != null)

    // Output results
    this.ctx.print(`Active states (${keys.length}): ${keys.join(', ')}`)
}
```

---

## Built-in Commands Detail

All commands are auto-discovered `.Cmd.js` files — there is no internal command logic in Ui.

### `/help`

Lists all registered commands with descriptions, aliases, and argument indicators. The output is dynamically generated from the command registry:

```
Commands:
  /clear          -- Clear current window buffer
  /pgdn           -- Scroll page down
  /pgup           -- Scroll page up
  /quit (exit, q) -- Exit automaton gracefully
  /status         -- Show system status dump
  /win [arg]      -- Switch window by shortcut number or id
```

Adding a new `.Cmd.js` file automatically includes it in help output.

### `/clear`

Calls `.clear()` on the active window instance, resetting its buffer. Safe to call even when no window has focus (no-op).

### `/pgup` / `/pgdn`

Scrolls the active window one page up or down through its history buffer. These are also triggered by physical PgUp/PgDown keyboard keys regardless of input mode.

### `/status`

Dumps all non-null entries from StateService to the active window. Useful for debugging application state during development:

```
System Status:
  ui.active = true
  device.living-room.light.on = true
  automation.weatherman.last_run = "2026-08-11T..."
```

### `/quit` (`/exit`, `/q`)

Triggers graceful shutdown via `Ui.shutdown()`. Cleans up UI resources then exits the process with code 0. Registered under canonical name `'quit'` with aliases `['exit', 'q']` — all three verbs route to the same command instance.

### `/win <shortcut_or_id>`

Switches to a window by numeric shortcut or internal id:

| Example | Result |
|---------|--------|
| `/win 1` | Switch to window with shortcut `1` (typically logs) |
| `/win 3` | Switch to window with shortcut `3` (typically AI) |
| `/win ai` | Switch to window with id `'ai'` |

### `/rules [name | all]`

Drives the tab focus of the [rules window](../index.md), switching to that window first when the command was typed elsewhere:

| Example | Result |
|---------|--------|
| `/rules` | Lists the automations the window knows and which tab is focused |
| `/rules Rollers` | Focuses that automation: only its box is rendered, its tab label starred. Name resolution is case-insensitive; an unknown name is refused and the known names are listed |
| `/rules all` | Clears the focus, so every automation box is rendered again |

Tab completion offers `all` plus every automation the window has seen.

---

## Registry & Config Commands Detail

### `/config [arg]`

`debug` and `set` operate on the main config; usage output shows its path.

| Invocation | Behaviour |
|------------|-----------|
| `/config` | GNU-style usage help + loaded section names + main config path |
| `/config debug` | Metadata header (file, validator status, top-level key count) followed by a full dump of every live parameter rendered as a box-drawing tree -- containers expand under branch glyphs, small records collapse to one line; the tree is printed through the whitespace-preserving preformatted path so indentation survives window wrapping |
| `/config set <path> <value...>` | Dry-runs one override through startup validation against the main section; clean changes commit via the same mutation path startup uses (`Applied [main] <path>: old -> new`) |
| `/config reload` | Two-phase safe re-read from disk, targeted subsystem refreshes plus a live sequence-registry rebuild (see note above) |

Stray arguments after `debug`, missing values for `set`, schema violations, type mismatches and unknown parameters are all reported line-by-line without crashing -- see the notes above for exact semantics.

### `/interaction [arg]`

Bare `/interaction` shows usage and registered interaction names.

| Invocation | Behaviour |
|------------|-----------|
| `/interaction list` | Tree listing: name, kind (`yaml`/`custom`), action count per interaction |
| `/interaction debug <name>` | One interaction in detail: per-action rows (`type=… targets=device:COMMAND … calls=…`), or top-level config keys when no actions exist. Name resolution is case-insensitive; odd YAML shapes (null entries, scalar targets) never break rendering |
| `/interaction run <name> [actionType]` | Calls that interaction's `execute()` now. When two or more words are given and only the leading part is a registered name, the trailing word selects which YAML-defined action fires (`{action: "<type>"}` payload); otherwise the whole string is treated as the name |

Kind metadata comes from `InteractionContainer.getSourceInfo(name)`, with a prototype fallback.

### `/device [arg]`

Lists Zigbee and network devices, excluding the Zigbee bridge. Bare invocation shows counts, usage, and known names.

| Invocation | Behaviour |
|------------|-----------|
| `/device list` | Both sections under labelled headers (`-- Zigbee devices (N) --`, `-- Network devices (N) --`) |
| `/device list zigbee` / `list network` | One section only (filter token is case-insensitive; unknown filters report the valid options) |
| `/device debug <name>` | Cross-registry lookup, case-insensitive. A single hit renders its full detail view (Zigbee: type/id/last-state JSON/origin/active kind; network: category/IP/presence). Names present in BOTH registries are reported as ambiguous and each side renders under a labelled block |

Network presence renders `online` / `offline`, or `unknown` for cold/expired cache or missing Redis. Missing services render empty sections.

### `/sequence [arg]`

Controls entries in `etc/sequence/sequences.yaml`. Names accept slugs or friendly names case-insensitively; tab completion offers subcommands and registered sequences.

| Invocation | Behaviour |
|------------|-----------|
| `/sequence` | All sequences: name, slug, active state + phase, loop flag |
| `/sequence run <name> [ON\|OFF]` | Single blocking run down the step list (default ON); rejected with a note when that instance is already running |
| `/sequence loop start <name>` | Engage the loop session (`cycle: once \| continuous` per config); refused when busy or no `loop:` block is configured |
| `/sequence loop stop <name>` | Graceful stop: between phases cancels the inter-phase timer straight to idle; mid-phase lets the in-flight step-list finish first so no device ends half-configured |
