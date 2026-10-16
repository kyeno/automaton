# TTS Gardener

The **ttsGardener** automation watches soil-moisture flower probes and reports plant hydration out loud. It commands nothing — like the greeter and twilight it speaks instead of actuating. What decides *what is said* is a per-plant severity band computed from live probe readings against the thresholds you declare in YAML, and the announcement always follows the **worst** plant in the garden.

The readings come from the device state property zigbee2mqtt exposes on capacitive soil probes: **`soil_moisture`**. That is the real key; `moisture` is not what the bridge publishes, and a rule set pointed at a key the device never reports reads nothing at all.

## How It Works

1. **Reading.** Every flower named in `triggers_zigbee:` is looked up in the device container and its numeric value is taken from the state key named by `moisture_property:` (default `soil_moisture`). A probe that is missing, offline without any cached state, or reporting a non-numeric value is skipped with a warning — one dead probe never silences the rest of the garden, and it never becomes a silent zero.
2. **Banding.** `rules:` are evaluated top-down per plant and the **first matching band wins**, so list them most-severe-first. Each plant gets a severity from its own band; the announcement uses the band of the worst plant, and the affected list names every plant below the healthy band, driest first.
3. **Reactive gate.** A device event triggers an evaluation, but speech fires only when some plant has **worsened past the band it was last announced in** *and* the worst plant has reached a band marked `reactive: true`. Periodic battery blips at the same moisture level never re-announce, and a slow drift into a band marked `reactive: false` (`Getting dry` and `Healthy` in the shipped config) is left to the scheduled report — the baseline moves, the voice does not, so the next drop into an urgent band is still heard. Recovery is observed and lowers the baseline silently, so the next drop below a band speaks again. Baselines are recorded *after* a successful utterance, so a failed speech never consumes the right to announce.
4. **Event cooldown.** Two event reports never come closer than `event_cooldown:` (default `5m`). The window is garden-wide rather than per-plant, because a burst of six probes crossing a threshold together would otherwise stack six utterances on the TTS queue. A worsening suppressed by the cooldown does not move the baseline, so a drop from `Needs watering` into `Critical drought` inside the window is still announced as an escalation once the window expires. Scheduled reports and manual runs are never cooled.
5. **Scheduled reports.** Each `announce_times:` slot fires once per day, driven by the minute-granularity `timer_interval:` tick — a full status report even when everything is fine. A tick with no slot due does nothing. Each slot consumes the rule engine's shared once-per-day marker (`auto:TtsGardenerAutomation:once:announce_slot_HHmm` in Redis), so a restart inside the grace window cannot re-fire a slot that already spoke, and a forced run never eats a slot's daily budget. The once-marker is set only *after* the report has actually spoken, so a slot whose AI call is still running is not yet marked; to keep the next tick inside the grace window from launching a duplicate, the slot is held in an in-memory in-flight set for the duration of the report (released in a `finally`), and a tick that finds the slot already in flight stays quiet. The set is process-local — a restart clears it — but that is safe because the Redis once-marker is the authoritative copy across restarts. The reporting model is one report per slot, even when the garden is healthy; the only speech that may fall outside a slot is a worsening that reaches a reactive band (item 3) and the stuck-probe warning (item 10).
6. **Manual runs** (`automaton automation run TtsGardenerAutomation`) always speak immediately, bypassing the worsening gate, the reactive band gate and the cooldown.
7. **Output routing** is the same explicit boolean switch the greeter and twilight use:
   - `use_ai: false` → speak the bucket's `tts` line directly through TTS;
   - `use_ai: true` + AI available → send the bucket's `ai` instruction to the model, which composes its own report (`AiAssistant` fires `tts:speak` for it);
   - `use_ai: true` + AI down / provider error / empty reply → warn in logs and speak the plain `tts` line instead. There is deliberately **no spoken fallback notice** — a dry plant must not be announced twice.
