# Host commands (signed shutdown requests)

Automaton can ask a host machine to shut itself down. The chat client that already
runs on the HTPC answers on MQTT; Automaton only proves the request was delivered and
accepted. Restart Automaton after configuring this section.

Requests are signed with HMAC-SHA256 using a secret shared with that host. Nothing here
can shut a machine down unless the operator opted in on that machine, so an unattended
chat window, a rogue publisher on the LAN, or a stale Automaton state cannot power off
the HTPC.

## Topics

Requests go to `<topic_base>/<target>/command`, answers come back on
`<topic_base>/<target>/ack`. The default `topic_base` is `automaton/host`:

| Direction | Topic | QoS | Retained |
|---|---|---|---|
| Automaton -> host | `automaton/host/htpc/command` | 1 | false |
| Host -> Automaton | `automaton/host/htpc/ack` | 1 | false |

`topic_base` must not contain wildcards, must not live under `zigbee2mqtt`, and must not
be `automaton/ai` (reserved for chat input). The validator refuses all of these.

## Command payload

~~~json
{
  "v": 1,
  "id": "7b3b9845-bb6c-4717-a72b-b0ab991be180",
  "target": "htpc",
  "action": "shutdown",
  "iat_ms": 1793059500000,
  "exp_ms": 1793059515000,
  "sig": "13f4a562f7244d8a3928775595061324e2c4806631b6cdd1b146416f5c3ca057"
}
~~~

`id` is a fresh UUID per request. `iat_ms`/`exp_ms` are epoch milliseconds; a command is
valid for 15 seconds (`COMMAND_VALIDITY_MS`). `action` is `shutdown` -- the only action in
v1. Extra fields are not sent.

## ACK payload

~~~json
{
  "v": 1,
  "id": "7b3b9845-bb6c-4717-a72b-b0ab991be180",
  "target": "htpc",
  "status": "accepted",
  "ts_ms": 1793059500250,
  "sig": "d3a444c0b3a4c7097362a2c472f143cd97fc841994c16b03fa6b88bfe62d9d98"
}
~~~

`status` is `accepted`, `failed` or `rejected`. The host signs its own `ts_ms`.

## Canonical signing

Signatures are HMAC-SHA256, lowercase hex, over UTF-8 canonical strings built from
newline-delimited fields -- no JSON, no spaces, decimal integers as text:

~~~text
command: v1 \n id \n target \n action \n iat_ms \n exp_ms
ack:     v1 \n ack  \n id \n target \n status \n ts_ms
~~~

Wire test vector (secret `htpc-v1-test-secret-0123456789abcdef`):

- Command canonical: `v1\n7b3b9845-bb6c-4717-a72b-b0ab991be180\nhtpc\nshutdown\n1793059500000\n1793059515000`
- Command signature: `13f4a562f7244d8a3928775595061324e2c4806631b6cdd1b146416f5c3ca057`
- ACK canonical: `v1\nack\n7b3b9845-bb6c-4717-a72b-b0ab991be180\nhtpc\naccepted\n1793059500250`
- ACK signature: `d3a444c0b3a4c7097362a2c472f143cd97fc841994c16b03fa6b88bfe62d9d98`

`tests/test-host-command-service.js` asserts this vector, so the Node side and the Dart
side can never drift apart silently. Both sides must reproduce these bytes exactly.

## What an ACK means

An ACK proves the request reached an authorized listener and was accepted. It never
proves the machine is off: Windows answers before the shutdown runs. Automaton reports
`accepted` and stops -- it does not poll for power state, and network presence stays
online for a few seconds after a successful shutdown.

`requestShutdown()` resolves with one of:

- `accepted` -- a matching signed ACK arrived.
- `failed` -- the request never reached the broker, or the target is unknown, disabled,
  has no secret, has no ACK subscription (host commands initialized while MQTT was
  disconnected), or the action is unsupported.
- `timeout` -- no matching signed ACK within `ack_timeout`. Never retried.

Nothing is ever retried automatically. A duplicate ACK for an ID that is already
resolved is ignored, and IDs stay in the replay guard for 60 seconds past their validity.

## Secrets

Secrets are never stored in config. Each target names an environment variable
(`secret_env`) that holds the shared key; Automaton reads it at init and reload. An
unset variable disables that target and logs a warning -- it never blocks startup.

- Keep the value out of world-readable files; systemd unit drop-ins readable by root are
  the usual place.
- One secret per host. Rotating a secret means changing the variable and reloading
  config on both machines.

## Configuration

The section is opt-in and defaults to disabled in `etc/automaton.yaml.dist`:

~~~yaml
host_commands:
  enabled: false
  topic_base: 'automaton/host'
  targets:
    htpc:
      secret_env: 'HTPC_MQTT_SECRET'
      ack_timeout: '3s'
