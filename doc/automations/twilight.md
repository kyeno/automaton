# TTS Twilight

The **ttsTwilight** automation announces civil dawn and civil dusk out loud — one sentence when civil dawn begins, one when civil dusk begins, each on its own minute and each framed by its own audio signature. It speaks instead of commanding devices: its rules declare no `targets:` maps, so the base class has nothing to resolve against the device container. Everything that decides *what is said* lives in YAML: the sentences, the voice framing, and the gate each event must pass.

## How It Works

1. A timer anchored to wall-clock minute boundaries ticks every `timer_interval` (shipped: `1m`). Each tick computes today's civil dawn and civil dusk instants from the active locale's `geo_latitude` / `geo_longitude` — the same coordinates the roller automations use, and the same civil-twilight definition (sun 6° below the horizon) behind the `sundawn` / `sundusk` context keys. The first tick is scheduled onto the next boundary rather than starting at process-start phase, so every event lands in the same minute as a tick.
2. An event is announceable only while it is *fresh*: its instant has already passed, and not more than `announce_grace` ago (shipped: `5m`). A machine that slept through dawn therefore announces it late, inside the window, and a restart hours later stays silent instead of announcing yesterday's dawn. A grace shorter than the tick warns at startup, because an exact-minute event could then fall between two ticks.
3. Which event is being announced is decided by the rule gates, evaluated through the shared rule engine. The shipped pair is mutually exclusive across the whole day: dawn owns the dawn-to-dusk window, dusk owns everything from dusk on. Rules are evaluated in YAML order and the first announceable one speaks, so dawn and dusk can never both fire on the same tick.
4. `once: true` reuses the rule engine's daily marker in Redis (`auto:<automation>:once:<rule-slug>`) so a rule speaks at most once per day, surviving restarts. When Redis is unavailable the marker checks fail open — the freshness window is what bounds the repeats.
5. Output routing is the same explicit boolean switch the greeter and gardener use:
   - `use_ai: false` → speak the bundle section's `tts` line directly through TTS;
   - `use_ai: true` + AI available → send the section's `ai` instruction to the model, which composes its own announcement (`AiAssistant` fires `tts:speak` for it);
   - `use_ai: true` + AI down / empty reply / provider error → warn in logs and speak the plain `tts` line instead. There is deliberately **no spoken fallback notice** — a dawn must not be announced twice.
6. A manual run (`automaton automation run TtsTwilightAutomation`) previews the *upcoming* event — the next dawn at 03:00, the next dusk at 12:00 — so you can hear what is coming. A preview never consults and never consumes the daily marker, so the real announcement still fires on its own minute.
7. A configured `silence_between` window suppresses timer runs; a forced run (`automaton automation force TtsTwilightAutomation`) bypasses that window and the daily marker alike, so it announces whatever is fresh right now. The freshness window itself is never bypassed — a forced run hours after dawn stays quiet, because the announcement it would make is not today's.

When **neither** the AI pipeline nor the TTS server is available, the run is skipped before any evaluation work. When the locale has no coordinates, the automation warns (once per day, not once per tick) and stays silent.

## Configuration

```yaml
use_ai: true                       # true -> AI composes the announcement, plain TTS on failure
timer_interval: "1m"               # tick driving the announcements -- keep at minute granularity
announce_grace: "5m"               # announce an event this long after its instant (catch-up window)
silence_between: null              # "HHmm-HHmm" local window to stay quiet; null = announce at any hour

rules:                             # dawn first, dusk second -- first announceable rule wins per tick
  - name: 'Civil dawn'
    event: 'sundawn'               # civil dawn instant computed from locale.geo_* (alias: sunrise)
    conditions: { hour: { gte: 'sundawn', lt: 'sundusk' } }   # gate: the dawn-to-dusk window
    sentence: 'twilight.sundawn'
    once: true                     # one announcement per day (the rule engine's Redis marker)
    tts_profile: 'sundawn'         # -> profiles.sundawn in the active locale's tts.yaml

  - name: 'Civil dusk'
    event: 'sundusk'               # civil dusk instant computed from locale.geo_* (alias: sunset)
    conditions: { hour: { gte: 'sundusk' } }   # gate: from dusk on, the dawn window is closed
    sentence: 'twilight.sundusk'
    once: true                     # one announcement per day (the rule engine's Redis marker)
    tts_profile: 'sundusk'         # -> profiles.sundusk in the active locale's tts.yaml
```


