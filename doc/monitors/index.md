# Monitors

> **In this section:** [Network Presence](./network-presence.md) · [Video Player](./video-player.md) · [Offline Alerts](./offline-alerts.md)

Monitors publish EventBus transitions for automation conditions. See the guides below for polling, status values, and configuration.

| Monitor | What it watches | Rule condition |
|---------|-----------------|----------------|
| [Network Presence](./network-presence.md) | Hosts answering `arping` on the LAN | `presence` |
| [Video Player](./video-player.md) | Media players answering HTTP (VLC, MPC-HC) | `video_player` |

More monitors will be added over time. Both current ones live in `src/monitor/` and follow the same shape: a `checkNow()` sweep, a `get…()` reader for rules, and a `network:` / `videoPlayer:` EventBus topic per target.

Two more monitors watch for things going *away* and speak a warning instead of driving rules: [Offline Alerts](./offline-alerts.md) covers Zigbee devices leaving the mesh and mission-critical LAN hosts dropping offline.

---

→ [Documentation Home](../index.md)