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

This is the global default destination for all TTS requests. If this variable is not set, TTS functionality is disabled at startup with a warning message.

### Per-Request Override

The global endpoint can be overridden per-request via EventBus event payloads. This allows different automations or interactions to route speech to different audio endpoints:

```yaml
# In an automation rule
actions:
  - type: tts
    text: "Temperature rising"
    endpoint: "192.168.1.50:9876" # overrides global setting
```

### Per-Locale Override

TTS templates are stored in i18n bundles under `etc/i18n/{locale}/tts.yaml`. Each locale can define its own voice parameters, speed settings, and even endpoint overrides:

```yaml
# etc/i18n/pl_PL/tts.yaml
voice: "pl-PL-RafaNeural"
speed: 1.0
endpoint: null  # uses global TTS_TCP_ENDPOINT if null
templates:
  greeting: "Dzień dobry! Temperatura w domu wynosi {temp} stopni."
```

See [Configuration Guide](../configuration.md) for full i18n bundle structure.

## How It Works

When Automaton triggers a TTS action (from AI response, automation rule, or interaction), it sends the text payload as a TCP message to the configured endpoint. The tts-server receives the text, generates audio, and plays it through the local sound system.

The flow is:

```
Automaton → EventBus → TTS Service → TCP → tts-server → Audio Output
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
| TTS disabled at startup | Confirm `TTS_TCP_ENDPOINT` is set in `.env` |
