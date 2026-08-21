# Example Automations

> **In this section:** [Ambient Lights](./ambient-lights.md) · [TTS Weather Man](./weatherman.md) · [Home Office Rollers](./home-office-rollers.md) · [Bedroom Rollers](./bedroom-rollers.md)

This collection documents the example automations shipped with Automaton. Each one demonstrates a different pattern you can adapt for your own home setup. More examples will be added over time.

## Ambient Lights

Manages ambient lighting across two daily windows: turns off leftover lights in the morning once natural light becomes sufficient, and switches on socket-powered lamps at dusk. Demonstrates asymmetric per-rule target sets — each rule can command a different subset of the shared device list — and daily `once:` markers that let humans keep full control after each rule fires.

→ [Full documentation](./ambient-lights.md)

## TTS Weather Man

A rule-based weather announcer that builds a speech message from locale-specific i18n sentence templates plus condition-matched additions, interpolates live sensor values into the text (`{{ DeviceName.property }}` syntax), and routes it through the AI → TTS pipeline. Demonstrates dynamic sensor contexts, priority rules, and per-locale language bundles.

→ [Full documentation](./weatherman.md)

## Home Office Rollers

A rule-based roller-shutter controller for a home office (or any room with blinds). It evaluates outdoor illuminance and temperature against time-of-day and network-presence rules, then merges every matching result per target using **"most-closed-wins"** logic — so overlapping rules always resolve to the most closed position. Demonstrates presence-driven partial positions and multi-sensor condition sets.

→ [Full documentation](./home-office-rollers.md)

## Bedroom Rollers

A minimal night-close roller automation plus its companion **pilot remote interaction**: a 3-button remote that moves bedroom shutters via YAML targets while delegating outlet on/off decisions to a custom JS handler that reads outdoor light first. Demonstrates the `calls:` delegation pattern pairing a YAML entry with a custom JavaScript handler.

→ [Full documentation](./bedroom-rollers.md)

---

More example automations will be added here as they become available. If you'd like to contribute an example, see [CONTRIBUTING.md](../../CONTRIBUTING.md).