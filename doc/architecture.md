# Architecture

## Project Structure

```
├── bin/                        # Executable scripts
│   ├── automaton               # Main entry script (loads .env, starts app)
│   ├── automaton-test          # Test runner (syntax + instantiation tests)
│   ├── automaton-lint-check    # Lint check bundle (JSDoc coverage, etc.)
│   └── automaton-generate-docs # JSDoc API documentation generator
├── doc/                        # Documentation
│   ├── ai-conversation-caching.md  # AI conversation persistence & caching behavior
│   ├── ai-human-differentiation.md # AI echo vs human interaction classification
│   ├── architecture.md         # This file — project structure and design
│   ├── configuration.md        # Comprehensive configuration guide
│   ├── example-automations.md  # Included example automations (ttsWeatherMan, etc.)
│   ├── installation.md         # Installation & requirements
│   ├── ui-commands.md          # Terminal UI slash-command reference
│   └── TODO.md                 # Roadmap and known issues
├── etc/                        # Configuration directory
│   ├── automaton.yaml          # Main configuration file
│   ├── automation/             # Automation rule definitions (*.yaml + *.js)
│   ├── device/                 # Device type definitions
│   │   ├── zigbee.yaml         # Zigbee devices by type
│   │   └── network.yaml        # Network presence hosts
│   ├── i18n/                   # Internationalization bundles
│   │   ├── en_US/              # English language pack
│   │   └── pl_PL/              # Polish language pack
│   └── interaction/            # Interaction definitions
├── src/                        # Source code
│   ├── ai/                     # AI assistant and tool builder
│   ├── automation/             # Automation engine
│   ├── device/                 # Device abstractions
│   ├── interaction/            # Interaction engine
│   ├── lib/                    # Shared utilities
│   ├── monitor/                # Network presence monitoring
│   ├── service/                # Core services (MQTT, Redis, config, logging)
│   └── ui/                     # Terminal UI components
│       ├── channels.js         # Channel definitions (window routing)
│       ├── layout/             # Layout manager
│       ├── widgets/            # Reusable UI widgets (status bar, input)
│       ├── windows/            # Window implementations (log, device, AI)
│       └── commands/           # Pluggable slash-command system
│           ├── base/           # Abstract CommandBase class
│           ├── container/      # CommandContainer (autodiscover + dispatch)
│           └── *.Cmd.js        # Concrete command implementations
├── tests/                      # Test scripts
│   ├── test-config-validation.js
│   ├── test-device-instantiation.js
│   ├── test-automation-instantiation.js
│   ├── test-service-instantiation.js
│   ├── test-origin-classification.js
│   ├── test-dist-sync.js
│   ├── test-jsdoc-coverage.js
│   ├── test-sound.js
│   └── test-sound-mario.js
└── var/log/                    # Runtime log files (gitignored)
```

## Architecture at a Glance

Automaton is organized around several core concepts:

- **Devices** — Represent Zigbee entities (mechanisms, remotes, sensors) or network hosts. Each device subscribes to its MQTT topic and caches state in Redis.
- **Automations** — Rule-based logic that evaluates conditions (time of day, sensor readings, network presence) and triggers device commands on a configurable timer interval.
- **Interactions** — Event-driven responses to Zigbee remote actions (button presses). Defined declaratively in YAML with optional custom JavaScript for complex behavior.
- **AI Assistant** — Optional LLM-powered chat interface (accessible via the terminal UI) that can query device states and control devices using function calling. Tested and proven stable against the **gemma-4-E2B-it** model family — a compact model capable of i18n-aware prompts and reliable tool calling. This model family is recommended as the smallest option that handles both multilingual conversations and structured function calls at the time of writing.
- **TTS Service** — Optional text-to-speech integration that reads AI responses aloud through a configured audio endpoint.
- **Terminal UI** — IRC-inspired multi-window interface with log viewer, device status monitor, and AI chat channel.

## Configuration Overview

