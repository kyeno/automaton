# TTS Greeter

TTS Greeter announces when a configured host returns online. YAML windows select a greeting from the recorded absence duration.

When AI is enabled and available, a shared processing guard skips overlapping greetings for the same host. Different hosts remain independent. Plain TTS bypasses this guard.

## How It Works

1. On `network:<host>` events, greet only hosts that are currently online. Timer/forced runs check all configured hosts.
2. Read the preceding offline duration from SQLite. Missing history selects the full welcome.
3. Match `greeting_windows` top-down; first match wins. Gaps in the windows produce silence.
4. `use_ai: false` speaks the TTS sentence; `true` uses AI with plain-TTS fallback.
5. Append an absence note when history is available: duration below 24h, offline-transition date and 24-hour time at 24h or more.

Missing per-host bucket lines skip silently; a missing bundle section warns. Silence periods suppress runs unless forced. Runs skip when both AI and TTS are unavailable.

## Greeting Windows

Windows are evaluated in YAML order; bounds accept human-readable durations or plain milliseconds, and either side may be open-ended:

```yaml
triggers_network: [hostname1, hostname2]    # hosts to greet on return
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

## Spoken Framing

Both output paths accept the shared jingle keys, resolved once per greeting by [TTS framing profiles](../installation/tts-integration.md) (`src/lib/ttsProfiles.js`):

```yaml
tts_profile: ''                         # empty by default; optionally name a locale TTS profile
#tts_options:                           # explicit framing, wins over the profile field by field
#  intro: 'hello.wav'                   # wave played before the greeting
#  outro: null                          # wave played after the greeting
#  intro_spacing: -1.5                  # negative = overlap intro with speech start
```

Set `tts_profile` to a profile in the locale’s `tts.yaml`, or use `tts_options` for field overrides. The `.dist` default is empty: no jingle.

Framing applies to AI speech, direct TTS, and fallback speech.

## Language Bundles

Sentences live in `etc/i18n/{locale}/greeter.yaml`. Each bucket holds per-host lines split by output path, and each template picks the grammatical case it needs via dual-case name placeholders filled from `names.<host>`:

```yaml
names:
  hostname1:   { vocative: 'Janie', genitive: 'Jana' }
  hostname2: { vocative: 'Zosiu',  genitive: 'Zosię' }

reboot:
  tts:
    hostname1: 'I bum -- komputer {% name_genitive %} właśnie się rebootował!'
  ai:
    hostname1: 'Ogłoś krótko i z humorem, że komputer {% name_genitive %} właśnie się rebootował.'
```

- `{% name_vocative %}` → direct address ("Witaj, Janie!")
- `{% name_genitive %}` → possessive/genitive constructions ("komputer Jana")

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

- `{% time_phrase %}` → localized duration for absences below 24h, using `date.yaml` duration units.
- `{% last_online_date %}` / `{% last_online_time %}` → localized date and 24-hour `HH:MM` at the offline transition, for absences of 24h or more.
- `_named` is selected when the host’s `welcome.tts` uses a name placeholder; otherwise `_anonymous` is used. Legacy `short_*` lines remain supported for recent absences.

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
