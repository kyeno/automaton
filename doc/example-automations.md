# Example Automations

This document describes the example automations shipped with Automaton. Each one demonstrates a different pattern you can adapt for your own home setup. More examples will be added over time.

---

## ttsWeatherMan

The **ttsWeatherMan** automation is a rule-based weather announcer that builds a speech message from a base sentence template and condition-matched additions, then routes it through the AI → TTS pipeline (or falls back to direct TTS if the AI provider is unavailable). It supports live sensor data interpolation inside i18n strings using `{{ DeviceName.property }}` syntax.

### How It Works

1. On each timer tick, the automation loads its locale-specific i18n bundle (`etc/i18n/{locale}/weatherman.yaml`).
2. A base sentence (e.g., *"It is currently {% time %}. The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius..."*) is resolved — placeholders are replaced with real-time sensor values pulled from Zigbee devices via MQTT.
3. Condition rules are evaluated against the current context built dynamically from all sensors defined in `config.sensors`. When multiple rules match simultaneously, only the one with the highest `priority` fires (higher number wins; default is 0).
4. If an AI assistant is available, the built message is prefixed with a creative instruction key (`sentence_ai_prefix`) and sent through `AiAssistant.processMessage()` for natural-language rewriting before being spoken aloud. Otherwise, the raw interpolated text goes straight to TTS.
5. System-originated messages appear in the UI with a yellow `<system>` prefix and are excluded from conversation caching so they don't extend Redis TTLs indefinitely.

### Dynamic Sensor System

The base class reads every entry under `config.sensors` at runtime. Each entry maps a logical name → Zigbee device name, where the logical name also serves as both:
- The property key extracted from the device's state object (e.g., `{ humidity: 'Outdoor Temperature' }` reads `state.humidity`)
- The condition key used in rule evaluation (e.g., `humidity: { gte: 50 }`)

Adding new sensor types requires **zero code changes** — just add them to the YAML config. Supported numeric operators: `lt`, `lte`, `gt`, `gte`.

### Configuration File

Located at `etc/automation/tts-weatherman.yaml`:

```yaml
timer_interval_ms: 3600000   # Milliseconds between runs (set to 0 to disable)
silence_between: "0230-1030" # Suppress execution during this time window

sentence_base: 'weatherman.base'           # Always-played opening i18n key
sentence_ai_prefix: 'weatherman.ai_prefix' # Prepend when routing through AI

# All sensors are read dynamically — any key here becomes available for conditions
sensors:
  illuminance: 'Outdoor Luminance'
  temperature: 'Outdoor Temperature'
  humidity: 'Outdoor Temperature'         # Same combined sensor as temp
  pressure: 'Kitchen Temperature'         # Separate barometer device

rules:
  - name: 'Warm day'
    priority: 1                           # Low — comfort advice only
    conditions:
      time-of-day: [morning, noon, afternoon]
      temperature: { lte: 25, gte: 18 }
      humidity: { lte: 55 }
    sentence: 'weatherman.soothing_warm_day'

  - name: 'Hot day'
    priority: 2                           # Medium — generic heat warning
    conditions:
      time-of-day: [morning, noon, afternoon]
      temperature: { gt: 25 }
    sentence: 'weatherman.warning_hot_day'

  - name: 'Hot and humid day'
    priority: 3                           # High -- oppressive heat plus high humidity
    conditions:
      temperature: { gte: 26 }
      humidity: { gte: 50 }
    sentence: 'weatherman.warning_humid_stay_at_home'

  - name: 'Too hot day'
    priority: 4                           # Higher -- extreme heat regardless of humidity
    conditions:
      temperature: { gte: 29 }
    sentence: 'weatherman.warning_hot_stay_at_home'

  - name: 'Apocalypse'
    priority: 5                           # Highest -- overrides everything
    conditions:
      temperature: { gte: 30 }
      humidity: { gte: 55 }
    sentence: 'weatherman.warning_apocalypse'

  - name: 'Chill evening'
    priority: 1
    conditions:
      time-of-day: [evening, night]
      temperature: { lte: 18 }
    sentence: 'weatherman.warning_chill_night'

  - name: 'Warm evening'
    priority: 1
    conditions:
      time-of-day: [evening, night]
      temperature: { gt: 18, lte: 20 }
    sentence: 'weatherman.soothing_warm_night'
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
base: 'It is currently {% time %}. The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius, humidity is at {{ Outdoor Temperature.humidity }} percent, and atmospheric pressure is {{ Kitchen Temperature.pressure }} hectopascals.'
ai_prefix: 'You are a weather announcer. Rewrite the following information creatively and uniquely, spelling out the hour in words: '
warning_hot_day: 'WARNING: It is hot outside. Avoid prolonged exposure.'
warning_humid_stay_at_home: 'WARNING: The air is so thick you can barely breathe! Stay indoors!'
warning_hot_stay_at_home: 'WARNING: It is so hot that breathing is difficult! Make sure to stay indoors!'
warning_apocalypse: 'WARNING: Thermal apocalypse outside! Close blinds, seal windows, crank up the AC, and do not leave the house under any circumstances!'
warning_humid_night: 'WARNING: Humidity levels are too high for comfortable breathing outdoors.'
warning_chill_night: 'Grab a sweater or light jacket before heading out.'
soothing_warm_day: 'The weather is perfect! Ideal for a walk or working outside!'
soothing_warm_night: 'Beautiful night out there. You could step outside in shorts and a t-shirt to enjoy the stars.'
```

**Polish (`pl_PL/weatherman.yaml`):**
```yaml
base: 'Jest godzina {% time %}. Temperatura na zewnątrz wynosi {{ Outdoor Temperature.temperature }} stopni Celsjusza, wilgotność to {{ Outdoor Temperature.humidity }} procent, a ciśnienie atmosferyczne to {{ Kitchen Temperature.pressure }} hektopaskali.'
ai_prefix: 'Jesteś prezenterem pogody. Przepisz poniższe informacje w kreatywny i unikalny sposób, a godzinę napisz słownie: '
warning_hot_day: 'UWAGA: Jest gorąco. Nie przebywaj zbyt długo na zewnątrz.'
warning_humid_stay_at_home: 'UWAGA: Powietrze jest tak gęste, że nie da się nim oddychać! Pozostań w domu!'
warning_hot_stay_at_home: 'UWAGA: Jest tak gorąco, że ciężko się oddycha! Koniecznie pozostań w domu!'
warning_apocalypse: 'UWAGA: Na zewnątrz panuje termiczna apokalipsa! Zasłoń rolety, zamknij okna, ustaw mocną klimatyzację i absolutnie nie wychodź z domu!'
warning_humid_night: 'UWAGA: Wilgotność na zewnątrz jest zbyt duża, by swobodnie oddychać.'
warning_chill_night: 'Wychodząc na spacer załóż bluzę lub lekką kurtkę.'
soothing_warm_day: 'Pogoda jest doskonała! Idealna na spacer, lub pracę na zewnątrz!'
soothing_warm_night: 'Jest przepiękna noc. Można wyjść w krótkich spodenkach i koszulce by podziwiać gwiazdy.'
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
