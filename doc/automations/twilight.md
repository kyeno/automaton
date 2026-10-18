# TTS Twilight

Announces civil dawn and actual sunset using the configured coordinates and locale.
The template uses direct TTS; `use_ai: true` enables AI rewriting with TTS fallback.

## How It Works

- A minute-aligned timer checks today's solar events.
- Events are eligible from their instant until `announce_grace` expires (default `5m`).
  A grace shorter than the timer interval warns at startup.
- The first eligible matching rule speaks. `once: true` stores a daily Redis marker;
  unavailable Redis allows repeats within the freshness window.
- Manual runs preview the next event without reading or writing daily markers.
- Forced runs bypass silence and markers, but still require a fresh event.
- Missing coordinates warn once per day. Runs skip when both AI and TTS are unavailable.

## Configuration

Copy [tts-twilight.yaml.dist](../../etc/automation/tts-twilight.yaml.dist) to
`etc/automation/tts-twilight.yaml`.

```yaml
use_ai: false
timer_interval: "1m"
announce_grace: "5m"
silence_between: null
rules:
  - name: 'Civil dawn'
    event: sundawn
    conditions: { hour: { gte: sundawn, lt: sundusk } }
    sentence: twilight.sundawn
    once: true
  - name: 'Sunset'
    event: sundusk
    conditions: { hour: { gte: sundusk } }
    sentence: twilight.sundusk
    once: true
```

| Key | Meaning |
|-----|---------|
| `use_ai` | AI rewriting when true; unavailable AI, errors, or empty replies fall back to plain TTS |
| `timer_interval` | Check cadence; default `1m` |
| `announce_grace` | Catch-up window; invalid or missing values use `5m` |
| `silence_between` | Optional local `HHmm-HHmm` suppression window |
| `rules[].event` | `sundawn` / `sunrise` for civil dawn; `sundusk` / `sunset` for actual sunset |
| `rules[].conditions` | Shared rule conditions; absent conditions default to the event's `after_latest_of` gate |
| `rules[].sentence` | Bundle section, e.g. `twilight.sundawn` |
| `rules[].once` | One announcement per local day |
| `rules[].tts_profile` / `tts_options` | Optional per-rule speech framing |

## Language Bundles

`etc/i18n/{locale}/twilight.yaml` contains `sundawn` and `sundusk` sections, each with a
plain `tts` sentence and an `ai` instruction. AI fallback speaks the plain sentence
without a separate fallback announcement.

| Placeholder | Value |
|-------------|-------|
| `{% time %}` | Event's 24-hour `HH:MM` |
| `{% time_words %}` | Spoken clock words; digit clock if the locale has no generator |
| `{% time_of_day %}` | Event's localized period word from `date.yaml` |
| `{% hours %}` / `{% minutes %}` | Event's clock parts using the locale's hour format |

All values use the event instant, including catch-up runs and previews.
Polish clock words use feminine hour ordinals on a 12-hour clock, e.g.
`17:37` → `piąta trzydzieści siedem`. The generator lives in `src/lib/polish.js`
and is exposed by `src/lib/date.js` through `getClockWords()`.
Missing sections or unresolved placeholders warn and skip that sentence.

## TTS Profiles

Profiles are optional. Define them in the locale's `tts.yaml`, then set each rule's
`tts_profile`:

```yaml
profiles:
  sundawn: { intro: 'dawn.wav', intro_spacing: -1 }
  sundusk: { intro: 'dusk.wav', intro_spacing: 0 }
```

Audio files must exist on the TTS server. Explicit `tts_options` override profile fields;
unknown profiles warn and add no framing. See [TTS Integration](../installation/tts-integration.md).

## Component Paths

| Component | Path |
|-----------|------|
| Class | `etc/automation/ttsTwilightAutomation.js` |
| Solar times | `src/lib/sun.js` |
| Rule conditions | `src/automation/base/ruleBasedAutomationBase.js` |
| Framing | `src/lib/ttsProfiles.js` |
| Tests | `tests/test-tts-twilight.js` |

Related: [Automations](./index.md) · [Configuration](../configuration.md)
