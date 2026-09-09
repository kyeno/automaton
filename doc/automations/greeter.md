# TTS Greeter

The **ttsGreeter** automation greets people when their computers come back online. Instead of greeting every blip, it measures *how long the host was absent* from the transition history (`DatabaseService.priorStateDurationMs()` — the interval between the host's two most recent state changes) and picks a message bucket from pure YAML data — quick reboots get a joke, short returns get *"did you forget something?"*, real absences get a proper welcome -- plus an optional localized absence note (how long ago the host was last seen online when that is under 24h, its full calendar date and clock time otherwise) whenever transition history knows how long the host was away. Adding a new condition is a config change, not a code change. It speaks instead of commanding devices: its rules declare no `targets:` maps, so the base class has nothing to resolve against the device container.

## How It Works

1. On each `network:<host>` event (or timer/forced run covering all configured hosts), the automation checks whether that host is **online now**. Going-offline events are observed but never spoken about.
2. The absence duration comes from the database: how long the host sat offline *before this return*. With no prior history yet (fresh install, pruned rows) it fails open with the full welcome rather than staying silent at the door.
3. The duration is matched top-down against `greeting_windows` — first match wins. The shipped bands are contiguous so every return speaks; if you want a silent range, add your own gaps deliberately.
4. Output routing is an explicit boolean switch, unlike WeatherMan which always prefers AI:
   - `use_ai: false` → speak the bucket's `tts.<host>` sentence directly;
   - `use_ai: true` + AI available → send the bucket's `ai.<host>` instruction to the model, which speaks its own greeting (`AiAssistant` fires `tts:speak` for it);
   - `use_ai: true` + AI down / empty reply / provider error → warn in logs and speak the plain TTS sentence instead. There is deliberately **no spoken fallback notice** here — a missed greeting must not be announced twice.
5. When history provides an absence duration, a localized note from the bundle's `absence_note.*` section is appended after the greeting in two tiers: below 24h it says how long ago the host was last seen online (*"...8 hours ago"*, via lib/date's speech-oriented phrase), from 24h up it gives the full calendar date plus zero-padded 24-hour clock time of the offline transition itself (`DatabaseService.priorTransitionTs()`) -- both render through lib/date's date/time machinery and degrade silently when data or templates are missing. TTS notes ship as `_named` / `_anonymous` pairs: the possessive form (*"Twój komputer ..."*) is spoken only when the host's `welcome.tts` line addresses them by name; machines without a personal greeting get the neutral one.

A host may deliberately omit lines for some buckets — e.g., a shared HTPC only needs the *welcome* line. Returns landing in a bucket where that host has no `tts`/`ai` line are treated as *"greeting not required"* and skip silently (debug log, nothing spoken). A window whose `sentence` names a section missing from the bundle entirely still warns so typos stay visible; partial configurations (one channel present) keep the existing warn-and-fallback behavior.

If **neither** the AI pipeline nor the TTS server is available, the run is skipped entirely before any evaluation work. A configured `silence_between` window suppresses runs unless forced.

## Greeting Windows

Windows are evaluated in YAML order; bounds accept human-readable durations or plain milliseconds, and either side may be open-ended:

```yaml
triggers_network: [kyeno, meerkat]    # hosts to greet on return
use_ai: false                         # precise AI/TTS switch (default off)

greeting_windows:                     # contiguous bands by design: every return is greeted
  - name: 'quick_reboot'              # short blip -> fun "it just rebooted!" line
    absent_for: { lte: "2m" }
    sentence: 'reboot'                # greeter bundle section (per-host tts/ai lines inside)
  - name: 'short_return'              # came back quickly -> "did you forget something?"
    absent_for: { gte: "2m", lte: "1h" }
    sentence: 'forgot'
  - name: 'welcome_back'              # been gone for real -> proper welcome
    absent_for: { gte: "1h" }         # open-ended above
    sentence: 'welcome'
```

Add new buckets freely — e.g., a *"long weekend"* window with its own line. The `sentence` value names a section of the i18n bundle; any number of windows can point at shared or unique sections.

## Language Bundles

Sentences live in `etc/i18n/{locale}/greeter.yaml`. Each bucket holds per-host lines split by output path, and each template picks the grammatical case it needs via dual-case name placeholders filled from `names.<host>`:

```yaml
names:
  kyeno:   { vocative: 'Macieju', genitive: 'Macieja' }
  meerkat: { vocative: 'Edytko',  genitive: 'Edytkę' }

reboot:
  tts:
    kyeno: 'I bum -- komputer {% name_genitive %} właśnie się rebootował!'
  ai:
    kyeno: 'Ogłoś krótko i z humorem, że komputer {% name_genitive %} właśnie się rebootował.'
```

- `{% name_vocative %}` → direct address ("Witaj, Macieju!")
- `{% name_genitive %}` → possessive/genitive constructions ("komputer Macieja")

The `tts.*` line is spoken verbatim on the plain-TTS path (and as the fallback when AI fails); the `ai.*` line is an *instruction* to the model — never read aloud itself. English bundles keep both slots with the same plain name since English has no cases; the structure stays identical across locales.

Beyond bucket greetings, bundles carry an optional **absence note** appended after the greeting whenever transition history knows how long the host was away:

```yaml
absence_note:
  tts:
    # Possessive variant only fits hosts whose welcome.tts line addresses them by name;
    # machines without a personal greeting (e.g., htpc) get the neutral form instead.
    recent_named:     'Twój komputer ostatnio był włączony {% time_phrase %} temu'      # below 24h
    recent_anonymous: 'Komputer ostatnio był włączony {% time_phrase %} temu'          # below 24h
    long_named:       'Twój komputer ostatnio był włączony {% last_online_date %}, o godzinie {% last_online_time %}'   # from 24h up
    long_anonymous:   'Komputer ostatnio był włączony {% last_online_date %}, o godzinie {% last_online_time %}'        # from 24h up
  ai:
    recent: 'Dodatkowo wspomnij, że komputer ostatnio był włączony {% time_phrase %} temu.'
    long:   'Dodatkowo wspomnij, że komputer ostatnio był włączony {% last_online_date %}, o godzinie {% last_online_time %}.'
```

- `{% time_phrase %}` → localized duration including unit word ("58 minut"), via lib/date's speech-oriented formatter and the date bundle's `duration_units` — fills the sub-24h tier (*"...włączony 58 minut temu"*)
- `{% last_online_date %}` / `{% last_online_time %}` → both available together in the ≥24h tier: localized calendar date (the same `date_sentence` machinery WeatherMan uses) plus zero-padded 24-hour clock time ("07:35", always 24h so TTS voices never disambiguate AM/PM), rendered at the offline transition's own timestamp
- `_named` / `_anonymous` TTS variants are chosen per host at runtime — possessive only when that host's `welcome.tts` line contains a `{% name_vocative %}` / `{% name_genitive %}` placeholder. Older bundles still carrying legacy `short_*` lines keep working for the sub-24h tier instead of dropping the note entirely.

Missing sections or unresolvable tokens simply drop the note — the main greeting always stands alone.

## Component Paths

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/ttsGreeterAutomation.js` |
| Configuration | `etc/automation/tts-greeter.yaml` (+ `.dist` template) |
| Language bundles | `etc/i18n/{locale}/greeter.yaml` (+ `.dist` templates) |
| Absence measurement | `src/service/databaseService.js` → `priorStateDurationMs()`, `priorTransitionTs()` |
| Transition source | `src/monitor/networkPresence.js` (records online/offline flips) |
| Tests | `tests/test-tts-greeter.js`, `tests/test-database-service.js` |
