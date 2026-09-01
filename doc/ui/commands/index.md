# Terminal UI Commands

> **[← Back to Terminal UI](../index.md)**

The Automaton terminal UI supports slash commands typed into the input bar at the bottom of each window. Commands are **only available in interactive terminal mode** — they are entirely disabled when running as a system service with `--no-ui`.

## Quick Reference

| Command | Description |
|---------|-------------|
| `/help` | List all available commands |
| `/clear` | Clear current window buffer |
| `/pgup` | Scroll page up (back through history) |
| `/pgdn` | Scroll page down (forward to live tail) |
| `/status` | Dump StateService contents |
| `/config [arg]` | Inspect the main config & apply live overrides: `debug` dumps it in full, `set <path> <value...>` targets the main section, `reload` re-reads files from disk (bare invocation shows usage) |
| `/automation [arg]` | Manage automations: `list`, `debug <name>`, `run <name>`, `force <name>` (bare invocation shows usage) |
| `/interaction [arg]` | Manage interactions: `list`, `debug <name>`, `run <name> [actionType]` (bare invocation shows usage) |
| `/device [arg]` | List & inspect Zigbee + network devices: bare counts/help, `list [zigbee\|network]`, `debug <name>` cross-registry lookup |
| `/quit` (`/exit`, `/q`) | Exit Automaton |
| `/win [arg]` | Switch window by shortcut number or id |

> **Note:** `/automation run <name>` calls that automation's `execute()` immediately with trigger reason `manual` (visible as "Triggered by: manual" under its `Auto:<name>` log context). Normal guards still apply -- silent periods, per-rule daily `once:` markers, and human-interaction cooldowns are respected exactly as for timer or event triggers. `/automation force <name>` dispatches the same way but carries `force: true`: the silent period and any already-consumed per-rule `once:` marker no longer block execution (a forced run that acts refreshes that day's marker), while human-interaction cooldowns are intentionally kept so a manual poke never fights a device someone just touched.

> **Note:** `/config set <parameter.path> <value...>` validates the value exactly like startup loading (`ensureValidated()` + unknown-parameter guard), but reports problems instead of crashing -- a rejected change is never applied. Values are parsed as YAML just like `-c/--config-override`, so numbers, booleans and quoted strings keep their natural types. Changes are runtime-only: the YAML file on disk stays untouched until you edit it by hand or restart. Both `debug` and `set` operate on the main config file only -- its resolved path is shown in the usage output, so there is no per-file selection to get wrong.

> **Note:** `/config reload` re-reads every config file from disk and swaps the result into the running process -- no restart needed for edited values to take effect. It works in two phases: first all candidate files are loaded and validated strictly, and only if everything is clean does anything change; a schema violation anywhere aborts the whole reload with every problem listed verbatim while the live configuration stays byte-for-byte intact (nginx-style). The YAML file is treated as the source of truth, so any memory-only `/config set` overrides are discarded and reported explicitly. After a successful swap, only subsystems that were actually affected get refreshed. Relevance is detected both from automaton.yaml subtrees AND from content movement in the active locale's per-locale bundles (`etc/i18n/{dir}/tts.yaml` + `ai.yaml`), which live outside any config section and are fingerprinted before/after the swap: the i18n bundle refreshes when `locale.*` or the locale's ai.yaml moved, the TTS template (model + params) when `locale.*` or the locale's tts.yaml moved, and the AI conversation (+ provider snapshot) resets when `ai.*`, `locale.*` or the locale's ai.yaml moved -- each one gated behind an "is initialized" check so half-built services are never touched. Stale rendered output in existing windows is cleared whenever any relevant setting moved, and the channel-definition cache resets when `ui.windows` did; adding or removing window definitions still requires a restart because window instances are built eagerly at startup.

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
├── statusCmd.js                  # /status command
└── winCmd.js                     # /win <shortcut_or_id>
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

---

## Registry & Config Commands Detail

### `/config [arg]`

Operates on the **main config file only** — both `debug` and `set` target it directly, so there is no per-file selection token anymore. The resolved main-config path is printed in every usage view to remove any ambiguity about which document is being inspected or overridden.

| Invocation | Behaviour |
|------------|-----------|
| `/config` | GNU-style usage help + loaded section names + main config path |
| `/config debug` | Metadata header (file, validator status, top-level key count) followed by a full dump of every live parameter rendered as a box-drawing tree -- containers expand under branch glyphs, small records collapse to one line; the tree is printed through the whitespace-preserving preformatted path so indentation survives window wrapping |
| `/config set <path> <value...>` | Dry-runs one override through startup validation against the main section; clean changes commit via the same mutation path startup uses (`Applied [main] <path>: old -> new`) |
| `/config reload` | Two-phase safe re-read from disk plus targeted subsystem refreshes (see note above) |

Stray arguments after `debug`, missing values for `set`, schema violations, type mismatches and unknown parameters are all reported line-by-line without crashing -- see the notes above for exact semantics.

### `/interaction [arg]`

Full parity with `/automation`: bare invocation shows usage help with the registered interaction names listed last.

| Invocation | Behaviour |
|------------|-----------|
| `/interaction list` | Tree listing: name, kind (`yaml`/`custom`), action count per interaction |
| `/interaction debug <name>` | One interaction in detail: per-action rows (`type=… targets=device:COMMAND … calls=…`), or top-level config keys when no actions exist. Name resolution is case-insensitive; odd YAML shapes (null entries, scalar targets) never break rendering |
| `/interaction run <name> [actionType]` | Calls that interaction's `execute()` now. When two or more words are given and only the leading part is a registered name, the trailing word selects which YAML-defined action fires (`{action: "<type>"}` payload); otherwise the whole string is treated as the name |

Kind metadata comes from `InteractionContainer.getSourceInfo(name)` (authoritative registry view) with an instance-prototype fallback so minimal containers still render fully.

### `/device [arg]`

Lists and inspects devices across **both** registries — Zigbee devices from DeviceContainer (bridge/coordinator excluded) and network-presence devices from NetworkPresence' configured-device view. Bare invocation prints per-registry counts plus usage help and the de-duplicated union of known names.

| Invocation | Behaviour |
|------------|-----------|
| `/device list` | Both sections under labelled headers (`-- Zigbee devices (N) --`, `-- Network devices (N) --`) |
| `/device list zigbee` / `list network` | One section only (filter token is case-insensitive; unknown filters report the valid options) |
| `/device debug <name>` | Cross-registry lookup, case-insensitive. A single hit renders its full detail view (Zigbee: type/id/last-state JSON/origin/active kind; network: category/IP/presence). Names present in BOTH registries are reported as ambiguous and each side renders under a labelled block |

Network presence states come from `NetworkPresence.getPresence(name)`: warm cache renders `online`/`offline`; cold or expired caches (or a missing Redis) degrade to `unknown` instead of failing the command. Missing services on either side print explicit "(none registered/configured)" notes rather than crashing.
