# TTS Greeter

The **ttsGreeter** automation greets people when their computers come back online. Instead of greeting every blip, it measures *how long the host was absent* from the transition history (`DatabaseService.priorStateDurationMs()` — the interval between the host's two most recent state changes) and picks a message bucket from pure YAML data — quick reboots get a joke, short returns get *"did you forget something?"*, real absences get a proper welcome. Adding a new condition is a config change, not a code change.

## How It Works

1. On each `network:<host>` event (or timer/forced run covering all configured hosts), the automation checks whether that host is **online now**. Going-offline events are observed but never spoken about.
2. The absence duration comes from the database: how long the host sat offline *before this return*. With no prior history yet (fresh install, pruned rows) it fails open with the full welcome rather than staying silent at the door.
3. The duration is matched top-down against `greeting_windows` — first match wins, no match means silence (a 2-hour gap between windows stays quiet by design).
4. Output routing is an explicit boolean switch, unlike WeatherMan which always prefers AI:
   - `use_ai: false` → speak the bucket's `tts.<host>` sentence directly;
   - `use_ai: true` + AI available → send the bucket's `ai.<host>` instruction to the model, which speaks its own greeting (`AiAssistant` fires `tts:speak` for it);
   - `use_ai: true` + AI down / empty reply / provider error → warn in logs and speak the plain TTS sentence instead. There is deliberately **no spoken fallback notice** here — a missed greeting must not be announced twice.

If **neither** the AI pipeline nor the TTS server is available, the run is skipped entirely before any evaluation work. A configured `silence_between` window suppresses runs unless forced.

## Greeting Windows

Windows are evaluated in YAML order; bounds accept human-readable durations or plain milliseconds, and either side may be open-ended:

```yaml
triggers_network: [kyeno, meerkat]    # hosts to greet on return
use_ai: false                         # precise AI/TTS switch (default off)

greeting_windows:
  - name: 'quick_reboot'              # short blip -> fun "it just rebooted!" line
    absent_for: { gte: "5s", lte: "2m" }
    sentence: 'reboot'                # greeter bundle section (per-host tts/ai lines inside)
  - name: 'short_return'              # came back quickly -> "did you forget something?"
    absent_for: { gte: "7m", lte: "30m" }
    sentence: 'forgot'
  - name: 'welcome_back'              # been gone for real -> proper welcome
    absent_for: { gte: "4h" }         # open-ended above
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

## Component Paths

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/ttsGreeterAutomation.js` |
| Configuration | `etc/automation/tts-greeter.yaml` (+ `.dist` template) |
| Language bundles | `etc/i18n/{locale}/greeter.yaml` (+ `.dist` templates) |
| Absence measurement | `src/service/databaseService.js` → `priorStateDurationMs()` |
| Transition source | `src/monitor/networkPresence.js` (records online/offline flips) |
| Tests | `tests/test-tts-greeter.js`, `tests/test-database-service.js` |