8. A configured `silence_between:` window suppresses timer and event runs; a forced run (`automaton automation force TtsGardenerAutomation`) bypasses it.
9. When **neither** the AI pipeline nor the TTS server is available, the run is skipped before any evaluation work.
10. **Stuck-probe watchdog.** Every `stuck_check_interval:` (default `24h`) the automation snapshots every readable probe and compares the new readings with the snapshot of the previous cycle. A probe reporting **byte-for-byte the same value** as it did a whole cycle ago is flagged: a capacitive probe frozen on one number is far more likely stuck than soil that is perfectly stable, so the warning names the probe and tells you to give it a poke. The snapshot is data recording, not speech, so it is taken on every run — silent period, down output channels and all; only the warning is gated by the off-guard, `silence_between:`, `stuck_warn_cooldown:` and `stuck_speak:`. The snapshot lives in Redis (`auto:TtsGardenerAutomation:stuck:snapshot`, TTL twice the interval) together with the warning marker (`:stuck:warned`), so a restart in the middle of a cycle keeps the baseline it has to compare against and does not reset the cooldown; while Redis is unreachable the watchdog runs off its in-memory copy. A probe present on only one side of the comparison — offline, renamed, non-numeric — is never judged, and a snapshot written in the future (a clock correction, a restored keyspace) re-baselines instead of warning.

## Configuration

```yaml
triggers_zigbee: [Flower Sensor One, Flower Sensor Two]  # probes to watch (must exist under sensor: in etc/device/zigbee.yaml)

moisture_property: 'soil_moisture'   # state key carrying the percent value (z2m exposes soil probes as soil_moisture)

use_ai: false                        # true -> AI composes the report, plain TTS on failure
tts_profile: ''                      # name a profiles: entry of the locale tts.yaml to add jingles
announce_times: ["0830", "1900"]     # local HHmm slots for the daily status report (each fires once per day)
timer_interval: "1m"                 # tick driving announce_times -- keep at minute granularity
silence_between: "2300-0600"         # suppress execution between these local times; null disables
event_cooldown: "5m"                 # minimum gap between two event-driven reports; 0 disables
stuck_check_interval: "24h"          # gap between two moisture snapshots -- the stuck-probe cycle; 0 disables the watchdog
stuck_warn_cooldown: "12h"           # minimum gap between two spoken stuck-probe warnings; 0 speaks on every detection
stuck_speak: true                    # false keeps the stuck-probe warning in the logs only

rules:                               # most severe first -- first matching band wins per plant
  - name: 'Critical drought'         # reactive: true -> a drop into this band speaks on its own
    conditions: { moisture: { lte: 20 } }
    sentence: 'gardener.critical'
    reactive: true
  - name: 'Needs watering'
    conditions: { moisture: { lte: 35 } }
    sentence: 'gardener.dry'
    reactive: true
  - name: 'Getting dry'              # reactive: false -> reported by the scheduled slots only
    conditions: { moisture: { lte: 50 } }
    sentence: 'gardener.slightly_dry'
    reactive: false
  - name: 'Healthy'
    conditions: { moisture: { gt: 50 } }
    sentence: 'gardener.healthy'
    reactive: false
```

