# Monitors

> **In this section:** [Network Presence](./network-presence.md) · [Video Player](./video-player.md)

Monitors are singletons that watch the world outside Zigbee — network hosts, HTTP APIs, and (in the future) anything else worth polling. Each one sweeps its targets on a short interval, normalizes what it sees into a small vocabulary, caches the result in Redis, and publishes an EventBus event **only when something actually changed**. Automations consume that state through rule conditions and re-evaluate immediately on transitions.

| Monitor | What it watches | Rule condition |
|---------|-----------------|----------------|
| [Network Presence](./network-presence.md) | Hosts answering `arping` on the LAN | `presence` |
| [Video Player](./video-player.md) | Media players answering HTTP (VLC, MPC-HC) | `videoPlayer` |

More monitors will be added over time. Both current ones live in `src/monitor/` and follow the same shape: a `checkNow()` sweep, a `get…()` reader for rules, and a `network:` / `videoPlayer:` EventBus topic per target.

---

→ [Documentation Home](../index.md)