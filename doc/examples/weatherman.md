# TTS Weather Man

The **ttsWeatherMan** automation is a rule-based weather announcer that builds a speech message from a base sentence template and condition-matched additions, then routes it through the AI → TTS pipeline (or falls back to direct TTS if the AI provider is unavailable). It supports live sensor data interpolation inside i18n strings using `{{ DeviceName.property }}` syntax.

## How It Works

1. On each timer tick, the automation loads its locale-specific i18n bundle (`etc/i18n/{locale}/weatherman.yaml`).
2. An opening time-of-day line (see Time Phrase Rendering below) plus a weather base sentence (e.g., *"The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius..."*) are resolved — placeholders are replaced with real-time sensor values pulled from Zigbee devices via MQTT.
3. Condition rules are evaluated against the current context built dynamically from all sensors defined in `config.sensors`. When multiple rules match simultaneously, only the one with the highest `priority` fires (higher number wins; default is 0).
4. If an AI assistant is available, the built message is framed with day-position markers (see below), prefixed with a creative instruction key (`sentence_ai_prefix`) and sent through `AiAssistant.processMessage()` for natural-language rewriting before being spoken aloud. Otherwise, the raw interpolated text goes straight to TTS -- no markers are added on that path.
5. System-originated messages appear in the UI with a yellow `<system>` prefix and are excluded from conversation caching so they don't extend Redis TTLs indefinitely.

## Daily Cycle Markers

When routing through AI, each announcement is positioned within its **daily session** — the continuous stretch of active ticks between two `silence_between` windows (with `"0230-1030"` one session runs ~10:30 → ~02:30). The position is computed purely from wall clock + config at run time; nothing is stored, so behaviour is deterministic per moment:

| Marker | Condition | Prompt placement |
|--------|-----------|------------------|
| first | Run happened less than one timer interval after the session began | Opening line after `ai_prefix`, before the message |
| last | Session ends less than one timer interval after this run | Same opening-line slot |
| only | Both (session shorter than the timer interval) | Same slot; takes priority over first/last |
| next | Neither first nor last | Closing line *after* the message, containing `{% next_interval %}` |

Because timer ticks are spaced at least one interval apart even across process restarts (`setInterval` re-anchors on boot), a run less than an interval away from a session boundary can never have had a neighbour in that same session -- making first/last detection exact for timer-driven runs. The only residual error is a missed "first" marker when the process was down across the wake-up boundary. Markers require a valid positive timer interval; first/last additionally require a valid `silence_between`. The small model inflects the localized unit words (e.g., Polish *"za godzinę"*) into natural speech as part of its rewrite.

## Time Phrase Rendering

Very small models -- including the recommended gemma-4-E2B-it -- reliably fail at converting clock strings like `9:32 PM` into natural spoken words; that was the source of garbled announcements such as *"godzina sióknasta dziesiąta jedna trzydzieści po wieczór"*. Instead of asking the model to do that conversion, the automation renders an **opening time-of-day line** itself and prepends it to the base sentence on both output paths (AI rewrite *and* direct TTS fallback). The line comes from the bundle's `time_sentence` templates; the global `stupid_ai_engine` switch in the AI section of `etc/automaton.yaml` picks which subtree is used:

| `stupid_ai_engine` | Subtree | Behaviour |
|--------------------|---------|-----------|
| `true` / absent (default) | `explicit` | Clock parts are pre-rendered as plain digits inside a fixed frame (*"Jest 32 minut po godzinie 9 rano"*); the model only inflects unit/ordinal forms during its rewrite. Digits stay unambiguous even when read verbatim by Piper TTS because the "N minutes past H + period word" frame can never be misread as bare H:M. |
| `false` | `smart` | Legacy behaviour: `{% time %}` is left for the model to spell out in words (needs a capable model). |

The switch itself lives in the main config because it describes the *model*, not the automation -- any component that talks to the engine can consult it and simplify what it sends (pre-rendered digits instead of raw times, fixed sentence frames instead of open-ended phrasing). The weatherman time line above is the first consumer; more small-model accommodations are expected to hook into the same flag over time.

Within a style, the clock fraction selects a variant template with fallback to its `default` entry:

| Minutes | Template key tried first | Status |
|---------|--------------------------|--------|
| `00` | `exact_hour` | Shipped ("Jest dokładnie godzina 9 rano") |
| any other | `default` | Shipped ("Jest 32 minut po godzinie 9 rano") |
| `30` / `45` / `15` | `half_past` / `quarter_to` / `quarter_past` | Reserved hooks -- auto-selected if a locale bundle defines them; no translations shipped yet |

The explicit templates use three interpolation tokens pre-resolved from the run's shared clock instant:

| Token | Resolves To | Example (pl, 12h) |
|-------|-------------|--------------------|
| `{% hours %}` | Hour number respecting the configured `time_format` (1–12 or 0–23) | `9` |
| `{% minutes %}` | Minute of the hour as a plain integer | `32` |
| `{% time_of_day %}` | Localized day-period word from `period_words`, keyed by the same five periods used in rule conditions (`morning/noon/afternoon/evening/night`) | `rano` |

