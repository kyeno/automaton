# TTS Weather Man

The **ttsWeatherMan** automation is a rule-based weather announcer that builds a speech message from a base sentence template and condition-matched additions, then routes it through the AI → TTS pipeline (or falls back to direct TTS if the AI provider is unavailable). It supports live sensor data interpolation inside i18n strings using `{{ DeviceName.property }}` syntax. Like the [greeter](./greeter.md), its side effect is speech rather than device dispatch: rules declare no `targets:` maps, so nothing is resolved against the device container.

## How It Works

1. On each timer tick, the automation loads its locale-specific i18n bundle (`etc/i18n/{locale}/weatherman.yaml`).
2. An opening time-of-day line plus a weather base sentence (e.g., *"The outside temperature is {{ Outdoor Temperature.temperature }} degrees Celsius..."*) are resolved — placeholders are replaced with real-time sensor values pulled from Zigbee devices via MQTT.
3. Condition rules are evaluated against the current context built dynamically from all sensors defined in `config.sensors`. When multiple rules match simultaneously, only the one with the highest `priority` fires (higher number wins; default is 0).
4. If an AI assistant is available, the built message is prefixed with a creative instruction key (`sentence_ai_prefix`) and sent through `AiAssistant.processMessage()` for natural-language rewriting before being spoken aloud. Otherwise the raw interpolated text goes straight to TTS. A runtime AI failure degrades the same way — the announcement never silently vanishes.

If **neither** the AI pipeline nor the TTS server is available, the run is skipped entirely before any context build or device reads. A run with exactly one of the two available still proceeds.

The clock-phrase pre-rendering, day-position markers (first/last/only/next), calendar-date fusion, and the proverb segment are rendering mechanics — see [Weatherman Speech Rendering](../architecture/weatherman-speech-rendering.md).

### Segment order

The announcement is assembled as an ordered list, structurally identical on both output paths:

```
ai_prefix (AI path only) -> [opener] -> core message -> [proverb] -> [next-update closer]
```

`ai_prefix` is the only AI-exclusive part — it is an instruction to the model and is never read aloud. Everything after it is plain text meant to be spoken.

When `add_proverb: true`, the proverb sits **after the report body but before the next-update closer**, so the next-update time stays the last thing said. That placement is why the AI wording makes no positional claim ("remind your listeners of a proverb" rather than "close with this"), and why it avoids the "at the end" phrasing `ai_prefix` already uses for its own anecdote instruction. On the last run of a session there is no closer, so the proverb becomes the final line on its own.

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

### Time-of-Day Periods

The `time_of_day` condition matches five fixed clock-based periods identical year-round (night 00–04, morning 05–10, noon 11–12, afternoon 13–17, evening 18–23); matching is hour-granular with no gaps or overlaps. Because the zones are clock-based rather than daylight-based, a warm late-afternoon now matches `[morning, noon, afternoon]` until 17:59 even in summer, while star-sky talk waits for real deep night (`[night]`, midnight through pre-dawn) all year — and rules written before commit `c1e8c6f` may have silently lost hours they used to cover ("Warm day" above stops matching once evening begins at 18:00). Full rationale, old-vs-new boundary comparison and impact analysis live in [Time-of-Day Periods](../architecture/time-of-day-periods.md); run `/automation coverage <name> legacy` to diff any automation against both schemes.

## TTS Server Passthrough Options

The optional `tts_options` block forwards extra parameters **verbatim** into the JSON body of every TTS server request that this automation produces -- a per-automation way to shape how its own voice sounds without touching the global locale template (`etc/i18n/{locale}/tts.yaml`). It exists primarily for radio-style jingle framing:

| Key | Type | Meaning |
|-----|------|---------|
| `intro` | string | Wave filename (on the TTS server side) played before the synthesized speech |
| `outro` | string | Wave filename (on the TTS server side) played after the synthesized speech |
| `intro_spacing` | number | Seconds between intro end and speech start; negative values overlap them (e.g., `-2.5`) |

The same trio may be named once per locale instead: `tts_profile: 'report'` points at an entry of the active locale's `tts.yaml` `profiles:` registry, and explicit `tts_options` entries override that profile **field by field**. Resolution belongs to the shared [TTS framing profiles](../installation/tts-integration.md) owner (`src/lib/ttsProfiles.js`), so the weatherman, the greeter, the gardener, the spoken offline alerts and the UI speak window all read the same two keys with the same rules.

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

A Polish bundle (`pl_PL/weatherman.yaml`) ships with the same keys, including `time_sentence` templates whose clock is pre-rendered **in words** (`{% time_words %}` → *dziewiąta trzydzieści dwa*, computed by `src/lib/polish.js` through `src/lib/date.js`) so tiny models never convert a clock string into words and the TTS engine never has to decline one. To add support for another language, create a new `weatherman.yaml` in your locale directory with translated keys matching those used in the automation's YAML config.

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
