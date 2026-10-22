# TTS Weather Man

TTS Weather Man combines live sensor values with locale templates and the highest-priority matching rule. It speaks directly or uses AI rewriting with TTS fallback.

When AI is enabled and available, a shared processing guard skips overlapping runs of this automation until the current run finishes, including queue wait, TTS fallback and completion bookkeeping. Plain TTS bypasses this guard.

## How It Works

1. On each timer tick, the automation loads its locale-specific i18n bundle (`etc/i18n/{locale}/weatherman.yaml`).
2. An opening time-of-day line plus a weather base sentence (e.g., *"The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius..."*) are resolved — placeholders are replaced with real-time sensor values pulled from Zigbee devices via MQTT.
3. Condition rules are evaluated against the current context built dynamically from all sensors defined in `config.sensors`. When multiple rules match simultaneously, only the one with the highest `priority` fires (higher number wins; default is 0).
4. If an AI assistant is available, the built message is prefixed with a creative instruction key (`sentence_ai_prefix`) and sent through `AiAssistant.processMessage()` for natural-language rewriting before being spoken aloud. Otherwise the raw interpolated text goes straight to TTS. A runtime AI failure degrades the same way — the announcement never silently vanishes.

If **neither** the AI pipeline nor the TTS server is available, the run is skipped entirely before any context build or device reads. A run with exactly one of the two available still proceeds.

The clock-phrase pre-rendering, day-position markers (first/last/only/next), calendar-date fusion, and the proverb segment are rendering mechanics — see [Weatherman Speech Rendering](../architecture/weatherman-speech-rendering.md).

Local illuminance and human sky labels can be archived independently using
`/weather sunny`, `/weather cloudy` and `/weather overcast`. See
[Local daylight learning](../services/daylight.md) for the recording flag,
undo/export workflow and proposed classifier. Collection currently adds no sky
classification to Weatherman speech.

### Segment order

The announcement is assembled as an ordered list, structurally identical on both output paths:

```
ai_prefix (AI path only) -> [opener] -> core message -> [proverb] -> [next-update closer]
```

`ai_prefix` is the only AI-exclusive part — it is an instruction to the model and is never read aloud. Everything after it is plain text meant to be spoken.

With `add_proverb: true`, the proverb follows the body and precedes the next-update closer. The closer is omitted on the last run of a session.

## Dynamic Sensor System

The base class reads every entry under `config.sensors` at runtime. Each entry maps a logical name → Zigbee device name, where the logical name also serves as both:
- The property key extracted from the device's state object (e.g., `{ humidity: 'Outdoor Temperature' }` reads `state.humidity`)
- The condition key used in rule evaluation (e.g., `humidity: { gte: 50 }`)

Adding new sensor types requires **zero code changes** — just add them to the YAML config. Supported numeric operators: `lt`, `lte`, `gt`, `gte`.

## Configuration File

Located at `etc/automation/tts-weatherman.yaml`:

```yaml
timer_interval: "1h"            # Human-readable interval ("90s", "3m 45s", "1h"); omit to go event-driven
silence_between: "2300-0600"    # Suppress execution during this time window

sentence_base: 'weatherman.base'           # Always-played opening i18n key
sentence_ai_prefix: 'weatherman.ai_prefix' # Prepend when routing through AI

# OPTIONAL -- add a proverb to every announcement, placed after the report body
# and before the next-update closer, drawn from etc/i18n/<locale>/proverbs.txt.
add_proverb: false

# All sensors are read dynamically — any key here becomes available for conditions
sensors:
  illuminance: 'Outdoor Luminance'
  temperature: 'Outdoor Temperature'
  humidity: 'Outdoor Temperature'         # Same combined sensor as temp
  pressure: 'Kitchen Temperature'         # Separate barometer device

# OPTIONAL -- Extra parameters forwarded verbatim into the TTS server request for every
# utterance produced by this automation (radio-style jingle framing). Each entry applies
# only when set; leave empty to keep the plain { model, text, output_endpoint } shape.
# A named profile from the locale tts.yaml profiles: registry may supply the same fields
# (tts_profile: 'report'); explicit entries below win over the profile field by field.
tts_options:
  intro:          # Wave filename played before the synthesized speech
  outro:          # Wave filename played after the synthesized speech
  intro_spacing:  # Seconds between intro end and speech start; negative = overlap (e.g., -2.5)

rules:
  - name: 'Warm day'
    priority: 1                           # Low — comfort advice only
    conditions:
      time_of_day: [morning, noon, afternoon]
      temperature: { lte: 25, gte: 18 }
      humidity: { lte: 55 }
    sentence: 'weatherman.soothing_warm_day'

  - name: 'Hot day'
    priority: 2                           # Medium — generic heat warning
    conditions:
      time_of_day: [morning, noon, afternoon]
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
      time_of_day: [evening, night]
      temperature: { lte: 18 }
    sentence: 'weatherman.warning_chill_night'

  - name: 'Warm evening'
    priority: 1
    conditions:
      time_of_day: [evening]
      temperature: { gt: 18 }
    sentence: 'weatherman.soothing_warm_evening'

  - name: 'Warm night'
    priority: 1
    conditions:
      time_of_day: [night]
      temperature: { gt: 18 }
    sentence: 'weatherman.soothing_warm_night'
```

