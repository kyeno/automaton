# Automations

Automations evaluate YAML conditions on sensor, presence, player, and timer events.
Adapt the shipped `.dist` templates to your device and host names.
See [Configuration](../configuration.md#4-automation-rules-etcautomationyaml) for rule syntax.

| Automation | Behavior |
|------------|----------|
| [Ambient Lights](./ambient-lights.md) | Morning cleanup, lamps from sunset minus 30 minutes, forced pre-dawn restore |
| [TTS Weather Man](./weatherman.md) | Sensor-based weather reports with optional AI rewriting |
| [TTS Greeter](./greeter.md) | Host-return greetings selected by absence duration |
| [TTS Gardener](./gardener.md) | Soil-moisture reports, worsening alerts, and stuck-probe warnings |
| [TTS Twilight](./twilight.md) | Civil-dawn and sunset announcements |
| [Home Office Rollers](./home-office-rollers.md) | Light, temperature, and presence rules; most-closed position wins |
| [Bedroom Rollers](./bedroom-rollers.md) | Night closing and a remote-controlled shutter/outlet interaction |
| [Home Theater Mode](./home-theater-mode.md) | Close rollers while a player is reachable; control lights during playback |

To add an automation, see [Contributing](../../CONTRIBUTING.md).
