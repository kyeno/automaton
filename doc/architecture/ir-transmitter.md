# IR transmitter and named commands

`IRTransmitter` extends `Mechanism` and remains a Zigbee device: bridge discovery,
subscriptions, reconnects and incoming telemetry use the normal device lifecycle.
Outgoing IR is an event. It bypasses state suppression, target-state correlation,
pending-state markers and automatic retries. Repeating a volume command sends it again.

## Setup

Declare the exact Zigbee2MQTT friendly name under `mechanism` in
`etc/device/zigbee.yaml`:

```yaml
mechanism:
  - name: 'Living Room IR'
    type: IRTransmitter
    ir_send_property: ir_code_to_send
```

The subtype key is normalized by DeviceContainer to `irtransmitter`. The send field
is resolved from explicit `ir_send_property` or a bridge expose named
`ir_code_to_send`. Other protocols require an explicit field; no envelope is guessed.

Copy `etc/ir/commands.yaml.dist` to `etc/ir/commands.yaml`:

```yaml
commands:
  amp_on:
    transmitter: 'Living Room IR'
    code: 'AQIDBA==' # Replace with the actual remote code
  amp_vol_up:
    transmitter: 'Living Room IR'
    code: 'BQYHCA==' # Replace with the actual remote code
```

IDs use lowercase letters, digits and underscores, starting with a letter.
Codes are opaque standard Base64 strings, optionally unpadded. They are preserved
verbatim. An unavailable transmitter is reported at invocation, so the catalog
can load before the Zigbee device reconnects. A power-toggle code should be named
and described as a toggle, rather than presented as discrete ON/OFF.

The optional `paths.configs.ir` setting overrides the catalog path. `/config reload`
validates and rebuilds the catalog without rebuilding physical devices. Malformed
YAML, duplicate IDs, invalid codes or missing bindings keep the previous catalog.

## Localization

Copy `etc/i18n/<locale>/ir.yaml.dist` to `ir.yaml` and describe commands by ID:

```yaml
commands:
  amp_on:
    label: 'Turn on amplifier'
    description: 'Turn on the living room amplifier.'
```

Metadata falls back per field to English, then to the ID. There are no aliases or
natural-language rules in the operational catalog. Locale changes and translation
edits take effect through `/config reload`.

## UI and interactions

```text
/ir list
/ir search amplifier
/ir show amp_on
/ir send amp_on
```

`show` returns metadata and routing without dumping codes. Completion uses the live
catalog. The command awaits local MQTT dispatch and reports no appliance state.

An interaction target uses the same explicit envelope as a sequence step:

```yaml
interactions:
  - name: living_room_remote
    actions:
      - type: single
        targets:
          - device: 'Living Room IR'
            command: { ir_command: amp_vol_up }
```

Direct API calls use `IRCommandService.send(id, { source, caller })`. Raw adapter
calls use `IRTransmitter.transmit(code, context)`. `receiveCommand()` accepts only
`{ ir_command: id }`, and verifies that the command belongs to that transmitter.

## Sequences

```yaml
sequences:
  - name: 'Home Cinema'
    delay: '700ms'
    on:
      - device: 'Living Room IR'
        payload: { ir_command: tv_on }
      - device: 'Living Room IR'
        payload: { ir_command: amp_on }
      - device: 'HTPC Outlet'
        payload: { state: 'ON' }
    off:
      - device: 'HTPC Outlet'
        payload: { state: 'OFF' }
      - device: 'Living Room IR'
        payload: { ir_command: amp_off }
      - device: 'Living Room IR'
        payload: { ir_command: tv_off }
```

The shared delay applies between steps in both phases. IR steps are awaited until
local dispatch before the delay begins. Ordinary devices keep their existing
submission semantics. Existing per-step delay overrides remain supported.

A sequence containing an IR command requires an explicit `off` list to support OFF;
there is no automatic inverse. `run(command, context)` and
`SequenceContainer.callCommand(name, command, context)` propagate the initiating
source. Their boolean result reports acceptance; `getLastRunResult()` reports
completed step count and failures. Missing/failed steps are reported as
`partial_failure`; remaining steps continue, without rollback or retries.
CLI and chat one-shot runs are human-directed; programmatic runs default to automation.
Loop steps always use automation provenance, including loops initiated through CLI or chat.

## AI and dispatch semantics

Two static IR tools are added alongside existing device tools:

- `find_ir_commands({query})` and `send_ir_command({command_id})`

AI invokes sequences through configured virtual devices using `set_device_state`.

Discovery searches normalized IDs and current localized metadata, returns at most
five matches and indicates truncation. Codes never appear in discovery results,
tool definitions or the system prompt. No per-command tool or enum is generated.
The system prompt gains only fixed instructions for discovery followed by execution.
Unknown IDs return an error; the server never guesses what to transmit.

The existing native tool-call loop handles discovery and execution. MCP and
pre-inference candidate retrieval are not required and are not introduced here.
The same service APIs can later be wrapped by MCP.

`dispatched` means the message was handed to the local MQTT client, not that the
broker, transmitter or appliance acknowledged it. `target_state` remains `unknown`.
Awaitable event messages are non-retained; a message still queued after 15 seconds
is removed and rejected. Shutdown and local publish errors reject the waiting
caller. A successful IR transmission does not alter cached appliance state.

## File map

| Component | Path |
|---|---|
| Zigbee adapter | `src/device/type/irtransmitter.js` |
| Catalog and discovery | `src/ir/irCommandService.js` |
| Catalog validation | `src/validators/ir.js` |
| Slash command | `src/ui/commands/irCmd.js` |
| AI tool dispatch | `src/ai/toolBuilder.js` |
| Sequence execution | `src/sequence/base/sequenceBase.js` |
| Awaitable transport | `src/service/mqttService.js` |
| Behavioral coverage | `tests/test-ir.js`, `tests/test-mqtt-event-dispatch.js` |
