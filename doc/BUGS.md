# Codebase audit findings

Audit date: 2026-10-19. Baseline: commit `3db2347`.

These findings describe the code at the audit baseline; they are not fixes. The
audit examined runtime code, shipped automation implementations, and relevant
tests. Isolated probes used fake infrastructure and temporary files, without
contacting live services. The full test suite was not rerun for this read-only
audit. Items explicitly marked as reproduced were confirmed by those probes;
the remaining findings follow from source and caller analysis.

## Highest-priority defects

### 2. Frozen-sensor mail can be marked delivered after SMTP failure

- Locations: `src/service/emailService.js`, `notify()` and `#deliver()`;
  `src/monitor/frozenSensorMonitor.js`, `#sweep()`.
- `notify()` returns success after queueing mail and immediately records the
  notification cooldown. The watchdog then clears `emailPending` durably.
- An SMTP delivery failure occurs later, after the incident has already been
  considered notified. The initial notification can therefore be lost without
  being retried by the watchdog.
- The watchdog tests stub `notify()` itself, missing this integration failure.
  This defect was introduced in the recent frozen-sensor work: queue acceptance
  was incorrectly treated as delivery success.
- Suggested fix: distinguish queue acceptance from delivery acknowledgement and
  only clear durable pending incidents according to an explicit delivery policy,
  including partial recipient failures.

### 3. Email shutdown drops queued notifications

- Location: `src/service/emailService.js`, `cleanup()`.
- Cleanup closes and clears the transport without awaiting the send queue.
  Pending jobs subsequently find no transport and are discarded.
- This contradicts the main shutdown comment promising to drain queued mail.
- Suggested fix: stop accepting new sends, await the existing `drain()` method,
  then close the transport.

### 4. Automation execution is not consistently serialized

- Locations: `src/automation/base/automationBase.js`, `startTimer()` and
  `#runQueuedTriggers()`; automation container and delegated execution paths.
- Event-triggered runs are serialized within their own queue, but timer runs
  call `execute()` directly. Manual and delegated runs use another entry path.
- Executions can overlap while awaiting Redis, AI, or another automation. Two
  runs can both pass a daily-marker check before either writes it, causing
  duplicate speech or commands.
- Timer callbacks catch synchronous exceptions only; rejected execution promises
  are not caught locally.
- Suggested fix: route all execution sources through a shared per-instance run
  policy, with deliberate handling of coalescing and nested invocation.

### 5. Sequence reload does not await outgoing runs

- Locations: `src/sequence/container/sequenceContainer.js`, `reloadSequences()`;
  `src/sequence/base/sequenceBase.js`, `cleanup()`.
- Cleanup returns while an in-flight step list continues. Reload exposes new
  instances immediately, allowing old and new runs to issue commands together.
- An outgoing instance can also clear shared state keys belonging to its
  replacement. Shutdown can disconnect infrastructure before remaining steps run.
- Reproduced: commands continued after cleanup returned.
- Suggested fix: retain and await run/loop completion promises before replacing
  instances or disconnecting services. Preserve the intended graceful completion
  of the current phase.

### 7. AI history trimming leaves orphaned tool results

- Location: `src/ai/aiAssistant.js`, `#trimConversation()`.
- Trimming slices individual messages instead of complete exchanges, potentially
  removing an assistant tool-call declaration while retaining its tool results.
- Reproduced retained roles: `system -> tool -> tool -> assistant`.
- Subsequent provider requests can reject the malformed history, which is also
  persisted to the cache.
- Suggested fix: trim complete turns and preserve tool-call/result groups.

## Other correctness defects

### 8. Config reload applies a different snapshot from the validated one

- Location: `src/service/configService.js`, `reload()` safe-swap phase.
- Existing sections discard their validated candidate and call
  `existing.refresh()`, reading disk again through the old object's source path.
- Changing a `paths.configs` entry validates the new file but refreshes the old
  path. Concurrent file changes can also cause partial or unvalidated reloads.
- Suggested fix: let existing section objects adopt validated candidate data and
  source metadata without rereading files during the commit phase.

### 9. Invalid config roots pass validation

- Location: `src/service/config/configBase.js`, `#validate()`.
- Non-object roots return an empty error list. Reproduced: a main configuration
  containing only `42` passed validation.
- Array-item validation also skips primitive entries where object entries have
  required properties.
- Suggested fix: report structural errors at the root and enforce the expected
  item shape where the schema declares object properties.

### 10. MQTT unsubscribe removes subscriptions needed by other consumers

- Location: `src/service/mqttService.js`, unsubscribe function from `subscribe()`.
- Removing one callback always sends a broker-level unsubscribe, even when
  another callback still uses that exact topic subscription.
- Reproduced with two consumers of the same topic.
- Suggested fix: reference-count broker subscriptions separately from callbacks.

### 11. Bridge routing breaks with multi-level MQTT prefixes

- Location: `src/device/type/bridge.js`, `#extractBridgePath()`.
- Routing reads `topic.split('/')[2]`, assuming the configured prefix has one
  level. A prefix such as `home/zigbee2mqtt` shifts the bridge suffix and breaks
  discovery despite subscribing to the correct topic.
- Suggested fix: interpret the suffix after the configured prefix.

### 12. Network presence loses usable runtime state during SQLite outages

- Location: `src/monitor/networkPresence.js`, presence accessors and
  `#markDevice()`.
- The monitor maintains `#lastLabel`, but ordinary presence queries read SQLite
  exclusively. Online hosts appear absent to automation conditions when the
  database is unavailable.
- Every sweep also republishes presence events during the outage because
  unavailable persistence is treated as a change.
- Suggested fix: reuse the existing memory map for fallback reads and the live
  change baseline, keeping persistence availability separate from observation.

