# TTS Gardener

TTS Gardener reports soil moisture by severity band.
Sensor health warnings are owned by the independent [Frozen Sensor Monitor](../monitors/frozen-sensors.md).

Standard probes use the `soil_moisture` state property. The rule condition key is `moisture`.

## How It Works

1. Read numeric `moisture_property` values from the probes in `triggers_zigbee`. Missing or invalid readings warn and are skipped.
2. Evaluate bands top-down per plant; first match wins. Report the worst band's message and list unhealthy plants, driest first.
3. Event reports require worsening into a `reactive: true` band. Recovery lowers the baseline silently. Failed or cooled reports do not consume an escalation.
4. `event_cooldown` limits garden-wide event speech (default `5m`). Scheduled and manual reports bypass it.
5. `announce_times` slots report once per day using Redis markers. The shared AI processing guard prevents overlapping AI-enabled reports; markers are written after successful speech. Plain TTS bypasses the guard.
6. Manual runs speak immediately. Forced runs also bypass `silence_between` and do not consume slot markers.
7. `use_ai: false` speaks plain TTS; `true` uses AI with plain-TTS fallback on failure or empty replies. Runs skip when both channels are unavailable.
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
| `rules[].name` | — | Rule label (appears in the rules window) |
| `rules[].conditions` | — | Band test on the synthetic `moisture` value — the key here is the *reading*, not the device state key |
| `rules[].sentence` | — | Bundle section to speak, e.g. `gardener.critical` |
| `rules[].reactive` | `true` | Whether a drop into this band may be announced by an event run; `false` leaves the band to the scheduled reports |

## Language Bundles

Sentences live in `etc/i18n/{locale}/gardener.yaml`, one section per band with a `tts` line and an `ai` instruction:

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

`tts` is spoken text; `ai` is a model instruction. Percentage tokens include `%`. Missing sections or unresolved placeholders warn and skip the sentence.

## Sensor Health

Configure `alerts.frozen_sensors` in `etc/automaton.yaml` for freeze detection,
grouped initial email and 15-minute voice reminders. This monitor has its own timer
and quiet hours; gardener slots, event cooldowns and `silence_between` do not gate it.
See [Frozen Sensor Monitor](../monitors/frozen-sensors.md) for configuration and migration
from the former gardener `stuck_*` settings.

## TTS Profiles

Reports are framed by the shared [TTS framing profiles](../installation/tts-integration.md) owner (`src/lib/ttsProfiles.js`) against the active locale's `tts.yaml` `profiles:` registry. `tts_profile:` names an entry; an explicit `tts_options:` block overrides it field by field. An unknown profile name warns once and contributes nothing — the report is spoken plain.

## Wiring The Probes Up

Use exact Zigbee2MQTT friendly names in `triggers_zigbee` and `etc/device/zigbee.yaml`.
Standard capacitive probes report `soil_moisture`; change `moisture_property` only if the
bridge exposes a different key.

| Symptom | Check |
|---------|-------|
| Sensor not found | Match `triggers_zigbee` to the bridge's friendly name |
| No numeric moisture | Check connectivity, cached state, and the exposed property |
| Probe under Unclassified | Fix its type/name mapping in `zigbee.yaml` and restart |

Unmapped measurement-only devices can be auto-classified as sensors from bridge metadata.
Startup logs identify unmapped devices and report counts by type. The device window's
Humid column shows `humidity`, falling back to `soil_moisture`.

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
| Tests | `tests/test-tts-gardener.js`, `tests/test-mqtt-soil-moisture-dedupe.js`, `tests/test-device-classification.js`, `tests/test-device-window-sensor-columns.js` |

---

→ Back to [Automations](./index.md) · Related: [TTS Integration](../installation/tts-integration.md) · [TTS Greeter](./greeter.md) · [Configuration Guide](../configuration.md)