| Key | Default | Purpose |
|-----|---------|---------|
| `triggers_zigbee` | — | Friendly names of the probes to watch; each must exist under `sensor:` in `etc/device/zigbee.yaml` |
| `moisture_property` | `soil_moisture` | State key carrying the percent value. Change it only for an exposure that names the value differently |
| `use_ai` | `false` | Route each announcement through AI → TTS when available |
| `tts_profile` / `tts_options` | — | Spoken framing for every report (see [TTS profiles](#tts-profiles)) |
| `announce_times` | — | `HHmm` slots for the daily full report; each fires once per day |
| `timer_interval` | `1m` | Tick driving the slot scheduling |
| `silence_between` | — | `HHmm-HHmm` local window with no speech |
| `event_cooldown` | `5m` | Minimum gap between two event-driven reports, garden-wide; scheduled and manual runs ignore it |
| `stuck_check_interval` | `24h` | Gap between two soil-moisture snapshots; a probe whose reading did not move at all between them is reported as stuck. `0` disables the watchdog |
| `stuck_warn_cooldown` | `12h` | Minimum gap between two *spoken* stuck-probe warnings; the detection is always logged, `0` speaks on every detection |
| `stuck_speak` | `true` | `false` keeps the stuck-probe warning in the logs only |
| `rules[].name` | — | Rule label (appears in the rules window) |
| `rules[].conditions` | — | Band test on the synthetic `moisture` value — the key here is the *reading*, not the device state key |
| `rules[].sentence` | — | Bundle section to speak, e.g. `gardener.critical` |
| `rules[].reactive` | `true` | Whether a drop into this band may be announced by an event run; `false` leaves the band to the scheduled reports |

## Language Bundles

Sentences live in `etc/i18n/{locale}/gardener.yaml`, one section per band with a `tts` line and an `ai` instruction — plus the `stuck:` section the watchdog speaks, which is not a moisture band:

```yaml
critical:
  tts: 'Uwaga! Wilgotność podłoża spadła do niebezpiecznych wartości: {% affected_flowers %}. ...'
  ai: 'Nie używaj narzędzi -- opieraj się tylko na podanych informacjach. Ogłoś pilnie, że te rośliny są na skraju całkowitego wyschnięcia: {% affected_flowers %}. ...'
```

| Placeholder | Filled with |
|-------------|-------------|
| `{% affected_flowers %}` | Every plant below the healthy band as `Name (NN%)`, driest first |
| `{% driest_flower %}` | Name of the single driest plant |
| `{% driest_moisture %}` | That plant's reading as a percentage, e.g. `21%` |
| `{% stuck_flowers %}` | Every probe whose reading did not move since the previous snapshot, as `Name (NN%)` |
| `{% stuck_window %}` | The comparison window spoken in the active locale, e.g. `24 hours` |

The `tts` line is spoken verbatim on the plain-TTS path (and as the fallback when AI fails); the `ai` line is an *instruction* to the model, never read aloud itself. Numeric values stay out of the template words on purpose so Piper TTS and small models read digits naturally in any locale — the percent sign travels inside the value itself, so the plain path says "twenty-one percent" and not a bare number. Every `ai` line opens with the weatherman's clause telling the model to use no tools and work only from the data given: the probes have already been read, and a model that goes looking for them spends the announcement on a tool call.

A missing section warns and skips the report; a placeholder the automation does not fill warns and skips that sentence, so a typo in a template stays visible in the logs instead of being spoken.

## Email Notification (Stuck Probes)

The stuck-probe warning has a mail leg that is **independent of speech**. When the watchdog flags a frozen probe it builds the warning text once (the same string the speaker would use) and hands it to the [email channel](../services/email.md) as kind `gardener_stuck`:

- The **subject** comes from the `gardener_stuck:` section of the locale `email.yaml` bundle, filled with `{% stuck_flowers %}` (the frozen probes as `Name (NN%)`).
- The **body** is the warning text verbatim, wrapped in the bundle's greeting and signature.
- The mail is **not** gated by the off-guard, `silence_between:`, `stuck_speak:` or the spoken `stuck_warn_cooldown:` — an owner asleep with the speaker muted at 3am still finds the warning in the inbox. It runs on the email channel's **own** per-kind cooldown (`email.cooldown_ms`, default `60m`), so one stuck probe produces one round of mail, not one per detection.
- Delivery is asynchronous: the watchdog queues the mail and moves on; a slow or dead relay never blocks the snapshot cycle.

To mute the mail leg without touching speech, set `email.notify.gardener_stuck: false` in `etc/automaton.yaml`; to disable the whole channel, unset `SMTP_HOST` or set `email.enabled: false`. The recipients are the `house_owners:` list.

## TTS Profiles

Reports are framed by the shared [TTS framing profiles](../installation/tts-integration.md) owner (`src/lib/ttsProfiles.js`) against the active locale's `tts.yaml` `profiles:` registry. `tts_profile:` names an entry; an explicit `tts_options:` block overrides it field by field. An unknown profile name warns once and contributes nothing — the report is spoken plain.

## Wiring The Probes Up

The automation reads devices by friendly name, so two things must be true for every plant you list:

1. **The name must match zigbee2mqtt exactly.** `triggers_zigbee:` and the `sensor:` list in `etc/device/zigbee.yaml` both key on the bridge's `friendly_name`. Rename a probe in zigbee2mqtt and it stops being a sensor in Automaton: the container has no mapping for it, instantiates it as a dummy, and the device window lists it under **Unclassified** (it used to be swept into **Mechanisms**, which is worse — a dummy answers power commands by faking a state change, so a mechanism row for a soil probe is a lie about the hardware).
2. **The state key must be the one the device reports.** For capacitive soil probes that is `soil_moisture`. `moisture_property:` exists for exotic exposures only; leaving it at the default is correct for the standard probes.

Symptoms and fixes:

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Sensor "X" not found in container` | Name in `triggers_zigbee:` does not match any bridge `friendly_name` | Use the exact zigbee2mqtt friendly name |
| `Could not read numeric "soil_moisture" from "X"` | Probe offline with no cached state, or it exposes the value under another key | Check the probe's exposes in zigbee2mqtt; set `moisture_property:` if it genuinely differs |
| A probe appears under **Unclassified** in the device window | Its friendly name no longer matches the `sensor:` entry | Fix the name in `etc/device/zigbee.yaml` (or in zigbee2mqtt), then restart |
| A probe appears under **Mechanisms** | Same drift, on a build without the unclassified bucket | Same as above |

Two tripwires make the drift visible without hunting through the UI:

- At startup the container logs `Instantiated by type: Device:1 Mechanism:8 Sensor:9 ...`. A lone `Device:N` is a device with no type mapping.
- Each unmapped device logs `No type found for "X" (slug: "...") - using DummyDevice`, and a measurement-only device that the bridge definition rescued logs `No config entry for "X" -- auto-classified as "sensor" from the bridge definition`.

A measurement-only probe whose friendly name drifted is now auto-classified as a sensor from the bridge definition, so it reports correctly and appears under Sensors even before you fix the config — the config entry is still what you should fix, because the auto-classification is a safety net, not a substitute.

In the device window, a probe's reading appears in the **Humid** column: the column shows `humidity` and falls back to `soil_moisture` when a device reports no air humidity. Air humidity always wins when a device reports both, so a plain hygrothermometer is unaffected.

## Component Paths

| Component | Path |
|-----------|------|
| Automation class | `etc/automation/ttsGardenerAutomation.js` |
| Configuration | `etc/automation/tts-gardener.yaml` (+ `.dist` template) |
| Language bundles | `etc/i18n/{locale}/gardener.yaml` (+ `.dist` templates) |
| Device lookup | `src/device/container/deviceContainer.js` → `findByName()` |
| Sensor type | `src/device/type/sensor.js` |
| MQTT semantic dedupe | `src/service/mqttService.js` (`soil_moisture` is a semantic key) |
| TTS framing profiles | `src/lib/ttsProfiles.js` |
| Stuck-probe snapshot store | `src/service/cacheService.js` (Redis `auto:TtsGardenerAutomation:stuck:*`) |
| Email leg (stuck warning) | `src/service/emailService.js` via `src/lib/announcementPipeline.js` |
| Tests | `tests/test-tts-gardener.js`, `tests/test-mqtt-soil-moisture-dedupe.js`, `tests/test-device-classification.js`, `tests/test-device-window-sensor-columns.js` |

---

→ Back to [Automations](./index.md) · Related: [TTS Integration](../installation/tts-integration.md) · [TTS Greeter](./greeter.md) · [Configuration Guide](../configuration.md)

