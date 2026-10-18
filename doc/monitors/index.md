# Monitors

> **In this section:** [Network Presence](./network-presence.md) · [Video Player](./video-player.md) · [Offline Alerts](./offline-alerts.md) · [Frozen Sensors](./frozen-sensors.md)

Monitors publish EventBus transitions for automation conditions. See the guides below for polling, status values, and configuration.

| Monitor | What it watches | Rule condition |
|---------|-----------------|----------------|
| [Network Presence](./network-presence.md) | Hosts answering `arping` on the LAN | `presence` |
| [Video Player](./video-player.md) | Media players answering HTTP (VLC, MPC-HC) | `video_player` |

The presence and player monitors live in `src/monitor/` and follow the same shape: a `checkNow()` sweep, a `get…()` reader for rules, and a `network:` / `videoPlayer:` EventBus topic per target.

Two more monitors watch for things going *away* and speak a warning instead of driving rules: [Offline Alerts](./offline-alerts.md) covers Zigbee devices leaving the mesh and mission-critical LAN hosts dropping offline.

[Frozen Sensor Monitor](./frozen-sensors.md) tracks unchanged numeric readings, persists incidents,
and sends grouped initial email plus recurring voice reminders independently of automations.

---

→ [Documentation Home](../index.md)