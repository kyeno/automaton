# Host shutdown (trusted-LAN v2)

LANFLIX owns the Windows receiver. Automaton sends a fixed shutdown request and
waits for acceptance, not proof of power-off. automaton-chat's legacy listener
must remain disabled. Upgrade Automaton and LANFLIX together; v1 is not supported.

## Configuration

```yaml
host_commands:
  enabled: false
  topic_base: automaton/host
  targets:
    htpc:
      secret_env: HTPC_MQTT_SECRET
      ack_timeout: 3s
    htpc2:
      secret_env: HTPC2_MQTT_SECRET
      ack_timeout: 3s
```

Set each named environment variable privately on Automaton. LANFLIX reads the
matching `host_id`, `key`, `allow_shutdown` and `dry_run` from its private
`config.ini` `[host_shutdown]` section. Explicit opt-in is required; Linux does
not execute shutdown. Each host has its own target and key.

## Wire format

- Request: `<topic_base>/<target>/command`.
- ACK: `<topic_base>/<target>/ack`.
- Both: QoS 0, never retained; clean sessions and no offline action backlog.

Request:
```json
{"v":2,"id":"7b3b9845-bb6c-4717-a72b-b0ab991be180","target":"htpc","action":"shutdown","key":"<per-host key>"}
```

ACK:
```json
{"v":2,"id":"7b3b9845-bb6c-4717-a72b-b0ab991be180","target":"htpc","status":"accepted"}
```

ACK status is `accepted`, `failed` or `rejected`. Match version, request ID,
target and topic against the pending request; never use peer timestamps.
The receiver validates the key, host and fixed action, ignores retained frames,
and claims recent IDs before awaiting ACK publication. Its bounded duplicate
cache uses only local monotonic elapsed time. Disposal prevents pending work
from shutting down during application exit. The executable is always
`shutdown.exe /s /f /t 0`, without a shell or interpolated wire data.

The existing sequence step remains `{kind: host_command, target: htpc,
action: shutdown}`. Put it last in a theater-off sequence: it waits up to
`ack_timeout` (100ms–10s), and powering off the client can interrupt its control
reply. A timeout is an unknown outcome; requests are never automatically retried.

## Intentional limitations

This protocol assumes a trusted wired LAN. The key is present in MQTT payloads;
there is no HMAC, peer-clock requirement, protection against traffic capture, or
durable replay protection across receiver restarts. Keep keys out of logs and
commits and do not expose these topics to untrusted networks.
