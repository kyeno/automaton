# Architecture

Automaton connects Zigbee2MQTT devices, YAML rules, remote interactions, and optional AI,
speech, and email services through an internal EventBus.

## Project Structure

| Path | Contents |
|------|----------|
| `bin/` | Startup, test, lint, and API documentation commands |
| `src/ai/` | AI assistant, providers, and device tools |
| `src/automation/` | Rule evaluation and command dispatch |
| `src/device/` | Device types, registry, and command tracking |
| `src/interaction/` | Remote-button action handling |
| `src/sequence/` | Ordered device commands and loops |
| `src/monitor/` | Network presence, video players, and offline alerts |
| `src/service/` | MQTT, Redis, SQLite, configuration, logging, TTS, and email |
| `src/ui/` | Terminal windows, widgets, and slash commands |
| `etc/` | Configuration, scripts, and language bundles |
| `tests/` | Behavioral tests, fixtures, and optional hardware checks |
| `var/` | Runtime logs and database |

Copy `.dist` templates to their active names and customize them. See the
[Configuration Guide](../configuration.md) for keys and examples.

## Architecture at a Glance

- **Devices** receive MQTT reports, cache state, and publish commands.
- **Automations** evaluate conditions on timer ticks or events and dispatch matching actions.
- **Interactions** map remote-button events to device commands or JavaScript handlers.
- **Sequences** send ordered commands, optionally in a loop.
- **AI** reads and controls devices through tools; **TTS** speaks responses and announcements.
- **Email** sends notifications independently of speech.
- **Terminal UI** displays logs, devices, rules, chat, and speech output.

## CLI Usage

```bash
sh bin/automaton --no-ui
sh bin/automaton -c "locale.language: en_US" -c "ai.temperature: 0.7"
```

| Option | Effect |
|--------|--------|
| `-n`, `--no-ui` | Run without the terminal UI |
| `--no-trace` | Disable TRACE file logging |
| `--no-ai`, `--no-tts`, `--no-email` | Disable the named service for this run |
| `-c`, `--config-override "key.path: value"` | Override a main-config value; repeatable and schema-validated |
| `-h`, `--help` | Show help |

The wrapper loads `.env`. See [Terminal UI](../ui/index.md) and
[Commands Reference](../ui/commands/index.md) for interactive use.

## Testing

`npm test` runs syntax and behavioral checks in an isolated template checkout.
See [Contributing](../../CONTRIBUTING.md#testing) for fixtures, selected tests, and hardware checks.

## Internal References

- [AI Conversation Caching](./ai-conversation-caching.md)
- [Automation vs Human Differentiation](./automation-human-differentiation.md)
- [Rule Engine Restore & Ownership](./rule-engine-restore-semantics.md)
- [Sequence Entity](./sequence-entity.md)
- [Time-of-Day Periods](./time-of-day-periods.md)
- [Weatherman Speech Rendering](./weatherman-speech-rendering.md)