### Historical trends

`SensorHistoryService` records actual device reports independently of WeatherMan's
speech schedule, quiet hours, playback suppression and AI availability. Finite numeric
`temperature`, `humidity` and `pressure` fields are recorded by default. Restoring
cached device state does not create measurements, and partial reports only contribute
the properties actually present. Unchanged reports are retained as observations of
continued availability; reports are subject to the existing MQTT duplicate filter.

```yaml
# In etc/automaton.yaml:
sensor_history:
  enabled: true
  properties: [temperature, humidity, pressure]
  retention: "7d"

# In etc/automation/tts-weatherman.yaml:
history:
  enabled: true
  window: "1h"   # baseline duration
  gap: "1h"      # baseline ends one hour before now
  max_gap: "2h"
  min_coverage: 0.8
  tolerances: { temperature: 0.2, humidity: 2, pressure: 0.5 }
```

SQLite stores `(device, property, ts_ms, value)` in `sensor_samples`. Duplicate
observations for the same series and millisecond replace that millisecond's value.
The recorder prunes on startup and hourly; a non-positive or invalid retention
falls back to seven days. Disabling recording leaves existing data queryable until
retention removes it. Database failures leave current-value weather reports usable;
missing observations are not backfilled.

At announcement time, the current sensor reading is compared with the historical
baseline `[now-gap-window, now-gap)`. With the defaults, an 18:00 report compares
the current reading against observations from 16:00 to 17:00. The most recent hour
is excluded from the baseline. `window` controls baseline duration; `gap` controls
how far back it ends and may be zero.

The baseline mean is **time-weighted**: each observation counts for how long it
lasted, until the next report or `max_gap`, whichever comes first. SQL clips intervals
to baseline boundaries and does not fill stale gaps indefinitely. Frequent reports
do not receive extra weight. The baseline needs `min_coverage` (default 80%), and
the latest observation of the current property must be no older than `max_gap`.
The current device value must also be finite. Invalid settings leave trends neutral.

The tolerances are in each measurement's units: degrees Celsius, humidity percentage
points and hectopascals. Current-minus-baseline differences within tolerance are stable; larger ones
are rising or falling. Differences are rounded to the same one-decimal precision
used in speech. There is no oscillation classification.

The default two-hour `max_gap` accommodates sensors that report roughly hourly or
only when values change. A reading is held until the next report or this limit;
no synthetic samples are inserted. Coverage means observed or held time within
the baseline, not a count of reports or total process uptime. A 30-minute limit
would leave gaps between hourly reports even after days of uptime. Increase the
limit explicitly for devices with longer reporting intervals; silence beyond the
limit is unknown, not evidence of stability.

The base sentence uses `{% temperature_reading %}`, `{% humidity_reading %}` and
`{% pressure_reading %}`. Each renders the configured sensor's current value with
neutral, stable, rising or falling wording from `readings.<metric>` in the locale
bundle. For example: “Temperatura na zewnątrz wynosi 9,4 stopni Celsjusza i w ciągu jednej godziny trzydziestu minut spadła o 0,8 stopnia”.
Changes quantify the difference between the current reading and the baseline mean.
Existing speech templates are retained; their duration uses the baseline midpoint
(`gap + window / 2`, 90 minutes by default), an approximate reference age.
Speech does not announce the averages themselves or append history
sentences. Missing, disabled, stale or insufficient history uses neutral wording,
never an assumed stable trend. Legacy `*_history` tokens resolve to empty strings.
These clauses also work in winning-rule sentences and direct TTS / AI fallback.

Temperature and humidity from a combined sensor are independent database series.
Every finite property actually present in a report is stored, including unchanged
values; partial reports do not manufacture observations for absent properties.
A fresh deployment needs observations covering enough of the historical baseline before
trends appear. Current readings remain available during that initial period.

### Time-of-Day Periods

Rules use fixed local periods: night 00–04, morning 05–10, noon 11–12,
afternoon 13–17, evening 18–23. See [Time-of-Day Periods](../architecture/time-of-day-periods.md).
Use `/automation coverage <name>` to inspect gaps and overlaps; append `legacy` for older seasonal periods.

