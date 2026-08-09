# Example Automations

This document describes the example automations shipped with Automaton. Each one demonstrates a different pattern you can adapt for your own home setup. More examples will be added over time.

---

## ttsWeatherMan

The **ttsWeatherMan** automation is a rule-based weather announcer that builds a speech message from a base sentence template and condition-matched additions, then routes it through the AI → TTS pipeline (or falls back to direct TTS if the AI provider is unavailable). It supports live sensor data interpolation inside i18n strings using `{{ DeviceName.property }}` syntax.

### How It Works

1. On each timer tick, the automation loads its locale-specific i18n bundle (`etc/i18n/{locale}/weatherman.yaml`).
2. A base sentence (e.g., *"It is currently {% time %}. The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius..."*) is resolved — placeholders are replaced with real-time sensor values pulled from Zigbee devices via MQTT.
3. Condition rules are evaluated against the current context (time of day, temperature thresholds, illuminance levels, etc.). Matching rules append additional sentences (e.g., *"Warning, it is very hot today!"* when outdoor temp ≥ 30 °C during daytime hours).
4. If an AI assistant is available, the built message is prefixed with a creative instruction key (`sentence_ai_prefix`) and sent through `AiAssistant.processMessage()` for natural-language rewriting before being spoken aloud. Otherwise, the raw interpolated text goes straight to TTS.
5. System-originated messages appear in the UI with a yellow `<system>` prefix and are excluded from conversation caching so they don't extend Redis TTLs indefinitely.

### Configuration File

Located at `etc/automation/tts-weatherman.yaml`:

```yaml
timer_interval_ms: 900000   # Milliseconds between runs (set to 0 to disable)

sentence_base: 'weatherman.base'           # Always-played opening i18n key
sentence_ai_prefix: 'weatherman.ai_prefix' # Prepend when routing through AI

# Sensor mappings used for condition evaluation
sensors:
  illuminance: 'Balkon Swiatlo'
  temperature: 'Balkon Temperatura'
  humidity: 'Balkon Temperatura'
  pressure: 'Kuchnia Temperatura'

# Condition rules — matched sentences are appended to the base sentence
rules:
  - name: 'Hot weather warning'
    conditions:
      time-of-day: [morning, noon, afternoon]
      temperature: { gte: 30 }
    sentence: 'weatherman.hot_warning'

  - name: 'Night closing'
    conditions:
      time-of-day: [evening, night]
      illuminance: { lte: 15 }
    sentence: 'weatherman.night_message'
```

### Interpolation Syntax

Two placeholder types are supported inside i18n strings:

| Placeholder | Example | Resolves To |
|-------------|---------|-------------|
| `{{ DeviceName.property }}` | `{{ Outdoor Temperature.temperature }}` | Live sensor value from Zigbee2MQTT (locale-formatted numbers) |
| `{% keyword %}` | `{% time %}` | Special function output (currently only `time` is supported; uses the configured `time_format`) |

If a device or property isn't found during interpolation, it resolves to `"N/A"`.

### Language Bundles

Weather speech templates live in per-locale files at `etc/i18n/{locale}/weatherman.yaml`:

**English (`en_US/weatherman.yaml`):**
```yaml
base: 'It is currently {% time %}. The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius...'
ai_prefix: 'You are a weather announcer. Rewrite the following information creatively and uniquely: '
hot_warning: 'Warning, it is very hot today!'
night_message: 'It is cold and dark outside, time to rest.'
```

**Polish (`pl_PL/weatherman.yaml`):**
```yaml
base: 'Jest godzina {% time %}. Temperatura na zewnątrz wynosi {{ Balkon Temperatura.temperature }} stopni Celsjusza...'
ai_prefix: 'Jesteś prezenterem pogody. Przepisz poniższe informacje w kreatywny i unikalny sposób: '
hot_warning: 'Uwaga, dziś jest bardzo gorąco!'
night_message: 'Zima i ciemno za oknem, czas na odpoczynek.'
```

To add support for another language, create a new `weatherman.yaml` in your locale directory with translated keys matching those used in the automation's YAML config.

### File Map

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/ttsWeatherManAutomation.js` |
| Configuration template | `etc/automation/tts-weatherman.yaml.dist` |
| English i18n bundle | `etc/i18n/en_US/weatherman.yaml` |
| Polish i18n bundle | `etc/i18n/pl_PL/weatherman.yaml` |

---

## More Examples Coming Soon

Additional example automations will be added here as they become available. If you'd like to contribute an example, see [CONTRIBUTING.md](../CONTRIBUTING.md).
