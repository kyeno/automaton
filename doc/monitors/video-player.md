# Video Player Monitor

Polls VLC and MPC-HC HTTP APIs and publishes normalized player status for [Home Theater Mode](../automations/home-theater-mode.md) and other automations.

## Status Vocabulary

| Status | Meaning |
|--------|---------|
| `playing` | A video is actively playing |
| `paused` | Player open, playback paused |
| `stopped` | Player open, nothing playing |
| `offline` | No usable player signal — host known to be offline, host not yet polled, or the player stopped answering (3 consecutive failures) |

Rules match `offline` only when listed. Changes between raw offline causes are debug-log-only and do not emit status events.

## How It Works

- All configured players are swept in parallel every 4 seconds; a re-entrancy guard prevents overlapping sweeps.
- Polling is **presence-gated**: a host that the [Network Presence monitor](./network-presence.md) knows to be offline is not polled at all — its status becomes `offline`. Hosts absent from every ping category are polled directly.
- A 3-strike failure counter keeps a transiently failing host at its previous status instead of flapping it to `offline`.
- A **playback-settle** dwell window gates what counts as actively `playing`, so browsing/skipping titles does not trigger dark mode or suppression (see [Playback Settle](#playback-settle)).
- Every genuine status change is recorded in the local SQLite state history (`DatabaseService`, domain `videoPlayer`) and a `videoPlayer:<host>` EventBus event is published **only on change** — a raw-detail change inside the `offline` status (unreachable player vs. host offline) is debug-log-only and produces neither.

## Playback Settle

Effective `playing` requires the same title to play continuously for 60 seconds by default. Until settled, status is `stopped`. Once settled, pause/resume of the same title is immediate.

Both `video_player` conditions and `video_player_suppression` use this effective status.

Use [`state_transition`](../configuration.md#transition-origin-gate-state_transition) with `from: playing` on restore rules. This excludes `offline → stopped` startup reports. The separate offline delegation rule stays ungated.

Reset semantics:

| Event | Effect on the dwell clock / session |
|-------|-------------------------------------|
| Same title keeps playing | Clock continues; flips to `playing` when the window elapses |
| Different/new title starts | Clock restarts from zero, `settled` cleared |
| Pause before settling | Session reset — must play continuously again |
| Pause after settling | Stays settled; resuming the same title is instantly `playing` |
| Stop / offline (unreachable player or host down) | Session cleared entirely |

The per-host watch-session state is held in StateService under these keys (visible via `/status`):

- `videoPlayer.<host>.title` — current media title being played (`null` if the provider can't determine one)
- `videoPlayer.<host>.sinceMs` — epoch-ms timestamp of when that title began continuous playback
- `videoPlayer.<host>.settled` — whether the settle window has elapsed for the current title

MPC-HC reads the file/title fields; VLC uses available media-name fields. Without a title, the settle timer still works but cannot detect title changes.

## Configuration

Players are defined under `videoPlayers` in `etc/device/network.yaml` (template: `network.yaml.dist`). Each entry is an object — **not** a bare IP string — so the presence monitor does not treat it as a ping target:

```yaml
videoPlayers:
  my-pc:                  # IP resolved from computers: my-pc
    port: 13579
    path: /variables.html
    parser: mpc
  laptop:                 # explicit host override (failsafe)
    host: 192.168.1.11
    port: 8080
    path: /requests/status.json
    parser: vlc
    username: ''                # optional basic-auth (VLC)
    password: 'your-vlc-password'
    timeout: "1200ms"            # optional per-player HTTP timeout
```

| Key | Required | Description |
|-----|----------|-------------|
| `host` | No | IP address or hostname of the player machine; defaults to the same-named `computers` entry (see [Network Presence](./network-presence.md)) |
| `port` | Yes | HTTP port of the player's web interface |
| `path` | Yes | Status endpoint path (must start with `/`) |
| `parser` | Yes | Response parser: `vlc` or `mpc` |
| `username` / `password` | No | Basic-auth credentials (VLC's HTTP interface) |
| `timeout` | No | Per-player HTTP timeout; default 500 ms (LAN-local players answer in single-digit ms) |

| `parser` | Player | Endpoint |
|----------|--------|----------|
| `vlc` | VLC HTTP interface | `/requests/status.json` (JSON) |
| `mpc` | MPC-HC web interface | `/variables.html` (HTML) |

## Player-Side Setup

**MPC-HC** — enable the web interface via *View → Options → Player → Web Interface*: turn on **"Listen on port"** and turn off **"Allow access from localhost only"**. The compression setting does not matter (responses are decompressed transparently). Parsing is verified against MPC-HC **1.9.16.63** and expected to hold for the 1.9.x series; other versions warn once and keep parsing.

**VLC** — set a password under *Tools → Preferences (All) → Interface → Main interfaces → Lua → Lua HTTP Password*, then configure `username` / `password` on the player entry (sent as basic auth).

## Using It in Automations

```yaml
triggers_video:          # Re-evaluate when these players change status
  - my-pc
  - laptop

rules:
  - name: 'Living room: playing - dark mode'
    conditions:
      video_player: { my-pc: [playing] }
    targets: ...
```

Full `video_player` condition syntax (including the enumerated `offline` status) and the related top-level `video_player_suppression` stand-down guard are documented in the [Configuration Guide](../configuration.md).

## File Map

| Component | Path |
|-----------|------|
| Monitor singleton | `src/monitor/videoPlayerMonitor.js` |
| Shared HTTP helper | `src/monitor/providers/http.js` |
| VLC provider | `src/monitor/providers/vlc.js` |
| MPC provider | `src/monitor/providers/mpc.js` |
| Configuration template | `etc/device/network.yaml.dist` |

---

→ Back to [Monitors](./index.md) · Sibling: [Network Presence](./network-presence.md)