# Automations

> **In this section:** [Ambient Lights](./ambient-lights.md) · [TTS Weather Man](./weatherman.md) · [TTS Greeter](./greeter.md) · [TTS Gardener](./gardener.md) · [TTS Twilight](./twilight.md) · [Home Office Rollers](./home-office-rollers.md) · [Bedroom Rollers](./bedroom-rollers.md) · [Home Theater Mode](./home-theater-mode.md)

Automaton is at heart a **rule-engine framework**: it evaluates YAML-defined conditions (time-of-day, seasons, sensor thresholds, network presence, video-player status) against live context and dispatches commands to your devices. The automations shipped in `etc/automation/` are **examples** — real, working deployments that each demonstrate a pattern you can adapt. Whatever your home needs, you can express it as your own YAML rules; see the [Configuration Guide](../configuration.md) for the full condition and target syntax.

## Ambient Lights

Manages ambient lighting across two daily windows: turns off leftover lights in the morning once natural light becomes sufficient, and switches on socket-powered lamps from `predusk` — civil dusk 30 minutes ahead. Demonstrates asymmetric per-rule target sets and daily `once:` markers that let humans keep full control after each rule fires.

→ [Full documentation](./ambient-lights.md)

## TTS Weather Man

A rule-based weather announcer that builds a speech message from locale-specific i18n sentence templates plus condition-matched additions, interpolates live sensor values into the text (`{{ DeviceName.property }}` syntax), and routes it through the AI → TTS pipeline. Demonstrates dynamic sensor contexts, priority rules, and per-locale language bundles.

→ [Full documentation](./weatherman.md)

## TTS Greeter

Greets people when their computers come back online — but only in proportion to how long they were actually gone. Absence duration comes from the transition history, and YAML-defined greeting windows map it to message buckets (reboot joke / "did you forget something?" / proper welcome), appending a localized absence note (how long ago the host was last seen online below 24h, its full calendar date and clock time beyond) whenever the history provides one. Explicit AI-vs-TTS switch per deployment. Demonstrates data-driven condition windows, dual-case name interpolation (`{% name_vocative %}` / `{% name_genitive %}`), calendar-date rendering through lib/date, and warn-only AI fallback without double-speak.

→ [Full documentation](./greeter.md)

## TTS Gardener

Watches soil-moisture flower probes and reports plant hydration by voice. Each plant is banded against YAML thresholds, the announcement follows the **worst** plant, and the reactive gate speaks only when a plant has worsened past the band it was last announced in — so periodic battery blips never re-announce, while recovery lowers the baseline silently and the next drop below a band speaks again. Reads the real zigbee2mqtt `soil_moisture` state property, and a daily watchdog names any probe whose reading did not move at all since the previous snapshot -- a capacitive probe frozen on one value is stuck, not stable soil. Demonstrates per-plant severity tracking, daily announce slots, a Redis-backed sensor-health snapshot, and the friendly-name wiring a sensor-driven automation depends on.

→ [Full documentation](./gardener.md)

## TTS Twilight

Announces civil dawn and civil dusk by voice, on the exact local minute each event happens. A minute-anchored timer computes both civil-twilight instants from the locale's coordinates, a freshness window decides what is still announceable, and YAML `hour:` gates bound to the `sundawn` / `sundusk` shorthands keep the two rules mutually exclusive across the day. Each rule carries its own TTS profile, so dawn and dusk are recognizable by their jingle; the hour is interpolated from the event instant, with the localized day-period word (`rano`, `wieczorem`) on both output paths and the hour spelled in declined words by code (`szósta osiemnaście`) wherever the locale's language can generate it. `once:` reuses the rule engine's daily Redis marker, and manual runs preview the upcoming event without consuming it. Demonstrates speech-only rules (no `targets:`), sun-shorthand clock gates, per-rule TTS framing, and day-period word interpolation.

→ [Full documentation](./twilight.md)

## Home Office Rollers

A rule-based roller-shutter controller for a home office. It evaluates outdoor illuminance and temperature against time-of-day and network-presence rules, then merges every matching result per target using **"most-closed-wins"** logic — so overlapping rules always resolve to the most closed position. Demonstrates presence-driven partial positions and multi-sensor condition sets.

→ [Full documentation](./home-office-rollers.md)

## Bedroom Rollers

A minimal night-close roller automation plus its companion **pilot remote interaction**: a 3-button remote that moves bedroom shutters via YAML targets while delegating outlet on/off decisions to a custom JS handler that reads outdoor light first. Demonstrates the `calls:` delegation pattern pairing a YAML entry with a custom JavaScript handler.

→ [Full documentation](./bedroom-rollers.md)

## Home Theater Mode

Stages a room for watching: rollers are owned and closed while the room's video player answers HTTP (any state) and handed back when it disappears; playback drives the lights — dark mode while playing, state-aware ambient restore on pause. Demonstrates the `video_player` condition with the explicit `unknown` token, `force_restore`, and restore/ownership semantics.

→ [Full documentation](./home-theater-mode.md)

---

More automations will be added here as they become available. If you'd like to contribute one, see [CONTRIBUTING.md](../../CONTRIBUTING.md).