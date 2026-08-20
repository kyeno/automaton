# Automaton Documentation

Welcome to the Automaton documentation hub. This page links every document in `doc/`; each section also has its own index for focused browsing. The generated JSDoc API reference lives separately under [`doc/api/`](api/index.html).

## Sections

### Architecture

Design decisions and internal mechanics.

- [Architecture Overview](architecture/index.md) — project structure, core concepts, CLI usage, testing
- [Automation vs Human Differentiation](architecture/automation-human-differentiation.md) — command provenance, token-based classification, cooldowns
- [AI Conversation Caching](architecture/ai-conversation-caching.md) — conversation persistence, TTL, system-message filtering

### Installation & Integration

Setup guides for runtime dependencies and optional external services.

- [Installation & Requirements](installation/index.md) — runtime deps, first-time setup, running modes
- [AI (LLM) Integration](installation/ai-integration.md) — OpenAI-compatible endpoint configuration
- [TTS Integration](installation/tts-integration.md) — text-to-speech backend setup
- [STT Integration](installation/stt-integration.md) — speech-to-text *(planned)*

### Terminal UI

The IRC-style multi-window interface.

- [Terminal UI](ui/index.md) — windows, channels, layout, input bar behavior
- [UI Commands Reference](ui/commands/index.md) — slash commands, custom command guide, context API

### Example Automations

Included examples demonstrating automation patterns.

- [Example Automations](examples/index.md) — overview and navigation
- [Ambient Lights](examples/ambient-lights.md) — daily lighting windows with per-rule target sets
- [TTS Weather Man](examples/weatherman.md) — i18n weather announcer through the AI → TTS pipeline

### Guides & Roadmap

- [Configuration Guide](configuration.md) — every config file, variable, and section explained
- [TODO & Roadmap](TODO.md) — planned features and known issues

---

Related: [README](../README.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [API reference (generated)](api/index.html)