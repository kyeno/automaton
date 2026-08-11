# STT (Speech To Text) Integration

## Status: Planned — Not Yet Implemented

Speech-to-text integration is currently on Automaton's TODO list and has no active implementation. This document outlines what it will provide once built.

## Planned Functionality

When implemented, STT integration will enable voice commands to be processed by Automaton through the following flow:

```
Microphone → Audio Capture → STT Engine → Text → Automation/AI Processing
```

### Expected Features

- **Voice-triggered automations** — Speak a command like "turn off living room light" and have it parsed into device actions
- **AI conversation input** — Voice messages routed directly to the AI chat interface as text
- **Multi-language support** — Leverage existing i18n infrastructure for locale-aware speech recognition
- **Configurable wake words** — Optional always-listening mode with configurable activation phrases

### Anticipated Configuration

Similar to TTS, STT would likely use an external service endpoint configured via `.env`:

```env
STT_API_URL=http://your-stt-server:port/v1/transcribe
STT_LANGUAGE=en-US
STT_WAKE_WORD=automaton
```

Plus per-locale settings in `etc/i18n/{locale}/stt.yaml` for language-specific models and sensitivity tuning.

### Potential Backends

Several options are under consideration:

| Backend | Type | Notes |
|---------|------|-------|
| [Whisper](https://github.com/openai/whisper) | Local inference | Open-source, multilingual, runs on CPU/GPU |
| [Vosk](https://alphacephei.com/vosk/) | Local streaming | Lightweight, offline-capable |
| Cloud APIs (Google, Azure) | External | High accuracy but requires internet + API key |

## Current Alternatives

Until native STT is implemented, you can achieve similar functionality by:

1. Running a separate voice assistant that sends text commands to Automaton's EventBus or MQTT topics
2. Using the terminal UI chat interface with your OS-level speech-to-text input method
3. Integrating Home Assistant's built-in voice pipeline if running alongside Automaton

## Follow Progress

Track STT implementation progress in [TODO & Roadmap](../TODO.md).
