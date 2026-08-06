# Installation & Requirements

## Requirements

### Runtime

- **Node.js** >= 20
- **Redis** server (for device state caching)
- **MQTT** broker (e.g., Mosquitto)
- **Zigbee2MQTT** running and accessible

### System Packages

| Package | Purpose | Debian/Ubuntu | Arch Linux |
|---------|---------|---------------|------------|
| `arping` | Network presence detection | `sudo apt install iputils-arping` | `sudo pacman -S iputils` |
| `beep` | Audible alerts via PC speaker | `sudo apt install beep` | Already included in `util-linux` |

### Permissions

#### arping

The `arping` command requires raw socket access. Grant the capability without requiring full root:

```bash
sudo setcap cap_net_raw+ep $(which arping)
```

## Installation

```bash
git clone <repository-url>
cd automaton
npm install
```

Or install globally for system-wide access:

```bash
npm install -g
```

This makes the `automaton` command available globally, which loads `.env` and starts the application.

## First-Time Setup

Automaton ships with `.dist` template configuration files that serve as working examples and automatic fallbacks. On first run, if an active config is missing, the system loads its corresponding `.dist` template automatically.

### 1. Environment variables

Copy the template and fill in your service endpoints:

```bash
cp .env.example .env
# Edit .env with your MQTT, Redis, AI, and TTS endpoints
```

### 2. Configuration files

The `etc/` directory contains `.yaml.dist` and `.js.dist` templates. You can either:

- **Use defaults:** Just start Automaton — it falls back to `.dist` templates automatically when active configs are missing.
- **Customize (recommended):** Copy each `.dist` file to its active name and edit for your setup:

  ```bash
  # Main config
  cp etc/automaton.yaml.dist etc/automaton.yaml

  # Device definitions
  cp etc/device/zigbee.yaml.dist etc/device/zigbee.yaml
  cp etc/device/network.yaml.dist etc/device/network.yaml

  # Interactions
  cp etc/interaction/interaction.yaml.dist etc/interaction/interaction.yaml

  # i18n bundles
  cp etc/i18n/en_US/*.dist etc/i18n/en_US/
  # or for Polish:
  cp etc/i18n/pl_PL/*.dist etc/i18n/pl_PL/
  ```

### 3. Custom scripts

JavaScript files in `etc/automation/` and `etc/interaction/` are loaded automatically by the autoloader (only files ending in `.js`). Rename a `.js.dist` example to `.js` to activate it, then customize device names and logic:

```bash
cp etc/interaction/balkonWlacznikInteraction.js.dist \
   etc/interaction/my-custom-interaction.js
```

### 4. Start the application

```bash
# Via the bin script (loads .env automatically):
sh bin/automaton

# Or via npm:
npm start

# Without the terminal UI:
npm start -- --no-ui
```

> **Tip:** All active config files (`*.yaml`, `*.js`) in `etc/` are gitignored. Your personal setup will never accidentally be committed — only the clean `.dist` templates are tracked. See [Configuration Guide](./configuration.md) for details on every file.

## Optional Services

Automaton optionally integrates with external services for AI chat and text-to-speech. These are not bundled — you must run them separately or point to existing instances:

| Service | Purpose | Repository |
|---------|---------|------------|
| **tts-server** | Text-to-speech backend (reads AI responses aloud via TCP audio endpoint) | [kyeno/tts-server](https://github.com/kyeno/tts-server) |
| **LLM Inference Server** | AI chat assistant (OpenAI-compatible API for model inference) | e.g., [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp), Ollama, vLLM, etc. |

Configure their endpoints in `.env` (`TTS_API_URL`, `AI_API_URL`). If URLs are not set, those features are disabled at startup with a warning.

## ⚠️ Important

Automaton assumes that you have **every connected Zigbee device uniquely named** in Zigbee2MQTT. Those names are referenced throughout your automations, interactions, and device definitions.