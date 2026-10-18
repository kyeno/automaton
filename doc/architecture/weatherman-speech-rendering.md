# Weatherman Speech Rendering

[Weather Man](../automations/weatherman.md) renders clock phrases, session markers,
dates, and proverbs before sending the report to AI or direct TTS.

## Segment Order (authoritative)

```text
ai_prefix (AI only) → opener → time + base + winning rule → proverb → next-update closer
```

Opener, proverb, and closer are optional. AI prompts join segments with newlines;
direct TTS joins them with spaces. `ai_proverb` is an instruction, while `tts_proverb`
is spoken text. The next-update line stays last when present.

## Daily Cycle Markers

A session is the active interval between `silence_between` windows.
Markers are computed from the current clock and timer interval:

| Marker | Condition |
|--------|-----------|
| `first` | Within one timer interval after session start |
| `last` | Less than one timer interval before session end |
| `only` | Both first and last; takes precedence |
| `next` | Not the last update; adds `{% next_interval %}` to the closer |

Markers need a positive timer interval; first/last also need a valid silence window.
No marker state is persisted. Downtime across session start can miss the first marker.

## Time Phrase Rendering

The locale's `time_sentence` templates render the opening time line on both output paths.
The template picker tries a clock-fraction key, then `default`:

| Minutes | Key |
|---------|-----|
| `00` | `exact_hour` |
| `15` / `30` / `45` | `quarter_past` / `half_past` / `quarter_to`, if defined |
| Other | `default` |

| Token | Value |
|-------|-------|
| `{% time_words %}` | Generated spoken clock phrase, or digit clock when unavailable |
| `{% hours %}` | Hour in the configured 12h/24h format |
| `{% minutes %}` | Minute as an integer |
| `{% time_of_day %}` | Localized period word; raw English period name if missing |

Polish uses `src/lib/polish.js` through `temporal.getClockWords()`, e.g.
`09:32` → `dziewiąta trzydzieści dwa`. Locale vocabulary lives in `date.yaml`.

## Calendar Date on First Runs

The opening line includes `{% date %}` within one timer interval of midnight and on the
first run of a session. Template fallback order is:

```text
dated_<fraction> → dated → <fraction> → default
```

Day names, genitive month names, `date_sentence`, `period_words`, and `duration_units`
come from `etc/i18n/{locale}/date.yaml`. Move older custom period/duration entries there
from `weatherman.yaml`.

## Closing Proverb

With `add_proverb: true`, a random line from `etc/i18n/{locale}/proverbs.txt` fills
`{% proverb %}`. Blank lines and `#` comments are skipped. Missing or empty files and
missing template keys omit the segment.

| Key | Path | Example |
|-----|------|---------|
| `ai_proverb` | AI prompt | `Remind your listeners of this proverb: {% proverb %}` |
| `tts_proverb` | Direct TTS and fallback | `And remember: {% proverb %}` |

Keep proverb instructions free of ordering directions; segment order already places it
before the closer. `src/lib/randomLine.js` streams the file with bounded memory.

## Component Paths

| Component | Path |
|-----------|------|
| Report assembly | `etc/automation/ttsWeatherManAutomation.js` |
| Date and time helpers | `src/lib/date.js`, `src/lib/polish.js` |
| Locale text | `etc/i18n/{locale}/weatherman.yaml`, `date.yaml` |
| Random proverb | `src/lib/randomLine.js` |

Related: [Weather Man configuration](../automations/weatherman.md) · [Configuration Guide](../configuration.md)
