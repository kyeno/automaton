# TTS Weather Man

The **ttsWeatherMan** automation is a rule-based weather announcer that builds a speech message from a base sentence template and condition-matched additions, then routes it through the AI → TTS pipeline (or falls back to direct TTS if the AI provider is unavailable). It supports live sensor data interpolation inside i18n strings using `{{ DeviceName.property }}` syntax.

## How It Works

1. On each timer tick, the automation loads its locale-specific i18n bundle (`etc/i18n/{locale}/weatherman.yaml`).
2. An opening time-of-day line plus a weather base sentence (e.g., *"The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius..."*) are resolved — placeholders are replaced with real-time sensor values pulled from Zigbee devices via MQTT.
3. Condition rules are evaluated against the current context built dynamically from all sensors defined in `config.sensors`. When multiple rules match simultaneously, only the one with the highest `priority` fires (higher number wins; default is 0).
4. If an AI assistant is available, the built message is prefixed with a creative instruction key (`sentence_ai_prefix`) and sent through `AiAssistant.processMessage()` for natural-language rewriting before being spoken aloud. Otherwise the raw interpolated text goes straight to TTS. A runtime AI failure degrades the same way — the announcement never silently vanishes.

If **neither** the AI pipeline nor the TTS server is available, the run is skipped entirely before any context build or device reads. A run with exactly one of the two available still proceeds.

The clock-phrase pre-rendering, day-position markers (first/last/only/next), and calendar-date fusion are rendering mechanics — see [Weatherman Speech Rendering](../architecture/weatherman-speech-rendering.md).

## Dynamic Sensor System

The base class reads every entry under `config.sensors` at runtime. Each entry maps a logical name → Zigbee device name, where the logical name also serves as both:
- The property key extracted from the device's state object (e.g., `{ humidity: 'Outdoor Temperature' }` reads `state.humidity`)
- The condition key used in rule evaluation (e.g., `humidity: { gte: 50 }`)

Adding new sensor types requires **zero code changes** — just add them to the YAML config. Supported numeric operators: `lt`, `lte`, `gt`, `gte`.

## Configuration File

Located at `etc/automation/tts-weatherman.yaml`:

```yaml
timer_interval: "1h"            # Human-readable interval ("90s", "3m 45s", "1h"); omit to go event-driven
silence_between: "0230-1030"    # Suppress execution during this time window

sentence_base: 'weatherman.base'           # Always-played opening i18n key
sentence_ai_prefix: 'weatherman.ai_prefix' # Prepend when routing through AI

# All sensors are read dynamically — any key here becomes available for conditions
sensors:
  illuminance: 'Outdoor Luminance'
  temperature: 'Outdoor Temperature'
  humidity: 'Outdoor Temperature'         # Same combined sensor as temp
  pressure: 'Kitchen Temperature'         # Separate barometer device

# OPTIONAL -- Extra parameters forwarded verbatim into the TTS server request for every
# utterance produced by this automation (radio-style jingle framing). Each entry applies
# only when set; leave empty to keep the plain { model, text, output_endpoint } shape.
tts_options:
  intro:          # Wave filename played before the synthesized speech
  outro:          # Wave filename played after the synthesized speech
  intro_spacing:  # Seconds between intro end and speech start; negative = overlap (e.g., -2.5)

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
      temperature: { gt: 18 }
    sentence: 'weatherman.soothing_warm_night'
```

### Time-of-Day Periods

The `time-of-day` condition matches against five periods derived from average sunrise/sunset for Central Europe (`SUN_TIMES` in `src/lib/date.js`): daylight is split into four equal quarters (morning, noon, afternoon), evening extends two hours past sunset to cover twilight, and night spans the rest. Matching is hour-granular — every hour maps to exactly one period. Because boundaries track daylight length, they shift seasonally:

- In **August** (sunrise ~5:00, sunset ~20:00) *afternoon* ends at **16:00** and *evening* starts at **17:00** — so a `[morning, noon, afternoon]` rule stops matching well before most people stop thinking of it as "day".
- In **January/December** (8:00–16:00) *evening* begins as early as **15:00**.

Full month-by-month ranges (whole-hour buckets):

| Month | Morning | Noon | Afternoon | Evening | Night |
|-------|---------|------|-----------|---------|-------|
| January   | 08–10 | 11–12 | 13–14 | 15–17 | 18–07 |
| February  | 07–10 | 11–12 | 13–15 | 16–18 | 19–06 |
| March     | 06–09 | 10–12 | 13–15 | 16–19 | 20–05 |
| April     | 06–09 | 10–13 | 14–16 | 17–20 | 21–05 |
| May       | 05–09 | 10–13 | 14–17 | 18–22 | 23–04 |
| June      | 05–09 | 10–13 | 14–17 | 18–22 | 23–04 |
| July      | 05–09 | 10–13 | 14–17 | 18–22 | 23–04 |
| August    | 05–09 | 10–13 | 14–16 | 17–21 | 22–04 |
| September | 06–09 | 10–13 | 14–16 | 17–20 | 21–05 |
| October   | 07–10 | 11–12 | 13–15 | 16–18 | 19–06 |
| November  | 07–09 | 10–12 | 13–14 | 15–17 | 18–06 |
| December  | 08–10 | 11–12 | 13–14 | 15–17 | 18–07 |

