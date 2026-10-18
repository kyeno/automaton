# Frozen Sensor Monitor

Watches selected numeric device properties for a suspected freeze. It runs as a
monitor alongside the network and Zigbee offline monitors, independently of the
TTS Gardener's timer, scheduled reports, event cooldown and quiet hours.

## Configuration

Add exact Zigbee2MQTT friendly names under `alerts.frozen_sensors` in
`etc/automaton.yaml`. The shipped template has an empty device map so monitoring
is opt-in.

```yaml
alerts:
  frozen_sensors:
    enabled: true
    unchanged_for: "24h"
    reminder_interval: "15m"
    silence_between: null         # independent quiet hours; e.g. "2300-0700"
    speak: true
    use_ai: true
    tts_profile: ''
    devices:
      Flower Sensor One: { property: soil_moisture, unit: '%' }
      Flower Sensor Two: { property: soil_moisture, unit: '%' }
```

| Setting | Default | Purpose |
|---------|---------|---------|
| `enabled` | `true` | Enable monitoring of the configured devices |
| `devices` | `{}` | Device name → `{property, unit?}`; one numeric property per device |
| `unchanged_for` | `24h` | Time since the last observed reading change before marking a suspected freeze |
| `reminder_interval` | `15m` | Minimum time between grouped voice reminders |
| `silence_between` | `null` | Own local `HHmm-HHmm` quiet hours; null allows speech at any hour |
| `speak` | `true` | Enable voice reminders; detection, recovery and email continue when false |
| `use_ai` | `false` if absent; `true` in the template | Use AI → TTS with plain-TTS fallback |
| `tts_profile` / `tts_options` | none | Shared [TTS framing](../installation/tts-integration.md) |

Durations accept human-readable strings or positive milliseconds. Invalid or
non-positive values fall back to the defaults. Use `enabled: false` to disable
monitoring; disabling or removing a configured device clears its tracked baseline
and incident on the next sweep. Re-enabling starts a fresh observation period.
Configuration changes apply on the next sweep, without restarting the process.

## Detection and recovery

The first numeric reading records a baseline. Every observed change resets its
`changedAt` timestamp, including a change that later returns to the original value.
An independent one-minute sweep marks readable sensors frozen once `unchanged_for`
has elapsed. It groups all detections from that sweep into one initial email.
This does not depend on a daily gardener announcement slot.

A different numeric reading clears the incident immediately through the device's
`zigbee:<name>` event, including while an AI reminder is in flight. Recovery is
silent. A later full unchanged interval starts a new incident and can email again.
Missing devices, null/blank/boolean/non-numeric readings do not prove recovery;
existing incidents remain stored but unreadable sensors are omitted from speech.

This measures **observed change**, not proof of a hardware fault. Naturally stable
readings can trigger it. Changes while Automaton is stopped cannot be observed.
A backward clock jump resets a future-dated baseline on the next valid reading.

## Grouped notifications

- Initial detection: one email lists all newly frozen sensors, their properties and
  readings. It is built from the locale's plain sentence, independently of AI,
  speech availability and quiet hours.
- Reminders: one AI → TTS announcement lists all currently readable frozen sensors,
  at most once per `reminder_interval`. AI failure uses plain TTS. Reminders never
  send email. Overlapping sweeps share a single in-flight run.
- Failed/unavailable initial mail stays pending and retries on later sweeps, including
  after restart. Pending incidents are grouped into one retry. Accepted mail is not
  re-requested for that incident. Recovery cancels pending mail for that sensor.

Email uses `email.notify.sensor_frozen`, `email.cooldown_ms`, SMTP settings and
`house_owners`. The email channel's cooldown can delay a later group's delivery;
its initial notification remains pending. Acceptance means EmailService accepted
the request; see [Email](../services/email.md) for SMTP delivery behavior.

Quiet hours mute only the spoken leg. An overdue reminder resumes on the next
sweep after quiet hours or output availability returns; no suppressed speech
consumes the reminder timestamp. Set `silence_between` explicitly if overnight
warnings would be unwelcome.

## Persistence and runtime state

SQLite's `runtime_state` table stores the current readings, change/detection times,
pending email flags and last speech timestamp under `monitor:frozenSensors`.
This data is separate from transition history and its retention policy. It survives
process restarts without depending on Redis. A failed database write leaves the
state in memory and retries on later events/sweeps; changes never saved cannot be
restored after a crash or restart during a database outage.

`StateService.get('monitor:frozenSensors')` exposes a detached array of incidents:
`{name, property, unit, value, changedAt, detectedAt, emailPending}`. Stop releases
subscriptions and the timer, waits for in-flight work, and flushes state before
the database and notification services shut down.

## Migration from the gardener watchdog

Move watched sensor names into `alerts.frozen_sensors.devices` and use the gardener's
`moisture_property` as each entry's `property`. Move `stuck_check_interval` to
`unchanged_for`; choose `reminder_interval: "15m"` rather than the old 12-hour speech
cooldown. `speak`, `use_ai`, quiet hours and TTS framing now belong to this monitor.
Set `email.notify.sensor_frozen` to the former `email.notify.gardener_stuck` value.

Remove gardener `stuck_check_interval`, `stuck_warn_cooldown` and `stuck_speak`.
The gardener no longer performs watchdog work, so it cannot produce duplicate
alerts. Old Redis snapshots are not imported: equal daily endpoints do not establish
a continuously unchanged value. A fresh observation period begins at first startup.
Existing `gardener.stuck` and `gardener_stuck` language entries may remain for older
versions; the new monitor uses `frozen-sensors.yaml` and `email.sensor_frozen`.

## Files

| Component | Path |
|-----------|------|
| Monitor | `src/monitor/frozenSensorMonitor.js` |
| Configuration | `etc/automaton.yaml.dist` → `alerts.frozen_sensors` |
| Language bundles | `etc/i18n/{locale}/frozen-sensors.yaml.dist` |
| Durable state | `src/service/databaseService.js` |
| Pipeline | `src/lib/announcementPipeline.js` |
| Tests | `tests/test-frozen-sensor-monitor.js`, `tests/test-database-service.js` |
