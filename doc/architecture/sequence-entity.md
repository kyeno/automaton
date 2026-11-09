# Sequence Entity

A sequence sends commands to an ordered list of devices, with optional delays and loops.
Definitions live in `etc/sequence/sequences.yaml`; start from the
[template](../../etc/sequence/sequences.yaml.dist).

## Configuration

Use either `devices` for derived ON/OFF commands or `on` / `off` for explicit payloads:

```yaml
sequences:
  - name: 'Ambient Lights'
    delay: '500ms'
    devices:
      - 'Living Room Outlet'
      - device: 'Kitchen LED Strip'
        command: 'ON'
        delay: '800ms'

  - name: 'Hazard Light'
    loop:
      enabled: true
      cycle: continuous
      off_delay: '2s'
      on_delay: '2s'
    on:
      - device: 'Living Room Dimmer'
        payload: { state: 'ON', brightness: { l1: 1, l2: 25 } }
    off:
      - device: 'Living Room Dimmer'
        payload: { state: 'ON', brightness: { l1: 100, l2: 75 } }
```

| Key | Behavior |
|-----|----------|
| `name` | Required; unique slug derived from the friendly name |
| `force` | Always dispatch commands despite matching cached state; default `false` |
| `delay` | Delay between steps; omitted means no delay; accepts durations or milliseconds |
| `devices` | Ordered names or `{device, command?, delay?}` entries; `command` overrides ON only |
| `on` / `off` | Ordered `{device, payload?, delay?}` entries; payloads pass through verbatim |
| `loop.enabled` | Enable the loop API |
| `loop.cycle` | `once` or `continuous`; default `once` |
| `loop.off_delay` | Gap after ON and before OFF; `auto` starts immediately |
| `loop.on_delay` | Gap after OFF and before the next ON in continuous mode |

Exactly one of `devices` or `on` is required. Missing `off` sends OFF to the ON devices.
Invalid durations warn and use defaults. Missing devices warn and their steps are skipped.

## Execution

- One run or loop may be active per instance. Concurrent requests return `false` and warn.
- `run('ON'|'OFF')` completes the ordered step list. Delays apply between steps.
- `startLoop()` runs ON, waits the OFF gap, then runs OFF. Continuous mode repeats after the ON gap.
- `stopLoop()` cancels an inter-phase wait immediately. An active step list finishes before stopping.
- One-shot commands default to `DeviceCommandSource.AUTOMATION`; CLI and AI one-shot runs propagate HUMAN.
  Loop steps always use AUTOMATION provenance, with their initiator retained separately, so
  repeated steps do not renew the human-interaction cooldown. `force: true` bypasses
  cached-state suppression. IR events are always sent.
- IR payloads use `{ ir_command: command_id }` and await local MQTT dispatch before delays.
  Sequences containing IR require an explicit `off` list to support OFF.
- `getLastRunResult()` reports local completed steps and partial failures, without appliance confirmation.
- Human interaction does not abort an active sequence. Restarts stop all runs and loops.

## Public API

| Owner | Methods |
|-------|---------|
| `SequenceBase` | `init()`, `run(command)`, `startLoop()`, `stopLoop()`, `cleanup()` |
| Instance status | `getName()`, `getSlug()`, `isActive()`, `isLoopActive()`, `getStateSummary()` |
| Loop capability | `supportsLoop()` |
| `SequenceContainer` | `get(slug)`, `getAll()`, `getNames()`, `callCommand(name, command)` |
| Container loops | `startLoop(name)`, `stopLoop(name)`, `isLoopActive(name)` |
| Container lifecycle | `init()`, `isInitialized()`, `reloadSequences()`, `cleanupSequences()` |

Live StateService keys are `sequence.<slug>.active`, `.phase` (`on` / `off`),
and `.loop.active`. Keys clear at idle.

## CLI and Reload

```text
/sequence
/sequence run <name> [ON|OFF]
/sequence loop start <name>
/sequence loop stop <name>
```

Commands accept slugs or friendly names, case-insensitively. `/config reload` rebuilds
the registry and reports added/removed slugs. Active loops stop gracefully; unreadable
configuration keeps the current registry. Initialization failures warn without stopping startup.
`run` executes one phase even when a loop is configured; its output points to `loop start`
for repetition. Stopping a loop finishes an in-flight phase and cancels the next phase wait.

## File Map

| Component | Path |
|-----------|------|
| Run engine | `src/sequence/base/sequenceBase.js` |
| Registry | `src/sequence/container/sequenceContainer.js` |
| Schema | `src/validators/sequences.js` |
| CLI | `src/ui/commands/sequenceCmd.js` |
| Tests | `tests/test-sequences.js` |

AI can invoke a configured sequence through an AI-only virtual device in
`etc/device/virtual.yaml`. Its `ON` and `OFF` actions use the ordinary
`set_device_state` tool and return the local sequence result. Loop actions can
also be mapped explicitly. See [Configuration](../configuration.md#6a-ai-virtual-devices-etcdevicevirtualyaml).
See [IR transmitter](ir-transmitter.md).
Restart persistence and sequence names in automation `targets` remain deferred.
See [Configuration](../configuration.md#6-sequences-etcsequencesequencesyaml) for more examples.
