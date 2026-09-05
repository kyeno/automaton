# Weatherman Speech Rendering

How the [TTS Weather Man](../automations/weatherman.md) turns a rule match into a natural spoken announcement — day-position markers, pre-rendered clock phrases, and calendar-date fusion. These mechanics live in `etc/automation/ttsWeatherManAutomation.js` and `src/lib/date.js`; the user-facing config is covered by the automation's own documentation.

## Daily Cycle Markers

When routing through AI, each announcement is positioned within its **daily session** — the continuous stretch of active ticks between two `silence_between` windows (with `"0230-1030"` one session runs ~10:30 → ~02:30). The position is computed purely from wall clock + config at run time; nothing is stored, so behaviour is deterministic per moment:

| Marker | Condition | Prompt placement |
|--------|-----------|------------------|
| first | Run happened less than one timer interval after the session began | Opening line after `ai_prefix`, before the message |
| last | Session ends less than one timer interval after this run | Same opening-line slot |
| only | Both (session shorter than the timer interval) | Same slot; takes priority over first/last |
| next | Not the last update | Closing line *after* the message, containing `{% next_interval %}` |

Because timer ticks are spaced at least one interval apart even across process restarts (`setInterval` re-anchors on boot), a run less than an interval away from a session boundary can never have had a neighbour in that same session — making first/last detection exact for timer-driven runs. The only residual error is a missed "first" marker when the process was down across the wake-up boundary. Markers require a valid positive timer interval; first/last additionally require a valid `silence_between`. The small model inflects the localized unit words (e.g., Polish *"za godzinę"*) into natural speech as part of its rewrite.

## Time Phrase Rendering

Very small models — including the recommended gemma-4-E2B-it — reliably fail at converting clock strings like `9:32 PM` into natural spoken words; that was the source of garbled announcements such as *"godzina sióknasta dziesiąta jedna trzydzieści po wieczór"*. Instead of asking the model to do that conversion, the automation renders an **opening time-of-day line** itself and prepends it to the base sentence on both output paths (AI rewrite *and* direct TTS fallback). The line comes from the bundle's `time_sentence` templates, whose clock parts are pre-rendered as plain digits inside a fixed frame (*"Jest 32 minut po godzinie 9 rano"*); the model only inflects unit/ordinal forms during its rewrite. Digits stay unambiguous even when read verbatim by Piper TTS because the "N minutes past H + period word" frame can never be misread as bare H:M.

The clock fraction selects a variant template with fallback to the `default` entry:

| Minutes | Template key tried first | Status |
|---------|--------------------------|--------|
| `00` | `exact_hour` | Shipped ("Jest dokładnie godzina 9 rano") |
| any other | `default` | Shipped ("Jest 32 minut po godzinie 9 rano") |
| `30` / `45` / `15` | `half_past` / `quarter_to` / `quarter_past` | Reserved hooks — auto-selected if a locale bundle defines them; no translations shipped yet |

The templates use three interpolation tokens pre-resolved from the run's shared clock instant:

| Token | Resolves To | Example (pl, 12h) |
|-------|-------------|--------------------|
| `{% hours %}` | Hour number respecting the configured `time_format` (1–12 or 0–23) | `9` |
| `{% minutes %}` | Minute of the hour as a plain integer | `32` |
| `{% time_of_day %}` | Localized day-period word from `period_words`, keyed by the same five periods used in rule conditions (`morning/noon/afternoon/evening/night`) | `rano` |

Missing period words degrade to the raw English period name. Because the frame always states "minutes past H" plus a period word, midnight and noon stay unambiguous even with bare digits (*"godzina 12 w nocy"* vs *"w południe"*).

## Calendar Date on First Runs

On the **first run of the day** (within one timer interval of local midnight) and on the **first run of each daily session** (after a `silence_between` window), the opening line fuses the calendar date into the clock sentence via the `{% date %}` token — e.g. *"Jest wtorek, 1 września 2026 roku, 32 minut po godzinie 9 w nocy."* The date is part of the same sentence (not a separate *"Jest wtorek… Jest godzina…"* pair), so it reads naturally when spoken.

- Dated runs fuse the pre-rendered calendar date into the clock sentence, so a weak model never has to convert it.
- `time_sentence` carries two extra templates for dated runs: `dated` (generic) and `dated_exact_hour` (:00). The picker tries `dated_<fraction>` → `dated` → `<fraction>` → `default`, so a bundle that ships only the `dated` default still renders.
- The date vocabulary (day-of-week names, genitive month names, the year word, the `date_sentence` fragment, plus the `period_words` and `duration_units` used by `{% time_of_day %}` / `{% next_interval %}`) lives in the per-locale **`date.yaml`** bundle owned by the date helper (`src/lib/date.js`), not in `weatherman.yaml`. This is a one-time migration: any custom `period_words` / `duration_units` you had in `weatherman.yaml` should move to `date.yaml`.

## Related Documentation

| Document | Relation |
|----------|----------|
| [TTS Weather Man](../automations/weatherman.md) | The automation this rendering serves — config and i18n bundles |
| [AI Conversation Caching](./ai-conversation-caching.md) | How system-originated announcements stay out of chat history |
| [Configuration Guide](../configuration.md) | `timer_interval`, `silence_between`, and i18n bundle locations |