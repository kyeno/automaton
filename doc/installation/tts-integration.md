# TTS (Text To Speech) Integration

Automaton integrates with external text-to-speech backends via TCP audio endpoints. The TTS service reads AI responses aloud through a configured audio endpoint, enabling voice feedback in your home automation setup.

## Requirements

- A running TTS server instance ([kyeno/tts-server](https://github.com/kyeno/tts-server)) or compatible backend
- `.env` variable `TTS_TCP_ENDPOINT` pointing to your TTS server's IP and port
- Audio output capability on the machine running tts-server

## Configuration

### Environment Variable

Add to `.env`:

```env
TTS_TCP_ENDPOINT=127.0.0.1:9876
```

This is the global default destination for all TTS requests. If this variable is not set, TTS functionality is disabled at startup with a warning message. You can get the same effect for a single run by starting Automaton with `--no-tts`, which overrides any configured TTS settings.

### Per-Request Override

Any component emitting the internal `tts:speak` EventBus event may attach extra parameters to its payload, and they merge into **that request only** -- every other speaker keeps the plain shape. For each optional field the resolution order is runtime event value > locale template default (see Request Parameters below).

Framing (the `intro` / `outro` / `intro_spacing` trio) is resolved for every speaker by one shared owner, [`src/lib/ttsProfiles.js`](../../src/lib/ttsProfiles.js), so all of them read the same two optional config keys and follow the same rules:

```yaml
tts_profile: 'alarm'        # name of a profiles: entry in the active locale's tts.yaml
tts_options:                # explicit framing; wins over the profile key by key
  intro: 'news-transition.wav'      # wave played before speech
  outro: 'news-outro.wav'           # wave played after speech
  intro_spacing: -2.5               # negative = overlap intro with speech start
```

- **Precedence:** the named profile forms the base, an explicit `tts_options` block overrides it field by field, and an empty/absent shape yields no framing at all -- the request keeps the plain `{ model, text, output_endpoint }` body.
- **Malformed entries never break speech.** A wrong type or an empty filename is dropped with a warning; an unknown profile name warns once per name (not once per utterance) and contributes nothing.
- **Both output paths are covered.** On the AI path the framing travels through `AiAssistant.processMessage(..., { tts })` so the model's own spoken reply carries it; on direct TTS and on AI-failure fallback it is spread straight into the emission.

Speakers wired to the resolver:

| Speaker | Where the keys live |
|---------|---------------------|
| [Weather man](../automations/weatherman.md) | `etc/automation/tts-weatherman.yaml` |
| [Greeter](../automations/greeter.md) | `etc/automation/tts-greeter.yaml` |
| Gardener | `etc/automation/tts-gardener.yaml` |
| [Twilight](../automations/twilight.md) | `etc/automation/tts-twilight.yaml` (per-rule `tts_profile:`) |
| [Offline alerts](../monitors/offline-alerts.md) | `alerts.<family>_tts_profile` / `alerts.<family>_tts_options` in `etc/automaton.yaml` (plus per-host overrides for the network family) |
| UI speak window | `ui.tts_profile` in `etc/automaton.yaml` |

### Per-Locale Template

TTS templates are stored in i18n bundles under `etc/i18n/{locale}/tts.yaml`. `model` is required; all other fields are optional and included in requests only when set:

```yaml
# etc/i18n/pl_PL/tts.yaml
model: "pl_PL-bass-high"             # REQUIRED - voice model identifier for tts-server
triple_leading_consonant: true       # phoneme handling for Polish triple consonants
piper_effects: "--length_scale 1.15" # Piper TTS engine effects
sox_effects: "pad 1.2 0.5"           # SoX audio post-processing effects
# output_endpoint: "192.168.1.x:12345"  # per-locale endpoint override (optional)

# OPTIONAL - named framing sets referenced by tts_profile: (see Per-Request Override)
profiles:
  greeting:                          # ttsGreeter -- every greeting
    intro: 'lubecin123-info-computer-sound-299367.mp3'
    intro_spacing: 0
  garden:                            # ttsGardener -- every report
    intro: 'creatorshome-digital-click-357350.mp3'
    intro_spacing: 0
  # alarm:                           # mission-critical offline alerts
  #   intro: 'alarm.wav'
  #   intro_spacing: -1.5
```

A `profiles:` entry carries framing only -- never `output_endpoint`, and never `model` / `piper_effects` / `sox_effects`: those stay locale-template settings applied to every utterance in the locale. The audio sink stays `runtime event > locale template > TTS_TCP_ENDPOINT`, so a jingle can never redirect where the voice is played. Profiles are looked up case-insensitively; audio files must exist on the machine running tts-server (the filename crosses the wire untouched, so `.wav` and `.mp3` both work as long as the server serves them).

See [Configuration Guide](../configuration.md) for full i18n bundle structure.

### Request Parameters

Every request is an HTTP POST of a JSON body to the URL from `TTS_API_URL`:

| Field | Type | Source | Meaning |
|-------|------|--------|---------|
| `model` | string | locale template (required) | Voice model identifier on the TTS server |
| `text` | string | event payload | Text to synthesize |
| `output_endpoint` | string | runtime > locale template > `TTS_TCP_ENDPOINT` | Destination (`ip:port`) where the synthesized WAV stream should be sent |
| `triple_leading_consonant` | boolean | locale template | Phoneme handling switch |
| `piper_effects` | string | locale template | Extra Piper CLI flags |
| `sox_effects` | string | locale template | SoX filter chain applied after synthesis |
| `intro` | string | runtime (`tts_profile` / `tts_options` of the speaking component) | Wave filename played before speech; file must exist on the TTS server side |
| `outro` | string | runtime (`tts_profile` / `tts_options`) | Wave filename played after speech |
| `intro_spacing` | number | runtime (`tts_profile` / `tts_options`) | Seconds between intro end and speech start; negative overlaps them |

## How It Works

When Automaton produces spoken output (AI reply, automation utterance such as the weatherman, or a UI speak command), the TTS service POSTs that JSON body -- text plus voice parameters and the destination endpoint -- to the tts-server's HTTP API. The tts-server synthesizes the speech and streams the resulting WAV over TCP to the requested `output_endpoint`, where your audio hardware picks it up.

The flow is:

```
Speaker component -> EventBus 'tts:speak' -> TTS Service -> HTTP POST -> tts-server -> TCP WAV stream -> Audio Output
```

## tts-server Setup

Clone and run tts-server separately from Automaton:

```bash
git clone https://github.com/kyeno/tts-server.git
cd tts-server
npm install
npm start
```

Configure your preferred voice provider in tts-server's configuration. See the [tts-server repository](https://github.com/kyeno/tts-server) for detailed setup instructions and supported backends.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No audio output | Verify tts-server is running and `TTS_TCP_ENDPOINT` points to correct IP/port |
| Wrong language | Ensure matching locale bundle exists in `etc/i18n/{locale}/tts.yaml` |
| TTS disabled at startup | Confirm `TTS_TCP_ENDPOINT` is set in `.env` and that `--no-tts` was not passed |

---

→ Back to [Installation & Requirements](./index.md) · Related: [AI Integration](./ai-integration.md) · [STT Integration](./stt-integration.md) *(planned)*
