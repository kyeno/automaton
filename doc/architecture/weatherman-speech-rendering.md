# Weatherman Speech Rendering

How the [TTS Weather Man](../automations/weatherman.md) turns a rule match into a natural spoken announcement — segment order, day-position markers, pre-rendered clock phrases, calendar-date fusion, and the closing proverb. These mechanics live in `etc/automation/ttsWeatherManAutomation.js` and `src/lib/date.js`; the user-facing config is covered by the automation's own documentation.

## Segment Order (authoritative)

Every announcement is assembled by one private method, `#speechSegments()`, which returns an **ordered** list. Everything below is emitted through that single list, so the order is identical on both output paths and cannot drift between them:

```
1. ai_prefix          -- creative instruction, AI path ONLY (never spoken)
2. opener             -- optional: exactly one of first / last / only
3. core message       -- time line + base sentence + winning rule sentence
4. proverb            -- optional: sits after the body, before the closer
5. next-update closer -- optional: "next update in ...", ALWAYS LAST
```

Two consequences worth preserving in any future change:

- **The proverb is deliberately NOT last (slot 4).** It follows the report body and precedes the next-update line, so the next-update time stays the final thing said. This is what forces the `ai_proverb` wording to make *no* positional claim: a "close with this" phrasing would be false, because slot 5 follows it. On the last run of a session there is no closer, and the proverb then becomes the last line naturally.
- **`ai_prefix` is the only AI-exclusive slot.** Slots 2-5 are plain text spoken verbatim on both paths; slot 4 resolves a *different* i18n key per path (`ai_proverb` vs. `tts_proverb`) precisely because a direction for the model and a spoken line are different things. See [Closing Proverb](#closing-proverb).

Segments are joined with `\n` for the AI prompt (the layout the model expects) and with a single space for direct TTS (natural sentence flow). `ai_prefix` is prepended to the joined body, not included in the segment list, which is why it alone is excluded from the direct-TTS path.

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

## Closing Proverb

With `add_proverb: true` in `etc/automation/tts-weatherman.yaml`, every announcement carries a proverb drawn at random from `etc/i18n/{locale}/proverbs.txt` (one proverb per line; the reader skips blank lines and `#` comment lines). It occupies the same slot on **both** output paths -- after the report body, before the next-update closer -- but each path resolves a different i18n key:

| Key | Used by | Wording intent | Polish | English |
|-----|---------|----------------|--------|---------|
| `ai_proverb` | AI prompt | A **direction** with no positional claim, executed in the model's own voice | `Przypomnij słuchaczom przysłowie: {% proverb %}` | `Remind your listeners of this proverb: {% proverb %}` |
| `tts_proverb` | Direct TTS (+ AI-failure fallback) | A line that **reads as speech** on its own | `I pamiętajcie: {% proverb %}` | `And remember: {% proverb %}` |

The AI-failure fallback needs no extra wiring: `#degradeToRawTts()` routes through `buildDirectTtsText()`, so it picks up `tts_proverb` automatically.

**Why two keys, and why `ai_proverb` avoids "at the end".** Two independent reasons, both pinned by regression tests:

1. `ai_prefix` already ends with its own positional instruction — *"Na koniec - zanim ogłosisz, kiedy następna informacja - ..."* / *"Finally - before announcing when the next update comes - ..."* — which anchors an anecdote to a spot **before** the next-update line. A proverb instruction reusing "na koniec" / "Finally" would put two competing "at the end" anchors in one prompt, and a small model can resolve them the wrong way round.
2. The proverb is not the last segment, so a *terminal* wording ("close your report with this") would be simply false.

The shipped wording ("Przypomnij słuchaczom przysłowie" / "Remind your listeners of this proverb") sidesteps both: it is a concrete, unambiguous instruction that makes no claim about position, letting the prompt's own line order place the proverb. The tests assert that the two keys differ, that `ai_proverb` contains no end-anchor or terminal phrasing, and that the segment order holds on both paths.

Behaviour details:

- **Gated strictly.** `config.add_proverb === true`; a string `"true"` or a number `1` does not enable it (same discipline as the greeter/gardener `use_ai` switch).
- **Fresh draw per run.** No "last spoken" memory, so a three-line file repeats; keeping the list varied is the file's job.
- **Fails soft.** A missing key, a missing file, or an empty file drops the segment and logs a warning — a missing proverb must never cost the listener the weather report.
- **Memory-safe selection.** The draw goes through `src/lib/randomLine.js`, which streams the file twice (count, then fetch) with a fixed scratch buffer instead of `readFileSync().split('\n')` + random index into an array. Peak memory is independent of file size, so a large proverb list costs the same as a small one.

## Related Documentation

| Document | Relation |
|----------|----------|
| [TTS Weather Man](../automations/weatherman.md) | The automation this rendering serves — config and i18n bundles |
| [AI Conversation Caching](./ai-conversation-caching.md) | How system-originated announcements stay out of chat history |
| [Configuration Guide](../configuration.md) | `timer_interval`, `silence_between`, and i18n bundle locations |