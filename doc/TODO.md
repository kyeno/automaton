# TODO -- Zigbee Automaton

## General
- Add email system with simple SMTP configuration in .env + option for TTS
  Gardener to send notification emails if sensors are stuck. Add house owners
  array to automaton.yaml (array of emails that should be notified in such
  cases). Create i18n-aware email templates where such notification would only
  take over the subject and AI response's (or TTS, if AI is disabled) part of
  the body. The template will carry some sort of "Hello, {% owner_name %},\n\n{%
  AI response %}\n\n-- \n{% AI bot name %}, automaton house automation" or so.
- Weatherman: Use hourly storage of temp/pressure/humidity values in each cycle,
  then when those values are available, modify the sentence to say not the
  temperature "is X", but "has risen to X", "has fallen to X" or "remains stable at
  X". More can be added like "temperature is X and have fallen X degrees within
  the last hour", etc.
- BUG: /config reload is so inherently broken it's probably beyond repair.
  Consider a fixing attempt and if it fails, remove the functionality altogether.
- VERIFY: When AI fires request to sensor and we don't have cached data yet
  (machine was rebooted soon), data should get cached immediately after read
- CONSIDER: home-theater light restore fires on ANY not-playing status, including the
  pre-settle window where a title is still dwelling (~60 s) and reports as `stopped` -- so
  lamps come back mid-browse whenever it's already dark enough (parity with the old
  delegation, but worth investigating whether restore should require a settled watch
  session, e.g., by dropping bare `stopped` from the not-playing list). Related settle
  semantics in src/monitor/videoPlayerMonitor.js #observe(): pausing after settling does
  NOT reset the dwell clock (resume re-darkens immediately), while switching titles or
  stopping clears the session entirely.

## HUGE MILESTONES
- Add WiFi and WiFi devices support
- Integrate cleaning robot
- Integrate A/C
- Integrate automated IR remote

## Architecture
- Move ai_bridge: config key to ai: bridge:
- BUG: Many config entries have something_timeout or something_cooldown _ms, while they
  take human readable time format (not ms). It would make sense to unify that.
- Add option to set human interaction threshold as parameter to the function,
  then add it as an option to tool calling for AI - so it could open the rollers
  for certain amount of time.
- Intoduce crontab.js and move many automations from purely timer based, to cron-alike configs
- LATER: Postpone automations so they don't fire all at once (together with crontab.js)
- Lift shared TTS pipeline into RuleBasedAutomationBase: availability guard, AI->TTS routing fallback, 
  i18n sentence resolution + interpolation, silent-period gate deduplication; drop parity-only 
  loadDevices()/resolveCommand() overrides from both TTS classes afterwards