These are long-term averages for ~52°N; real sunrise/sunset varies around them, but whole-hour buckets mean small shifts rarely change the classification except right on a boundary. When designing rules, check this table first — "Warm day" above is a classic example of a rule that silently stops matching once evening begins.

## TTS Server Passthrough Options

The optional `tts_options` block forwards extra parameters **verbatim** into the JSON body of every TTS server request that this automation produces -- a per-automation way to shape how its own voice sounds without touching the global locale template (`etc/i18n/{locale}/tts.yaml`). It exists primarily for radio-style jingle framing:

| Key | Type | Meaning |
|-----|------|---------|
| `intro` | string | Wave filename (on the TTS server side) played before the synthesized speech |
| `outro` | string | Wave filename (on the TTS server side) played after the synthesized speech |
| `intro_spacing` | number | Seconds between intro end and speech start; negative values overlap them (e.g., `-2.5`) |

Behaviour details:

- **Optional everywhere.** Absent or empty entries are simply not sent; when nothing is configured the request keeps the plain `{ model, text, output_endpoint }` shape. Malformed entries (wrong type, empty filename) are dropped with a warning instead of failing the run.
- **Both output paths covered.** The options travel through the EventBus `tts:speak` payload: on the AI path they are threaded via `AiAssistant.processMessage(..., { tts })` so the rewritten reply carries them too, and on direct TTS / AI-failure fallback they are spread straight into the emission.
- **Merge precedence** in the TTS service is runtime event params > locale `tts.yaml` defaults -- though these keys are intentionally *not* shipped in any locale template, since jingle framing is an automation-level presentation choice rather than a voice-model setting.
- Wave files must exist on the machine running tts-server; only their filenames cross the wire.

## Interpolation Syntax

Two placeholder types are supported inside i18n strings:

| Placeholder | Example | Resolves To |
|-------------|---------|-------------|
| `{{ DeviceName.property }}` | `{{ Outdoor Temperature.temperature }}` | Live sensor value from Zigbee2MQTT (locale-formatted numbers) |
| `{% time %}` | `{% time %}` | Current local time using the configured `time_format` |

If a device or property isn't found during interpolation, it resolves to `"N/A"`. The clock-part tokens (`{% hours %}`, `{% minutes %}`, `{% time_of_day %}`, `{% date %}`, `{% next_interval %}`) are pre-resolved internally by the automation — see [Weatherman Speech Rendering](../architecture/weatherman-speech-rendering.md).

## Language Bundles

Each locale ships a `weatherman.yaml` bundle with the sentence templates. English (`en_US/weatherman.yaml`):

```yaml
base: 'The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius, humidity is at {{ Outdoor Temperature.humidity }} percent, and atmospheric pressure is {{ Kitchen Temperature.pressure }} hectopascals.'
ai_prefix: 'You are a weather announcer. Rewrite the following information creatively and uniquely, spelling out the hour in words. Do not use tools -- base your answer only on the provided information: '
# Day-position markers (see Weatherman Speech Rendering)
ai_message_first: 'This is the first update of today.'
ai_message_last: 'This is the last update of tonight.'
ai_message_only: 'This is the only update of today.'
ai_message_next: 'Next update in {% next_interval %}.'
warning_hot_day: 'WARNING: It is hot outside. Avoid prolonged exposure.'
# ... further warning_* / soothing_* sentence keys
```

A Polish bundle (`pl_PL/weatherman.yaml`) ships with the same keys, including `time_sentence` templates whose clock parts are pre-rendered as plain digits so tiny models never convert a clock string into words. To add support for another language, create a new `weatherman.yaml` in your locale directory with translated keys matching those used in the automation's YAML config.

## File Map

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/ttsWeatherManAutomation.js` |
| Configuration template | `etc/automation/tts-weatherman.yaml.dist` |
| English i18n bundle | `etc/i18n/en_US/weatherman.yaml` |
| Polish i18n bundle | `etc/i18n/pl_PL/weatherman.yaml` |
| English date bundle (day/month names, period words, duration units) | `etc/i18n/en_US/date.yaml` |
| Polish date bundle | `etc/i18n/pl_PL/date.yaml` |
| Date helper (owns the date bundles) | `src/lib/date.js` |

---

→ Back to [Automations](./index.md) · Sibling example: [Ambient Lights](./ambient-lights.md)
