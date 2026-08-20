# Architecture

> **In this section:** [AI Conversation Caching](./ai-conversation-caching.md) · [Automation vs Human Differentiation](./automation-human-differentiation.md)

## Project Structure

```
├── bin/                        # Executable scripts
│   ├── automaton               # Main entry script (loads .env, starts app)
│   ├── automaton-test          # Test runner (syntax + instantiation tests)
│   ├── automaton-lint-check    # Lint check bundle (JSDoc coverage, etc.)
│   └── automaton-generate-docs # JSDoc API documentation generator
├── doc/                        # Documentation
│   ├── index.md                # Documentation hub linking every document
│   ├── architecture/           # Architecture deep-dive
│   │   ├── index.md            # This file — project structure and design
│   │   ├── ai-conversation-caching.md  # AI conversation persistence & caching behavior
│   │   └── automation-human-differentiation.md # Automation vs human origin classification
│   ├── installation/           # Setup guides
│   │   ├── index.md            # Requirements, install steps, running modes
│   │   ├── ai-integration.md   # LLM setup (llama.cpp, Ollama, vLLM)
│   │   ├── tts-integration.md  # Text-to-speech backend configuration
│   │   └── stt-integration.md  # Speech-to-text (planned)
│   ├── ui/                     # Terminal UI documentation
│   │   ├── index.md            # Windows, channels, layout, input bar
│   │   └── commands/           # Slash-command reference
│   │       └── index.md        # Quick ref, custom commands, context API
│   ├── configuration.md        # Comprehensive configuration guide
│   ├── examples/               # Included example automations
│   │   ├── index.md            # Overview and navigation
│   │   ├── ambient-lights.md   # Ambient lights automation walkthrough
│   │   └── weatherman.md       # TTS weather announcer walkthrough
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
- **Automations** — Rule-based logic that evaluates conditions (time of day, season, sensor readings, network presence) and triggers device commands on a configurable timer interval. Rules may carry `once:` daily markers so they act at most once per local calendar day, leaving humans free to override afterwards.
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

> **Note:** Each YAML config has a corresponding `.dist` template with generic device names and documented structure. Custom JavaScript scripts follow the same pattern (`.js.dist`). Copy them to their active names (without `.dist`) and customize for your home. Active configs are gitignored by default so your personal data stays local. See [Configuration Guide](../configuration.md) for a detailed walkthrough of every configuration file and section.

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

## Terminal UI Overview

Automaton includes an optional IRC-style terminal UI built on `terminal-kit`. It partitions the screen into three slots — main content area, status bar, and input line — and manages multiple windows routed through configurable channels. The UI is disabled when running as a system service (`--no-ui`).

See [UI Documentation](../ui/index.md) for details on windows, layout, channels, and input modes.  
See [UI Commands Reference](../ui/commands/index.md) for slash-command quick reference and custom command guide.

---

## Testing

Run the full test suite (syntax checks + instantiation tests):

```bash
npm test
```

---

## Note on Development Process

Many parts of this codebase — particularly boilerplate scaffolding, utility functions, and documentation — were generated with guidance from open-weight coding LLMs. The overall architecture, design decisions, naming conventions, and all critical logic remain under human direction. If something looks unusual or overly verbose, it may be an artifact of this collaborative workflow rather than intentional design.