| Key | Shipped | Meaning |
|-----|---------|---------|
| `use_ai` | `true` | `true` routes each announcement through the model, with plain-TTS fallback — the words-of-the-hour wording lives in the `ai` lines, so the shipped home runs on the AI path |
| `timer_interval` | `1m` | Timer tick. The first tick is scheduled onto the next boundary, so announcements are minute-anchored |
| `announce_grace` | `5m` | Freshness window: announce an event only this long after its instant (a missing or malformed value falls back to `5m`) |
| `silence_between` | `null` | `"HHmm-HHmm"` local window that suppresses timer runs |
| `rules[].event` | — | `sundawn` / `sunrise` or `sundusk` / `sunset` — which civil-twilight instant the rule announces |
| `rules[].conditions` | `after_latest_of` of its own event | Gate evaluated by the shared rule engine; `hour:` bounds accept the `sundawn` / `sundusk` shorthands |
| `rules[].sentence` | — | Bundle section to speak, e.g. `twilight.sundawn` (the leading segment is a namespace; the bundle carries `sundawn:` / `sundusk:`) |
| `rules[].once` | `true` | One announcement per day per rule |
| `rules[].tts_profile` / `tts_options` | — | Framing applied to this rule's announcements (see below) |

## Language Bundles

Sentences live in `etc/i18n/{locale}/twilight.yaml`, one section per rule with a `tts` line and an `ai` instruction:

```yaml
sundawn:
  tts: 'Dzień dobry. Wschód słońca, {% time_words %} {% time_of_day %} -- kalendarzowy świt tego dnia. Będzie coraz jaśniej.'
  ai: 'Nie używaj narzędzi -- ... Jest kalendarzowy świt tego dnia: wschód słońca, {% time_words %} {% time_of_day %}. Powiedz krótko i ciepło ... Godziny nie zapisuj cyframi. Nigdy nie mów "świt cywilny".'

sundusk:
  tts: 'Zachód słońca, {% time_words %} {% time_of_day %} -- kalendarzowy zmierzch tego dnia. Będzie coraz ciemniej.'
  ai: 'Nie używaj narzędzi -- ... Jest kalendarzowy zmierzch tego dnia: zachód słońca, {% time_words %} {% time_of_day %}. Powiedz krótko ... Godziny nie zapisuj cyframi. Nigdy nie mów "zmierzch cywilny".'
```

- `{% time_words %}` → the event instant spoken as words in the locale's language: `06:18` becomes **szósta osiemnaście** in Polish (12-hour clock, feminine ordinal agreeing with *godzina*, cardinal for the minutes, no minutes word on the exact hour). Computed by code — see "The hour in words" below — and it degrades to the digit clock in a locale whose language has no generator, so a sentence never breaks
- `{% time %}` → the event's own civil-twilight instant, zero-padded 24-hour clock (`05:40`, `18:20`) — always 24h so TTS never disambiguates AM/PM
- `{% time_of_day %}` → the localized day-period word for that instant, taken from `date.yaml` `period_words:` (`rano`, `w południe`, `po południu`, `wieczorem`, `w nocy`) — the same words the weatherman's opening line uses, owned by `src/lib/date.js`
- `{% hours %}` / `{% minutes %}` → the same instant split into clock parts, the hour in the locale's `time_format` (12-hour in a `12h` locale, so `18:20` is `6`) — the parts an `ai` line asks the model to voice as words

Every one of them is derived from the **event instant**, never from the running clock: a catch-up tick four minutes after dawn, and a manual preview of dawn taken at 03:00, both speak dawn's hour and dawn's `rano`.