- Support per-rule speech/action alongside targets: and invoke_automation, enabling one rule to drive devices AND speak
- CONSIDER: naming unification. Some *services* are named "...Service" (MqttService, CacheService) while others - still being services - are not (DeviceContainer)
- Same about monitor names. networkPresence doesn't have the Monitor suffix. Decide if we want those there or not.
- LATER: Do something with the structure; src/service/ vs src/ai/; as well as other similar cases
- CONSIDER: "ZigbeeMonitor" sharing the same "state change" logic as other monitors and populate that via local EventBus. Log real Zigbee state changes ONLY as trace; every higher level - via EventBus.
- CONSIDER: Dropping db's shm and wal to original DB more often, not just on quit?
- LATER: Improve JSDoc generation (it's very messy and buggy) -- avoid `@ignore` on documented
  classes since it silently drops all their method pages from doc/api output; also fix
  module longnames coming out as "<file>\n<copyright>" for lib/* headers

## Speech-to-text
- Build entire speech-to-text (SST) architecture based on whisper-cpp
- Build a separate simple chat web UI for AI interaction that will utilize MQTT and thus
  share the same state with CLI, so that non-tech house dwellers would be able to interact with it.

## AI & TTS
- Add internet connection online/offline monitor and TTS warning
- Absurd anecdote generator (driver for AI) -- note: a first iteration already lives inside
  WeatherMan's `ai_prefix` prompt hook (drunken-weather one-liner); the bigger intended
  feature is NOT done yet, do not treat as complete
- LATER (when WiFi support is here): Monitor WiFi devices so you can greet our friends by their mobile phone presence
- LATER: Add crypto price monitor and TTS automation
- LATER: Allow multiple AI engines configuration and a monitor checking which is online, so we 
  can route from best to worst
- CONSIDER: Modifying AI so it does not use the same *system prompt* for everything; f.e., 
  Weatherman overrides the system prompt instead of appending the user message. Consider pros vs cons when it comes to inference engine caching
- CONSIDER: Add quotes database?
- MAYBELATER: Support `{"name": "get_device_list", "parameters": {}}` even if that tool is never exposed -- model still tries to access it with higher temp
  Maybe build-in a small MCP server?
- AI processing gate: expose the serialized pipeline and stop callers blocking on it.
  `AiAssistant` already serializes requests on a FIFO promise chain (`#queue = Promise.resolve()`,
  busy counter `#busyCount` / `#busySince` mirrored to state key `ai.busy` by `#setAiBusy()`), but
  exposes only `isAvailable()` -- which answers "provider configured", not "pipeline busy" -- and
  every caller blocks on the resolved reply (`src/ui/windows/aiWindow.js`,
  `src/monitor/aiBridgeMonitor.js`, and the twilight/greeter/gardener/weatherman automations), so
  one slow model call holds every producer's run open for the whole queue depth.
  - Add `isProcessing()` and `queueDepth()`; `#queue` is a promise, not a list, so the gate needs
    an explicit `#pending` list drained one item at a time.
  - Add `enqueueMessage(text, options)` returning `{queued, position}` in the same tick -- fire and
    forget, never awaiting the model.
  - Replies must then leave the promise: publish an EventBus transcript topic (`ai:reply` carrying
    `{source, replyTopic, text, timestamp}`) that aiWindow renders, aiBridgeMonitor republishes to
    the originating MQTT topic, and automations route to TTS. Keep `processMessage()` resolving as
    it does today so synchronous callers are unaffected.
  - Bound the queue (`ai.max_queue` in etc/automaton.yaml + .dist -- tests/test-dist-sync.js), drop
    the oldest on overflow with a warning, drop replies whose origin is gone, keep the
    provider-error empty-string contract so speech fallbacks stay intact.
  - Accept: UI and bridge turns answered FIFO without blocking each other; enqueue returns
    immediately; exactly one request in flight; an automation never blocks its own execute() and
    never speaks twice; tests in tests/test-ai-assistant.js; npm test + npm run lint:check green.
  - Open: a late reply spoken after its moment passed (speech automations must re-check their
    freshness gates -- twilight's `announce_grace` already bounds this); restart mid-queue (persist
    in Redis next to the conversation cache, or discard); no per-request model timeout exists, so a
    hung provider stalls the queue indefinitely -- worth adding with the gate.
  - Context: the two symptoms that surfaced this (duplicate civil-dusk announcement, dusk ambient
    deferred by the human cooldown) are handled by the twilight slot claim and the per-rule
    `bypass_human_cooldown` flag; this item hardens the shared pipeline itself.

### TTS Greeter "Goodbye" enhance ideas
- Greet only when someone comes back -- extend the greeter to also say goodbye when their computer goes OFFLINE after being up for a while (measure online duration via priorStateDurationMs() on the offline event, symmetric to today's windows).
- Keep goodbyes distinct from greetings: separate bundle buckets/sentences per host, so "see you later" never reads like a welcome-back and vice versa.
- Guard against chatter: a quick step-away must not trigger both a greeting and a goodbye; consider suppressing the next-day welcome right after an already-said goodbye (and deduping repeat offline events).

## BitchX UI
- Consistent color palette across all windows (status bar, device window)
- BUG: When detaching screen in a bigger terminal window and reattaching in a
  smaller one - automaton crashes with deadlock/livelock (CPU spike)
- BUG: Try to fix the re-render flicker (not sure if possible with termkit)
- LATER: Improve how things are redrawn by statusbar; it seems to be constantly reading files
- MAYBELATER: Proper nick highlighting (own messages emphasized in chat)
- MAYBELATER: Nicer slash commands output, some color formatting etc.
- VERY LATER: Do something with how ugly DeviceWindow is written. Consider some libs/ANSI helpers?
- MAYBELATER: Add slash commands to debug state and eventbus(?); probably rewrite /status command
- VERY MAYBELATER: Debug timers (LATER)
- VERY MAYBELATER: `/whois`, `/wi`, `/wii` IRC-style commands for AI chat → device info

## OBSOLETE: AI Assistant personalization; TODO: Rewrite the idea! Some of it's parts were moved to TTS config, others to naming.
- Dynamic model temperature settings per persona!
- Example:
personas:
  hal9000:
    language: "pl"
    system_prompt: "Nazywasz się HAL-9000. Jesteś głównym komputerem pokładowym. Odpowiadasz niezwykle spokojnie, logicznie, wręcz chłodno i bezemocjonalnie."
    voice_model: "pl_PL-bass-medium.onnx"
    sox_effects: "speed 0.95 pitch -50 bandpass 1200 1500 norm -2"
    temperature: 0.1

  cyborg:
    language: "pl"
    system_prompt: "Jesteś zrobotyzowanym asystentem bojowym w świecie cyberpunk..."
    voice_model: "pl_PL-bass-medium.onnx"
    sox_effects: "pitch -400 speed 0.9 overdrive 10 0 reverb 10 10 50 norm -1"

  mario:
    language: "en"
    system_prompt: "It's-a me, Mario! Respond to home automation queries in a cheerful, Italian-plumber style."
    voice_model: "en_US-vctk-medium.onnx"
    speaker_id: 42
    sox_effects: "pitch 300 speed 1.1 tempo 1.05"

---

→ [Documentation Home](./index.md)