### 13. Announcement speech success is assumed rather than acknowledged

- Locations: `src/lib/announcementPipeline.js`, `#buildText()`;
  `src/lib/ttsProfiles.js`; `src/service/ttsService.js`.
- Direct TTS sets `spoken: true` after emitting an event. The AI path treats a
  nonempty reply as successfully spoken.
- Disabled or failed TTS can therefore consume reminder intervals or daily
  announcement slots even though no speech was delivered.
- Suggested fix: distinguish text generation, speech submission, and delivery
  acknowledgement; propagate the outcome required by each caller.

### 14. Advertised Node compatibility conflicts with static SQLite import

- Locations: `package.json`, `README.md`, `doc/installation/index.md`, and
  `src/service/databaseService.js`.
- The project advertises Node >=20 but statically imports `node:sqlite`, which
  is unavailable in Node 20. Startup fails during module loading, before optional
  database initialization handling can run.
- Suggested fix: align the supported runtime requirement and documentation, or
  make SQLite loading genuinely optional.

### 15. MQTT multi-level wildcard does not match zero remaining levels

- Location: `src/service/mqttService.js`, `#topicMatches()`.
- Reproduced: subscription `audit/#` does not match topic `audit`, although `#`
  also matches zero remaining levels.
- Suggested fix: handle a trailing `#` after the received levels are exhausted.

### 16. Explicit zero sequence delay cannot override the default

- Location: `src/sequence/base/sequenceBase.js`, step normalization and
  `#executeSteps()`.
- Unspecified and explicit zero delays both normalize to zero. Dispatch then
  falls back to the sequence default whenever the step delay is not positive.
- Suggested fix: retain an absent-value sentinel and honor explicit zero.

### 17. Automation silence parser accepts invalid clock times

- Location: `src/automation/base/automationBase.js`, `parseSilenceWindow()`.
- Values such as `2960-0600` satisfy the format check and produce invalid
  minute-of-day bounds. The frozen-sensor monitor's separate parser already
  rejects invalid hours and minutes.
- Suggested fix: share a strict clock-window parser and containment helper.

### 18. Right-aligned temperature widgets use the wrong rendering contract

- Location: `src/ui/widgets/statusBar.js`, right-side rendering and measurement.
- Temperature renderers return `{ label, value }`, but right-side rendering and
  width measurement treat the object as text. Left-side rendering handles the
  structured result correctly.
- Suggested fix: share rendering/measurement rules for structured widget output,
  using visible terminal width rather than object stringification.

## Duplication and opportunities to reuse existing code

### Speech orchestration

`etc/automation/ttsGreeterAutomation.js` and `ttsTwilightAutomation.js` duplicate
AI invocation, fallback handling, transcript emission, interpolation checks, and
framing already owned by `src/lib/announcementPipeline.js`. WeatherMan also has
overlapping delivery logic, but its richer prompt construction should remain
specialized. Consolidate delivery while preserving prompt behavior, anecdotes,
and the separation between private live instructions and public templates.

### Rule evaluation and diagnostics

Numeric comparisons and presence/video-player condition normalization exist in
both `src/automation/base/ruleBasedAutomationBase.js` and
`src/lib/ruleCoverage.js`. Diagnostics implement another condition traversal.
Share pure condition helpers first; consider an evaluator returning both the
match result and rejection reason. Keep deliberate differences between static
coverage scenarios and runtime data explicit.

### Localized YAML loading

Services and speech automations independently implement locale lookup, YAML
parsing, fallback, caching, and error handling. Their behavior differs, including
`.dist` fallback and malformed-document handling. A shared bundle loader should
provide explicit policies for fallback and refresh rather than silently imposing
one caching policy on every caller.

### Logger file transports

`src/service/logger/consoleTransports.js` and `uiTransports.js` duplicate
file-option normalization and debug/warn/trace transport construction almost
verbatim. Extract the common file-transport builder and retain mode-specific
console/UI behavior in each profile.

### Physical action routing and debounce

`src/device/type/remote.js` implements its own interaction lookup and dispatch
instead of reusing `InteractionContainer.routeDeviceAction()`, which DualSwitch
already uses. Debounce logic also overlaps. Preserve Remote's configurable
debounce scope when consolidating behavior, and handle asynchronous dispatch
failures consistently.

## Unused or ineffective code

- `src/lib/terminal.js`: `wrapText()` and `nowTime()` have no tracked callers.
  `wrapText()` truncates long words, so adopting it would introduce data loss;
  retain the existing ANSI-aware wrapping path instead.
- `src/ai/providers/openaiProvider.js`: `chatText()` has no tracked callers.
- `src/ui/commands/deviceCmd.js`: the active-command display checks
  `device.hasActive()` and `device.getActiveKind()`, but those methods belong to
  the private correlator, not the device. The branch cannot run for real devices;
  its test double exposes methods absent from the production object. Expose a
  deliberate device status API or remove the ineffective display branch.
- `src/service/databaseService.js`: `priorTransitionTs()` has tests but no
  production callers.
- `src/lib/ruleCoverage.js`: `changedHours()` has tests but no production callers.
  These last two are cleanup candidates, not inherently defective APIs; verify
  intended external use before removal.

## Testing gaps and recommended order

The main gap is failure and lifecycle integration. Tests often verify each
component's local contract while missing behavior across queueing, delivery,
reconnect, reload, and shutdown boundaries. Some test doubles expose stronger
guarantees or a different API from production objects.

Prioritize MQTT subscription handling, notification acknowledgements and
draining, execution serialization, sequence teardown, and AI history integrity. Follow with config reload/validation fixes and the
smaller correctness defects. Refactor duplication after pinning down those
contracts with regression coverage; passing happy-path tests alone does not
establish safe failure behavior.
