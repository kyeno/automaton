# Network Presence Monitor

Checks LAN hosts and exposes `online` / `offline` presence to automation rules.

## How It Works

- Hosts are checked every 5 seconds with `arping`: one packet, 2-second timeout, one retry, up to four hosts in parallel.
- Results are cached in Redis for 60 seconds and mirrored in memory. `network:<name>` events publish only on transitions.
- `getPresence(name)` returns `online`, `offline`, or `null` for unknown/expired state.

## Configuration

Hosts are defined in `etc/device/network.yaml` (template: `network.yaml.dist`) as name → IP pairs grouped into categories:

```yaml
computers:
  my-pc: 192.168.1.10
  laptop: 192.168.1.11

routers:
  my-router: 192.168.1.1

ac:        # access points
appliances: # smart appliances
```

The category is only an organizational label — presence lookup is case-insensitive across all of them. The short name (`my-pc`) is the key used in automation rules.

> **Note:** `videoPlayers` entries in the same file are objects, not bare IP strings, so they are deliberately *not* ping targets — see the [Video Player monitor](./video-player.md).

## Using It in Automations

```yaml
triggers_network:        # Re-evaluate when these hosts change state
  - my-pc
  - laptop

rules:
  - name: 'Day: laptop present'
    conditions:
      presence: laptop      # host is online
    targets: ...
```

Full condition syntax is documented in the [Configuration Guide](../configuration.md). The `arping` binary needs raw-socket capability — see [Installation & Requirements](../installation/index.md) for the one-time `setcap` step.

## File Map

| Component | Path |
|-----------|------|
| Monitor singleton | `src/monitor/networkPresence.js` |
| Configuration template | `etc/device/network.yaml.dist` |

---

→ Back to [Monitors](./index.md) · Sibling: [Video Player](./video-player.md)