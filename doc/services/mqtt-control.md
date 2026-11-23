# LAN command control (v2)

Enable `mqtt_control` in the main YAML and set the named `secret_env` variable.
Its `commands` map globally enables command families/subcommands. Everyone with
the shared key gets the same configured capabilities; no client registration.

- Request topic: `<topic_base>/command` (default `automaton/control/command`).
- Request: `{ "v": 2, "id": "<random UUID or 32 lowercase hex>", "key": "<shared key>", "command": "ir", "args": "send avr_on" }`.
- Reply topic: `<topic_base>/reply`.
- Reply: `{ "v": 2, "id": "<same ID>", "status": "ok", "lines": ["..."] }`.
  Other statuses: `failed`, `rejected`. Replies never echo the key.
- Invalid authentication/frames and duplicate/retained requests are silently ignored.
- `ir`, `sequence`, `occupancy` share headless execution and completion with the terminal.
  Adding a command requires a shared implementation and validator entry, not just YAML.

Use clean MQTT sessions and QoS 0 with no retention/offline queue. A lost reply is
an **unknown outcome**, not permission to retry a physical action. IR dispatch
does not confirm appliance state. Request IDs suppress recent duplicates in a
bounded, receiver-local monotonic cache; they are not durable replay protection.

Authentication is intentionally for a trusted wired LAN. Keys travel in payloads;
there is no HMAC, peer timestamp, clock synchronization or protection against a
traffic observer. Do not expose these topics to an untrusted network.