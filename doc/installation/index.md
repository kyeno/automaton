# Installation & Requirements

> **In this section:** [AI Integration](./ai-integration.md) · [TTS Integration](./tts-integration.md) · [STT Integration](./stt-integration.md) *(planned)*

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
git clone https://github.com/kyeno/automaton.git
cd automaton
npm install
```

> **⚠ Experimental / Untested** — Global installation is not actively maintained or tested. The local `bin/automaton` script is the recommended and supported method. Use global install at your own risk.

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

JavaScript files in `etc/automation/` and `etc/interaction/` are loaded automatically by the autoloader (only files ending in `.js`). Rename a `.js.dist` example to `.js` to activate it, then customize device names and logic. Generic starting points ship alongside each config template — e.g. `etc/automation/exampleAutomation.js.dist`, or the concrete `bedroomRollersInteraction.js.dist` pilot-remote handler paired with the `bedroom_pilot_remote` entry in `interaction.yaml.dist`:

```bash
# A blank-slate custom interaction:
cp etc/interaction/exampleInteraction.js.dist \
   etc/interaction/my-custom-interaction.js

# Or start from the shipped pilot-remote outlet handler:
cp etc/interaction/bedroomRollersInteraction.js.dist \
   etc/interaction/bedroomRollersInteraction.js
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

> **Tip:** All active config files (`*.yaml`, `*.js`) in `etc/` are gitignored. Your personal setup will never accidentally be committed — only the clean `.dist` templates are tracked. See [Configuration Guide](../configuration.md) for details on every file.

## Running

Automaton offers two operating modes — headless system service or interactive terminal UI. Choose whichever matches your workflow.

### Running as System Service

For unattended operation, start Automaton without the terminal UI:

```bash
sh bin/automaton --no-ui
```

If AI or TTS are not needed in this deployment, combine flags on the same command line (`sh bin/automaton --no-ui --no-ai --no-tts`) -- they behave exactly as if the corresponding environment variables were unset.

This is recommended for production use where you want Automaton running persistently in the background. You can keep it alive via any init system or terminal multiplexer:

**systemd user service:**

Create `~/.config/systemd/user/automaton.service`:

```ini
[Unit]
Description=Automaton Home Automation Daemon
After=network.target

[Service]
Type=simple
EnvironmentFile=%h/.env
ExecStart=/usr/bin/node %home%/automaton/src/main.js --no-ui
Restart=on-failure
WorkingDirectory=%home%/automaton

[Install]
WantedBy=default.target
```

Enable with `systemctl --user enable --now automaton.service`.

**OpenRC (Gentoo):**

Create `/etc/init.d/automaton` using the standard OpenRC template pointing to `bin/automaton --no-ui`, then run `rc-update add automaton default`.

**screen session (manual):**

```bash
screen -dmS automaton sh bin/automaton --no-ui
```

Reattach later with `screen -r automaton`. This works on any distro without requiring init-system configuration.

### Running with Terminal UI

For interactive monitoring and granular control, start Automaton normally (without `--no-ui`). The IRC-style interface gives you live log streaming, device status, AI chat, and slash commands — all in one terminal window.

We recommend running it inside **screen** so it survives SSH disconnects:

```bash
screen -S automaton-ui sh bin/automaton
```

Detach with `Ctrl+A D`; reattach with `screen -r automaton-ui`.

#### Recommended screen Configuration

If you use screen regularly, create or append to `~/.screenrc` for a better experience. Start with these global settings:

```screen
# UTF-8 support
defutf8 on
utf8 on on

# Proper termcap driving for PgUp/PgDown
termcapinfo xterm* ti@:te@
termcapinfo xterm* kP=\E[5~:kN=\E[6~
termcapinfo rxvt* kP=\E[5~:kN=\E[6~

# Optional: 256-color support
term screen-256color
```

Then add mode-specific bindings depending on how you run Automaton.

**For UI mode** — pass PgUp/PgDown through to the application (for scrolling window history):

```screen
bindkey "^[[5~" stuff "\033[5~"
bindkey "^[[6~" stuff "\033[6~"
```

**For non-UI mode** — map PgUp/PgDown to screen's built-in page navigation and enable scrollback:

```screen
bindkey "^[[5~" eval "copy" "stuff ^b"
bindkey -m "^[[5~" stuff ^b
bindkey -m "^[[6~" stuff ^f
defscrollback 10000
```

> **Tip:** You can keep both sets of bindings in one `~/.screenrc` if you use different screen sessions for each mode. The key difference is that UI mode needs raw escape sequences forwarded, while non-UI mode benefits from screen's native paging.

## Optional Services

Automaton can integrate with several optional external services. Each has its own setup guide:

- **[AI Integration](./ai-integration.md)** — LLM-powered chat assistant that queries device states and controls devices using function calling.
- **[TTS Integration](./tts-integration.md)** — Text-to-speech backend that reads AI responses aloud through a configured audio endpoint.
- **[STT Integration](./stt-integration.md)** — Speech-to-text input (currently on TODO list).

## ⚠️ Important

Automaton assumes that you have **every connected Zigbee device uniquely named** in Zigbee2MQTT. Those names are referenced throughout your automations, interactions, and device definitions.