Missing period words degrade to the raw English period name. Because the frame always states "minutes past H" plus a period word, midnight and noon stay unambiguous even with bare digits (*"godzina 12 w nocy"* vs *"w południe"*).

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

## Interpolation Syntax

Two placeholder types are supported inside i18n strings:

| Placeholder | Example | Resolves To |
|-------------|---------|-------------|
| `{{ DeviceName.property }}` | `{{ Outdoor Temperature.temperature }}` | Live sensor value from Zigbee2MQTT (locale-formatted numbers) |
| `{% time %}` | `{% time %}` | Current local time using the configured `time_format` |
| `{% hours %}` / `{% minutes %}` / `{% time_of_day %}` | resolved inside `time_sentence` templates | Pre-resolved clock parts for the explicit time line: hour number per `time_format`, minute integer, localized period word from `period_words`; see Time Phrase Rendering |
| `{% next_interval %}` | resolved inside `ai_message_next` | Localized duration phrase until the next non-silent announcement (e.g., "1 godzin"); pre-resolved by the automation, not a user-facing template keyword |

If a device or property isn't found during interpolation, it resolves to `"N/A"`.

## Language Bundles

Weather speech templates live in per-locale files at `etc/i18n/{locale}/weatherman.yaml`:

**English (`en_US/weatherman.yaml`):**
```yaml
# Opening time-of-day line -- rendered BEFORE the base sentence on both output paths.
# Style picked by stupid_ai_engine: explicit = pre-rendered digit frame [default], smart = model spells out the hour.
time_sentence:
  smart:
    default: 'It is currently {% time %}.'
  explicit:
    default: 'It is {% minutes %} minutes past {% hours %} {% time_of_day %}'
    exact_hour: "It is exactly {% hours %} o'clock {% time_of_day %}"

period_words:
  morning: 'in the morning'
  noon: 'at noon'
  afternoon: 'in the afternoon'
  evening: 'in the evening'
  night: 'at night'

base: 'The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius, humidity is at {{ Outdoor Temperature.humidity }} percent, and atmospheric pressure is {{ Kitchen Temperature.pressure }} hectopascals.'
ai_prefix: 'You are a weather announcer. Rewrite the following information creatively and uniquely, spelling out the hour in words. Do not use tools -- base your answer only on the provided information: '
# Day-position markers + unit words for {% next_interval %} (see Daily Cycle Markers)
ai_message_first: 'This is the first update of today.'
ai_message_last: 'This is the last update of tonight.'
ai_message_only: 'This is the only update of today.'
ai_message_next: 'Next update in {% next_interval %}.'
duration_units:
  day: 'days'
  hour: 'hours'
  minute: 'minutes'
  second: 'seconds'
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
# Opening time-of-day line -- rendered BEFORE the base sentence on both output paths.
# Style picked by stupid_ai_engine: explicit = pre-rendered digit frame [default], smart = model spells out the hour.
time_sentence:
  smart:
    default: 'Jest godzina {% time %}.'
  explicit:
    default: 'Jest {% minutes %} minut po godzinie {% hours %} {% time_of_day %}'
    exact_hour: 'Jest dokładnie godzina {% hours %} {% time_of_day %}'

period_words:
  morning: 'rano'
  noon: 'w południe'
  afternoon: 'po południu'
  evening: 'wieczorem'
  night: 'w nocy'

base: 'Temperatura na zewnątrz wynosi {{ Outdoor Temperature.temperature }} stopni Celsjusza, wilgotność to {{ Outdoor Temperature.humidity }} procent, a ciśnienie atmosferyczne to {{ Kitchen Temperature.pressure }} hektopaskali.'
ai_prefix: 'Jesteś prezenterem pogody. Przepisz poniższe informacje w kreatywny i unikalny sposób, a godzinę napisz słownie. Nie używaj narzędzi -- opieraj się tylko na podanych informacjach: '
# Markery pozycji w dobie + słowa jednostek dla {% next_interval %} (patrz Daily Cycle Markers)
ai_message_first: 'To jest pierwsza wiadomość dzisiejszego dnia.'
ai_message_last: 'To jest ostatnia wiadomość dzisiejszej nocy.'
ai_message_only: 'To jest jedyna wiadomość tej doby.'
ai_message_next: 'Następna wiadomość za {% next_interval %}.'
duration_units:
  day: 'dni'
  hour: 'godzin'
  minute: 'minut'
  second: 'sekund'
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

## File Map

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/ttsWeatherManAutomation.js` |
| Configuration template | `etc/automation/tts-weatherman.yaml.dist` |
| English i18n bundle | `etc/i18n/en_US/weatherman.yaml` |
| Polish i18n bundle | `etc/i18n/pl_PL/weatherman.yaml` |