**No survey jargon out loud.** Civil dawn and civil dusk are the *instants* the automation works with; they are not words anyone says at home, so the shipped sentences never name them. They say what the light is doing ("it's gonna get bright soon", "it's gonna darken soon"), they name the hour, and they call the event the calendar sundawn / sundusk of the day. The `ai` line carries the same facts to the model — the calendar sundawn/sundusk of the day and its clock time — and repeats the ban, so an improvised announcement stays as plain as the spoken one.

**The hour in words.** A TTS engine reading `06:18` says "sześć osiemnaście", and that is not how Polish names an hour: the hour is a feminine adjective agreeing with *godzina* — **szósta** osiemnaście. Declining it is arithmetic, not creativity, so the automation does it in code: [`src/lib/polish.js`](../../src/lib/polish.js) spells the clock out (12-hour clock, feminine ordinal for the hour, cardinal for the minutes, hours 13-23 read as 1-11) and `src/lib/date.js` → `getClockWords()` serves it only to locales whose language has a generator. `{% time_words %}` is that phrase, and both paths consume it: the plain `tts` line is spoken as *Wschód słońca, szósta osiemnaście rano*, and the `ai` line hands the model the finished words instead of a grammar lecture — the Polish instruction is now one clause, *godziny nie zapisuj cyframi*, because a small CPU-bound model has nothing left to decline. `17:37` at an afternoon event arrives as *piąta trzydzieści siedem po południu*. English needs no generator at all — "six eighteen" is already what English says — so `getClockWords()` returns `null` there, `{% time_words %}` falls back to the digit clock, and its `ai` line keeps asking for words in prose.

Every placeholder above is filled by the automation, so a bundle that names none of them is complete. The `tts` line is spoken verbatim on the plain-TTS path (and as the fallback when AI fails); the `ai` line is an *instruction* to the model — never read aloud itself.

A missing section warns and skips the rule; a placeholder the automation does not fill warns and skips that sentence, so a typo in a template stays visible in the logs instead of being spoken.

## TTS Profiles

Each rule names a `tts_profile:` resolved by the shared [TTS framing profiles](../installation/tts-integration.md) owner (`src/lib/ttsProfiles.js`) against the active locale's `tts.yaml` `profiles:` registry — so dawn and dusk are recognizable by their jingle alone:

```yaml
profiles:
  sundawn:                        # ttsTwilight -- civil dawn announcement
    intro: 'soumages-bird-sound-2-370343.mp3'
    intro_spacing: -1             # -1 = intro tail overlaps the speech start by one second
  sundusk:                        # ttsTwilight -- civil dusk announcement
    intro: 'freesound_community-cricket-chirp-101026.mp3'
    intro_spacing: 0              # 0 = intro ends exactly as the speech starts
```

The shipped entries name a birdsong intro for dawn and a cricket-chirp intro for dusk, so the two events are recognizable by their jingle alone. Audio files must exist on the machine running tts-server, so the filenames are a deployment decision: the `.dist` template leaves `intro` commented out and carries `intro_spacing` only. A profile carries framing only — never `output_endpoint`, and never `model` / `piper_effects` / `sox_effects`, which stay locale-template settings. An explicit `tts_options:` block on a rule overrides the profile field by field, and an unknown profile name warns once and contributes nothing: the sentence is spoken plain.

## Component Paths

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/ttsTwilightAutomation.js` |
| Configuration | `etc/automation/tts-twilight.yaml` (+ `.dist` template) |
| Language bundles | `etc/i18n/{locale}/twilight.yaml` (+ `.dist` templates) |
| Civil twilight instants | `src/lib/sun.js` → `getSunTimes()` (returns `sundawn` / `sundusk` as civil dawn / civil dusk, falling back to sunrise / sunset where civil twilight is undefined) |
| Gate evaluation | `src/automation/base/ruleBasedAutomationBase.js` → `conditionsMatch()` |
| Spoken clock words | `src/lib/polish.js` (numerals, hour ordinals) behind `src/lib/date.js` → `getClockWords()` |
| TTS framing profiles | `src/lib/ttsProfiles.js` |
| Tests | `tests/test-tts-twilight.js` |

---

→ Back to [Automations](./index.md) · Related: [TTS Integration](../installation/tts-integration.md) · [TTS Greeter](./greeter.md) · [Configuration Guide](../configuration.md)
