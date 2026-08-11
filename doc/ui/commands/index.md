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
| `/quit`, `/exit`, `/q` | Exit Automaton |

### Window Shortcuts

Window shortcuts are defined by channel configuration (`etc/automaton.yaml`). By default:

| Shortcut | Channel | Purpose |
|----------|---------|---------|
| `/1` | Logs | System log viewer |
| `/2` | Device | Zigbee device status monitor |
| `/3` | AI | LLM chat assistant |

These can also be triggered via keyboard shortcut `Esc + <number>` (e.g., `Esc 1` switches to logs).

---

## Architecture Overview

Commands use a pluggable container pattern that auto-discovers implementations at startup:

```
src/ui/commands/
├── base/commandBase.js          # Abstract base class
├── container/commandContainer.js # Singleton registry + autoloader
├── clearCmd.js                  # /clear command
├── helpCmd.js                   # /help command
├── pgupCmd.js                   # /pgup command
├── pgdnCmd.js                   # /pgdn command
└── statusCmd.js                 # /status command
```

### How It Works

1. At UI initialization, **CommandContainer** scans `src/ui/commands/*.js` using the Autoloader utility
2. Each file exports a class extending `CommandBase` with a static `name` property
3. The container instantiates each command and registers it under its name
4. When Ui receives an unknown slash verb, it delegates to `CommandContainer.execute(verb, args)`
5. The container looks up the registered instance and calls `.execute(args)`

This follows the same container + autoloader pattern used by DeviceContainer, AutomationContainer, and InteractionContainer — one class per entity, zero manual registration.

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

    /**
     * Called when user types "/my-debug [args]"
     * @param {string} args - Raw argument string after the verb
     */
    async execute(args) {
        // Print text to the active window
        this.ctx.print(`Running my-debug with args: ${args}`)
    }
}

export default MyDebugCmd
```

The command is automatically discovered on next startup — no configuration or registration needed.

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
| `stateService` | StateService | Access application state key-value store |
| `logger` | LoggerService | Log messages via debug/info/warn/error levels |
| `shutdown()` | Function | Exit Automaton gracefully |
| `commandContainer` | CommandContainer | Reference back to the container itself |

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

### `/help`

Lists all registered commands with descriptions, plus built-in shortcuts and always-available lifecycle commands. The output is dynamically generated from the command registry — adding a new `.Cmd.js` file automatically includes it in help output.

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

### `/quit`, `/exit`, `/q`

Triggers graceful shutdown via `Ui.shutdown()`. Cleans up UI resources then exits the process with code 0. This handler lives directly in Ui's switch statement rather than going through CommandContainer, as it needs access to Ui's cleanup logic.
