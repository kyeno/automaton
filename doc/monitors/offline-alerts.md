# Offline Alerts (Spoken)

Two monitors turn "something disappeared" into a spoken sentence, so you hear about it without looking at a screen:

| Monitor | Watches | EventBus topic | Sentence key (`alerts.yaml`) |
|---------|---------|----------------|------------------------------|
| `ZigbeeDeviceOfflineMonitor` | Zigbee devices leaving the mesh (`device_leave`) | `devices:removed` | `zigbee_device_offline` |
| `NetworkDeviceOfflineMonitor` | Mission-critical LAN hosts going offline | `network:<host name>` | `network_device_offline` / `network_device_online` |

DeviceContainer detects Zigbee removals; NetworkPresence detects LAN transitions. `AlertMonitorBase` handles speech switches, ignore lists, cooldowns, templates, and framing.

## Configuration (`alerts:` in `etc/automaton.yaml`)

Every value is read **per event**, so `/config reload` applies changes without a restart. Keys are namespaced by the family a monitor declares:

| Key | Zigbee family | Network family | Default |
|-----|---------------|----------------|---------|
| Master switch | `alerts.zigbee_offline_tts` | `alerts.network_offline_tts` | `true` (only an explicit `false` silences) |
| Re-warning window | `alerts.zigbee_offline_cooldown_ms` | `alerts.network_offline_cooldown_ms` | `"30m"` |
| Never announce | `alerts.zigbee_offline_ignore` | `alerts.network_offline_ignore` | `[]` |
| Framing profile | `alerts.zigbee_offline_tts_profile` | `alerts.network_offline_tts_profile` | `''` (no jingle) |
| Explicit framing | `alerts.zigbee_offline_tts_options` | `alerts.network_offline_tts_options` | unset |
| Announce list | — | `alerts.network_offline_devices` | — (allow-list; empty = silent) |
| Boot sweep | — | `alerts.network_offline_announce_boot` | `true` |
| Recovery speech | — | `alerts.network_offline_announce_recovery` | `false` |

```yaml
alerts:
  zigbee_offline_tts: true
  zigbee_offline_cooldown_ms: "30m"     # "90s"/"15m"/plain ms; 0 = warn on every event
  zigbee_offline_ignore: []
  zigbee_offline_tts_profile: ''

  network_offline_tts: true
  network_offline_cooldown_ms: "30m"
  network_offline_announce_boot: true
  network_offline_announce_recovery: false
  network_offline_devices:              # names from etc/device/network.yaml -- IPs live there
    core-server:                        # null = family defaults
    dns-server:                         # null = family defaults
    wifi-router:
      cooldown_ms: "5m"                 # per-host override
      tts_profile: 'alarm'              # per-host framing
      tts_options: { intro: 'router.wav' }
```

Only listed `network_offline_devices` are announced. Names absent from `network.yaml` warn at startup.

**Per-host overrides** (`cooldown_ms`, `tts_profile`, `tts_options`) win over the family keys for that host; a `null` entry means plain defaults.

## Sentences (`etc/i18n/<locale>/alerts.yaml`)

A key is either a plain sentence with a `{device}` placeholder, or a per-device map with a `default` entry (device names match case-insensitively):

```yaml
zigbee_device_offline: "Attention, device {device} has left the Zigbee network."

network_device_offline:
  default: "Attention, {device} is offline."
  core-server: "Attention, the core server is offline."
```

Resolution order: bundle key (per-device entry → `default`) → the monitor's built-in English fallback → the bare device name. Nothing ever speaks a raw `{device}` placeholder.

## Framing

`..._tts_profile` selects a locale profile; `..._tts_options` overrides its fields. Empty settings add no framing. See [TTS Integration](../installation/tts-integration.md).

## Behaviour Worth Knowing

- **Cooldown is consumed only by a spoken warning.** An attempt blocked by unavailable TTS, the ignore list, or the master switch leaves the device announceable the moment speech recovers.
- **Cooldown slots are per transition direction** for network hosts, so a flapping host cannot let a recovery line swallow the next offline warning.
- **Boot sweep:** a host that was already down before Automaton started never emits a transition event, so the startup sweep announces hosts NetworkPresence has already found down (15 s after boot, once the first sweep has run). The per-host cooldown applies, so a boot announcement and a later transition never double-speak.
- **Recovery speech is opt-in** (`network_offline_announce_recovery: true`); offline warnings are the default behaviour.
- **Renamed key family:** the Zigbee monitor used to read `alerts.device_offline_*` and the `device_offline` sentence key. Both keep working as fallbacks, with a one-time deprecation warning naming the new family -- rename them at your convenience.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Nothing is spoken | `alerts.<family>_tts` is not `false`, TTS is enabled (`TTS_API_URL` / `TTS_TCP_ENDPOINT`), and the device is not in `..._ignore` |
| Host never announced | Its name is under `alerts.network_offline_devices` **and** in `etc/device/network.yaml` (startup warning names the offenders) |
| Same host announced repeatedly | `..._cooldown_ms` of that host (per-host override beats the family value) |
| Sentence is the bare device name | The locale's `alerts.yaml` lacks the key and its `default` entry |
| No jingle on alerts | `..._tts_profile` names a `profiles:` entry of the **active locale's** `tts.yaml`, and the wave file exists on the TTS server |

---

→ Back to [Monitors](./index.md) · Related: [Network Presence](./network-presence.md) · [TTS Integration](../installation/tts-integration.md)

