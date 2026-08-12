# Terminal UI Commands

The Automaton terminal UI supports slash commands typed into the input bar at the bottom of each window. Commands are **only available in interactive terminal mode** — they are entirely disabled when running as a system service with `--no-ui`.

## Quick Reference

| Command | Description |
|---------|-------------|
| `/help` | List all available commands |
| `/clear` | Clear current window buffer |
| `/pgup` | Scroll page up (back through history) |
| `/pgdn` | Scroll page down (forward to live tail) |
| `/status` | Dump StateService contents |
| `/quit` (`/exit`, `/q`) | Exit Automaton |
| `/win [arg]` | Switch window by shortcut number or id |

### Keyboard Shortcuts

Window switching can also be triggered via keyboard shortcut `Esc + <number>` (e.g., `Esc 1` switches to logs). This bypasses the command system and works synchronously.

---

## Architecture Overview

Commands use a pluggable container pattern that auto-discovers implementations at startup:

```
src/ui/commands/
├── base/commandBase.js          # Abstract base class
├── container/commandContainer.js # Singleton registry + autoloader
├── clearCmd.js                  # /clear command
├── helpCmd.js                   # /help command
├── pgdnCmd.js                   # /pgdn command
├── pgupCmd.js                   # /pgup command
├── quitCmd.js                   # /quit, /exit, /q
├── statusCmd.js                 # /status command
└── winCmd.js                    # /win <shortcut_or_id>
```

### Two-Phase Dispatch

All commands are routed through CommandContainer's two-phase dispatcher:

1. **Exact match** — if input equals a registered verb name or alias, execute immediately with no arguments
2. **Prefix match** — split at first space; if any registered verb + " " is a prefix of the input, extract everything after the space as the argument and pass it to that command's `execute()` method

This means `/clear` matches exactly (no args), while `/win 2` matches by prefix (verb="win", args="2"). String operations (`startsWith`) are used instead of regex for performance.

### How It Works

1. At UI initialization, **CommandContainer** scans `src/ui/commands/*.js` using the Autoloader utility
2. Each file exports a class extending `CommandBase` with static properties: `name`, `description`, `takesArgs`, and optionally `aliases`
3. The container instantiates each command with a shared context object and registers it under its name plus all aliases
4. When Ui receives user input, it strips the leading `/` and delegates to `CommandContainer.handle(rawInput)`
5. The container performs exact-match lookup first, then prefix-match fallback
6. The matched instance's `.execute(args)` is called

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
