# Example Automations

> **In this section:** [Ambient Lights](./ambient-lights.md) · [TTS Weather Man](./weatherman.md)

This collection documents the example automations shipped with Automaton. Each one demonstrates a different pattern you can adapt for your own home setup. More examples will be added over time.

## Ambient Lights

Manages ambient lighting across two daily windows: turns off leftover lights in the morning once natural light becomes sufficient, and switches on socket-powered lamps at dusk. Demonstrates asymmetric per-rule target sets — each rule can command a different subset of the shared device list — and daily `once:` markers that let humans keep full control after each rule fires.

→ [Full documentation](./ambient-lights.md)

## TTS Weather Man

A rule-based weather announcer that builds a speech message from locale-specific i18n sentence templates plus condition-matched additions, interpolates live sensor values into the text (`{{ DeviceName.property }}` syntax), and routes it through the AI → TTS pipeline. Demonstrates dynamic sensor contexts, priority rules, and per-locale language bundles.

→ [Full documentation](./weatherman.md)

---

More example automations will be added here as they become available. If you'd like to contribute an example, see [CONTRIBUTING.md](../../CONTRIBUTING.md).