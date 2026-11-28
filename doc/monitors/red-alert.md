# Scenarios: Red Alert

A **sequence** runs a list of device commands. An **automation** evaluates rules and applies the actions that match. A **scenario** coordinates a temporary mode: it starts on a trigger or command, runs several actions together, and cleans up when it ends. Red Alert is the first built-in scenario; YAML configures it rather than defining new scenario types.

## What Red Alert does

- A watched host going **online → offline** starts the lighting loop and repeats a local MP3 alarm. The first reading after startup only sets the baseline.
- An optional prerecorded warning starts after `warning_initial_delay` (default `2s`). `warning_repeat_delay` (default `20s`) is the gap **after each clip ends**. No AI or remote TTS is needed.
- When the last affected host comes back, Red Alert stops the alarm and the lighting loop and asks the configured automation to reevaluate lighting once. It does not change movie playback. An optional recovery clip plays once after cleanup, never on manual stop.

## Set it up

1. In `etc/automaton.yaml`, enable the example under `scenarios.red_alert`. Match the keys under `triggers.network_offline` to hosts in `etc/device/network.yaml`.
2. Point `light_sequence` at a continuous, device-only loop in `etc/sequence/sequences.yaml`. Use only lights that are safe to dim or switch off, never egress lighting. Set `restore_automation` to the automation that normally manages those lights; any alert lights it doesn't set are left off.
3. Put `audio.alarm_file` in `sounds.directory`. For `pl_PL`, a `warning: wifi-router-offline` uses `red-alert.pl_PL.wifi-router-offline.wav`; a `recovery_warning: wifi-router-online` uses `red-alert.pl_PL.wifi-router-online.wav`. If the warning is missing, Red Alert tries `red-alert.pl_PL.infrastructure-offline.wav`. Missing optional clips are skipped. See [Local Sounds](../installation/local-sounds.md) for playback setup.

Reload or restart while idle. Before an outage drill, let Automaton see the host online. The broker must still be reachable when Red Alert starts.

## Manual controls

```text
/scenario status red_alert
/scenario start red_alert [warning-id]
/scenario stop red_alert
```

After a manual stop, a host that is still down must come back online before it can trigger another alert. MQTT control is opt-in through the command allowlist.