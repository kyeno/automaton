# Network Presence Monitor

The **Network Presence monitor** (`src/monitor/networkPresence.js`) watches hosts on the local network and answers one question per host: *is it online right now?* Automations use the answer as a `presence` condition — e.g. "someone's laptop is home, so park the office shutters".

## How It Works

- Every 5 seconds each configured host is checked with `arping` (one packet, 3 s wait per attempt, retried once — a single answer can be suppressed by ARP cache). Arping is used instead of plain ping because many devices silently drop ICMP but still answer ARP.
- The result is cached in Redis with a 60-second TTL and mirrored in memory; a `network:<name>` EventBus event is published **only on transitions** (online ↔ offline), never on every sweep.
- `getPresence(name)` returns `online`, `offline`, or `null` when nothing is known yet (cold start, expired cache, unknown host). It never guesses — rules decide what "unknown" means via the [`presence` condition](../configuration.md).

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
      presence: my-laptop   # host is online
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