Automaton uses a layered configuration approach:

| Layer | File(s) | Purpose |
|-------|---------|---------|
| **Environment** | `.env` | Service connection strings and secrets (MQTT, Redis, AI, TTS endpoints) |
| **Main config** | `etc/automaton.yaml` | Behavior settings, UI layout, logger, AI model params |
| **Devices** | `etc/device/zigbee.yaml`, `etc/device/network.yaml` | Device definitions by type (mechanism, remote, sensor) and network hosts |
| **Automations** | `etc/automation/*.yaml` (+ optional `*.js`) | Rule-based automation definitions |
| **Interactions** | `etc/interaction/interaction.yaml` (+ optional `*.js`) | Zigbee-triggered action mappings |
| **i18n** | `etc/i18n/{locale}/ai.yaml`, `etc/i18n/{locale}/tts.yaml` | Language bundles for AI prompts and TTS voice templates |

> **Note:** Each YAML config has a corresponding `.dist` template with generic device names and documented structure. Custom JavaScript scripts follow the same pattern (`.js.dist`). Copy them to their active names (without `.dist`) and customize for your home. Active configs are gitignored by default so your personal data stays local. See [Configuration Guide](./configuration.md) for a detailed walkthrough of every configuration file and section.

## CLI Usage

```
Usage: node src/main.js [options]

Options:
  -n, --no-ui        Disable the terminal UI
  -h, --help         Show help message
```

The `bin/automaton` script wraps `npm start` and automatically loads variables from `.env`. It supports passing additional arguments:

```bash
sh bin/automaton --no-ui
```

## Terminal UI Command System

The terminal UI supports a pluggable slash-command system that auto-discovers command classes from `src/ui/commands/`. Commands are **only available when running with the terminal UI** — they are entirely disabled when using `--no-ui` (system service mode).

### Dispatch Flow

When a user types `/verb args`, Ui parses the verb and routes it through this priority chain:

```
User input "/clear"
    │
    ▼
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│   Ui        │────▶│ CommandContainer  │────▶│ ClearCmd     │
│ (dispatch)  │     │ (lookup by name)  │     │ .execute()   │
│             │◀────│                   │◀────│              │
└─────────────┘     └──────────────────┘     └──────────────┘
                              ▲
                    ┌─────────┴──────────┐
                    │ Autoloader          │
                    │ scans *.Cmd.js in   │
                    │ src/ui/commands/    │
                    └────────────────────┘
```

1. Built-in window shortcuts (`/1`, `/2`, ...) handled first in switch statement
2. Lifecycle commands (`/quit`, `/exit`, `/q`) handled next
3. Everything else delegated to **CommandContainer.execute(verb, arg)**
4. Container looks up command by its static `name` property → calls `.execute(args)`

### Architecture Pattern

Commands follow the same container + autoloader pattern used throughout Automaton:

| Component | Role | File |
|-----------|------|------|
| `CommandBase` | Abstract base class defining contract | `src/ui/commands/base/commandBase.js` |
| `CommandContainer` | Singleton registry with autodiscovery | `src/ui/commands/container/commandContainer.js` |
| `*.Cmd.js` | Concrete implementations (one per file) | `src/ui/commands/clearCmd.js`, etc. |

Each command is a single ES module that extends `CommandBase`, sets `static name` and `static description`, and implements `async execute(args)`. The container auto-discovers all `.js` files directly under `src/ui/commands/` at startup — no manual registration needed.

See [UI Commands Reference](./ui-commands.md) for full command list and custom command guide.

## Testing

Run the full test suite (syntax checks + instantiation tests):

```bash
npm test
```

---

## Note on Development Process

Many parts of this codebase — particularly boilerplate scaffolding, utility functions, and documentation — were generated with guidance from open-weight coding LLMs. The overall architecture, design decisions, naming conventions, and all critical logic remain under human direction. If something looks unusual or overly verbose, it may be an artifact of this collaborative workflow rather than intentional design.