~~~

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch; when false nothing is subscribed and every request fails |
| `topic_base` | `automaton/host` | Topic tree root for command and ACK topics |
| `targets` | -- | Allowlist of target slugs; only these can be addressed |
| `targets.<id>.secret_env` | -- | Environment variable holding the shared secret |
| `targets.<id>.ack_timeout` | `3s` | Wait for a matching signed ACK (100ms - 10s) |

Target ids are lowercase slugs (`[a-z][a-z0-9_]{0,31}`) and become topic levels verbatim.
Secret env names must look like env vars (`[A-Z][A-Z0-9_]{2,}`). Keys other than
`secret_env` and `ack_timeout` are rejected -- a config key must never be able to carry a
command, an executable path or a payload.

**Where the secret lives.** Only in the process environment. `bin/automaton` exports every
key of the project `.env`, and the documented systemd user service reads
`EnvironmentFile=%h/.env` -- use the file matching how Automaton is actually started, and
keep it out of world-readable files. Generate one with `openssl rand -hex 32`; it must be
byte-identical to the value on the target host (`setx HTPC_MQTT_SECRET "<same>"` on
Windows). An unset variable leaves that target inert: a startup warning naming the
variable, and every request `failed`. The value never appears in config, in a command
line, in a log, or in `/config reload` output.

`/config reload` rebuilds the target registry and the ACK subscription and reports
`N target(s), M ready` -- a target counts as ready only when its `secret_env` resolves,
which is the check to run before scheduling a shutdown. In-flight requests are released
as `failed` rather than left waiting.

## Sequence usage

Host steps are rich steps and require the `on:`/`off:` form:

~~~yaml
Home Cinema OFF:
  on:
    - device: 'Salon Pilot IR'
      payload: { ir_command: avr_on }
  off:
    - device: 'Salon Pilot IR'
      payload: { ir_command: avr_off }
    - device: 'Salon Pilot IR'
      payload: { ir_command: tv_onoff }
    - kind: 'host_command'
      target: 'htpc'
      action: 'shutdown'
~~~

Rules:

- **Put host steps LAST in a phase.** The step blocks up to `ack_timeout` (3s by default)
  waiting for the ACK, and steps run in order: a host step in the middle makes the device
  steps behind it wait on a machine that may already be powering off. Steps are never
  aborted mid-run, so a hung host delays everything after it.
- A host step has no device and no payload; `device:`/`payload:` keys on it are rejected
  by the sequences validator.
- A host step has no inverse, so the simple `devices:` form rejects host steps outright
  instead of inventing an OFF payload.
- When `off:` is omitted, derived OFF runs the device steps only; a host-only sequence
  advertises no OFF phase at all.
- Host steps are paced by their own `delay`, then the sequence-level `delay`, exactly
  like device steps.
- A host step is reported under the label `host:<target>`. A failed host step makes the
  run `partial_failure`; device steps around it still run.
- A bad `kind`, an unsupported `action`, a missing `target` and unknown step keys fail
  config validation, so a typo in a shutdown path is loud. `SequenceContainer.init()`
  keeps warn-and-skip as the second layer.
- There is no IR fallback when a host step fails or times out, by design: a lost ACK after
  the host began shutting down must not turn into an IR power-button press. Keep the
  manual IR path available as a separate command (`etc/ir/commands.yaml`) instead.

## Limitations

- v1 has one action: `shutdown`. No reboot, no sleep, no power-on.
- Automaton cannot verify that a machine is off. Use NetworkPresence for that, and expect
  it to lag the ACK by seconds.
- The host must be running the chat client with the opt-in shutdown flag; Automaton
  cannot start, wake or launch anything.
- Requests are not queued for later delivery: if the broker is down, the request fails.
- Commands are valid for 15 seconds; a host that was asleep when the request was
  published must not act on it after waking, and the signature expiry makes that
  detectable.
- Clock skew tolerance is 2 seconds. A host with a badly set clock simply never gets
  acknowledged, and `timeout` is indistinguishable from a dead host. Sync before
  scheduling: `w32tm /resync` on the Windows host, NTP on the broker machine, then
  re-measure from an ACK (`ts_ms - iat_ms`). A real HTPC run measured 641 ms of skew
  against a 15 s validity window, leaving roughly 12.4 s of usable window host-side.
- The feature is off by default and stays off until both sides are configured.

## Files

- `src/host/hostProtocol.js` -- wire constants and canonical signing (dependency-free,
  mirrored by the Dart implementation).
- `src/host/hostCommandService.js` -- target registry, publishing, ACK correlation,
  replay guard.
- `src/sequence/base/sequenceBase.js` -- `host_command` steps.
- `src/validators/main.js` -- `host_commands` schema and semantic checks.
- `src/validators/sequences.js` -- per-step schema and semantics for host steps.
- `tests/test-host-command-service.js`, `tests/test-host-command-config.js`.