## TTS Server Passthrough Options

`tts_options` adds speech framing to every announcement:

| Key | Type | Meaning |
|-----|------|---------|
| `intro` | string | Wave filename (on the TTS server side) played before the synthesized speech |
| `outro` | string | Wave filename (on the TTS server side) played after the synthesized speech |
| `intro_spacing` | number | Seconds between intro end and speech start; negative values overlap them (e.g., `-2.5`) |

`tts_profile` selects a locale profile; explicit `tts_options` override its fields. See [TTS Integration](../installation/tts-integration.md) for shared resolution and fallback rules.

Behaviour details:

- Empty values are omitted; malformed values warn and are dropped.
- Options apply to AI output, direct TTS, and AI-failure fallback.
- Runtime event values override locale defaults.
- Audio files must exist on the TTS server.

## Interpolation Syntax

Two placeholder types are supported inside i18n strings:

| Placeholder | Example | Resolves To |
|-------------|---------|-------------|
| `{{ DeviceName.property }}` | `{{ Outdoor Temperature.temperature }}` | Live sensor value from Zigbee2MQTT (locale-formatted numbers) |
| `{% time %}` | `{% time %}` | Current local time using the configured `time_format` |

If a device or property isn't found during interpolation, it resolves to `"N/A"`. The clock-part tokens (`{% time_words %}`, `{% hours %}`, `{% minutes %}`, `{% time_of_day %}`, `{% date %}`, `{% next_interval %}`) are pre-resolved internally by the automation — see [Weatherman Speech Rendering](../architecture/weatherman-speech-rendering.md). With `add_proverb: true`, the `{% proverb %}` token in the `ai_proverb` / `tts_proverb` keys is pre-resolved the same way, from a random line of `etc/i18n/{locale}/proverbs.txt`.

## Closing Proverb

Set `add_proverb: true` to give every announcement a proverb. The proverb is drawn at random from `etc/i18n/{locale}/proverbs.txt`, where **each line is one proverb** (blank lines and `#` comment lines are skipped, so a documented header is safe). The lists ship as clean starter templates (`proverbs.txt.dist`); copy one next to it as `proverbs.txt` (git-ignored) and add your own lines.

Two i18n keys are involved, because the two output paths need genuinely different text:

| Key | Path | Intent |
|-----|------|--------|
| `ai_proverb` | AI prompt | A **direction** for the model, which then announces the proverb in its own voice (`Przypomnij słuchaczom przysłowie: ...`) |
| `tts_proverb` | Direct TTS and the AI-failure fallback | A line that **reads as natural speech** on its own (`I pamiętajcie: ...`) |

Selection is memory-safe: `src/lib/randomLine.js` streams the file twice (count, then fetch) with a fixed buffer instead of loading and splitting it, so peak memory does not grow with the list size. A missing key, missing file, or empty file simply drops the segment — the weather report itself is never affected.


## Language Bundles

Each locale ships a `weatherman.yaml` bundle with the sentence templates. English (`en_US/weatherman.yaml`):

```yaml
base: 'The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius, humidity is at {{ Outdoor Temperature.humidity }} percent, and atmospheric pressure is {{ Kitchen Temperature.pressure }} hectopascals.'
ai_prefix: 'You are a weather announcer. Rewrite the following information creatively and uniquely, spelling out the hour in words. Do not use tools -- base your answer only on the provided information: '
# Day-position markers (see Weatherman Speech Rendering)
ai_message_first: 'This is the first update of today.'
ai_message_last: 'This is the last update of tonight. The next update is tomorrow.'
ai_message_only: 'This is the only update of today.'
ai_message_next: 'Next update in {% next_interval %}.'
# Closing proverb (add_proverb: true) -- see the Closing Proverb section
ai_proverb: 'Remind your listeners of this proverb: {% proverb %}'
tts_proverb: 'And remember: {% proverb %}'
warning_hot_day: 'WARNING: It is hot outside. Avoid prolonged exposure.'
# ... further warning_* / soothing_* sentence keys
```

Translate the same keys in each locale’s `weatherman.yaml`. Polish clock words are generated by `src/lib/polish.js` through `src/lib/date.js`.

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
| English proverb list (one per line) | `etc/i18n/en_US/proverbs.txt.dist` |
| Polish proverb list (one per line) | `etc/i18n/pl_PL/proverbs.txt.dist` |
| Random line reader (memory-safe) | `src/lib/randomLine.js` |

---

→ Back to [Automations](./index.md) · Sibling example: [Ambient Lights](./ambient-lights.md)
