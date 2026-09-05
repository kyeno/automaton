# Video Player Monitor

The **Video Player monitor** (`src/monitor/videoPlayerMonitor.js`) polls media players over their HTTP APIs and normalizes each into a small status vocabulary, so automations can react to "a movie is playing in the living room" without caring which player software is involved. The flagship consumer is the [Home Theater Mode](../automations/home-theater-mode.md) automation.

## Status Vocabulary

| Status | Meaning |
|--------|---------|
| `playing` | A video is actively playing |
| `paused` | Player open, playback paused |
| `stopped` | Player open, nothing playing |
| `unreachable` | Host online but the player stopped answering (3 consecutive failures) |
| `unknown` | Host known to be offline, or no status determined yet (reported as `null`) |

An `unknown` status matches **only** rule lists that explicitly include the `unknown` token — see [Rule Engine Restore & Ownership](../architecture/rule-engine-restore-semantics.md) for the semantics and typical patterns.

## How It Works

- All configured players are swept in parallel every 4 seconds; a re-entrancy guard prevents overlapping sweeps.
- Polling is **presence-gated**: a host that the [Network Presence monitor](./network-presence.md) knows to be offline is not polled at all — its status becomes `unknown`. Hosts absent from every ping category are polled directly.
- A 3-strike failure counter keeps a transiently failing host at its previous status instead of flapping it to `unreachable`.
- Status is cached in Redis (`videoPlayer:<host>:status`) and a `videoPlayer:<host>` EventBus event is published **only on change**.

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
    timeout_ms: 500            # optional per-player HTTP timeout
```

| Key | Required | Description |
|-----|----------|-------------|
| `host` | No | IP address or hostname of the player machine; defaults to the same-named `computers` entry (see [Network Presence](./network-presence.md)) |
| `port` | Yes | HTTP port of the player's web interface |
| `path` | Yes | Status endpoint path (must start with `/`) |
| `parser` | Yes | Response parser: `vlc` or `mpc` |
| `username` / `password` | No | Basic-auth credentials (VLC's HTTP interface) |
| `timeout_ms` | No | Per-player HTTP timeout; default 500 ms (LAN-local players answer in single-digit ms) |

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
      videoPlayer: { my-pc: [playing] }
    targets: ...
```

Full `videoPlayer` condition syntax (including the `unknown` token) is documented in the [Configuration Guide](../configuration.md).

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