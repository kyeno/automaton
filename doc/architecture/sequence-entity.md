# Sequence Entity

A sequence sends commands to an ordered list of devices, with optional delays and loops.
Definitions live in `etc/sequence/sequences.yaml`; start from the
[template](../../etc/sequence/sequences.yaml.dist).

## Configuration

Use either `devices` for derived ON/OFF commands or `on` / `off` for explicit payloads:

```yaml
sequences:
  - name: 'Ambient Lights'
    delay_ms: '500ms'
    devices:
      - 'Living Room Outlet'
      - device: 'Kitchen LED Strip'
        command: 'ON'
        delay_ms: '800ms'

  - name: 'Hazard Light'
    loop:
      enabled: true
      cycle: continuous
      off_delay_ms: '2s'
      on_delay_ms: '2s'
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
| `delay_ms` | Delay between steps; omitted means no delay; accepts durations or milliseconds |
| `devices` | Ordered names or `{device, command?, delay_ms?}` entries; `command` overrides ON only |
| `on` / `off` | Ordered `{device, payload?, delay_ms?}` entries; payloads pass through verbatim |
| `loop.enabled` | Enable the loop API |
| `loop.cycle` | `once` or `continuous`; default `once` |
| `loop.off_delay_ms` | Gap after ON and before OFF; `auto` starts immediately |
| `loop.on_delay_ms` | Gap after OFF and before the next ON in continuous mode |

Exactly one of `devices` or `on` is required. Missing `off` sends OFF to the ON devices.
Invalid durations warn and use defaults. Missing devices warn and their steps are skipped.

## Execution

- One run or loop may be active per instance. Concurrent requests return `false` and warn.
- `run('ON'|'OFF')` completes the ordered step list. Delays apply between steps.
- `startLoop()` runs ON, waits the OFF gap, then runs OFF. Continuous mode repeats after the ON gap.
- `stopLoop()` cancels an inter-phase wait immediately. An active step list finishes before stopping.
- Commands use `DeviceCommandSource.AUTOMATION` and normal device no-op suppression.
- Human interaction does not abort an active sequence. Restarts stop all runs and loops.

## Public API

| Owner | Methods |
|-------|---------|
| `SequenceBase` | `init()`, `run(command)`, `startLoop()`, `stopLoop()`, `cleanup()` |
| Instance status | `getName()`, `getSlug()`, `isActive()`, `isLoopActive()`, `getStateSummary()` |
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

## File Map

| Component | Path |
|-----------|------|
| Run engine | `src/sequence/base/sequenceBase.js` |
| Registry | `src/sequence/container/sequenceContainer.js` |
| Schema | `src/validators/sequences.js` |
| CLI | `src/ui/commands/sequenceCmd.js` |
| Tests | `tests/test-sequences.js` |

AI tools, restart persistence, and sequence names in automation `targets` remain deferred.
See [Configuration](../configuration.md#6-sequences-etcsequencesequencesyaml) for more examples.
