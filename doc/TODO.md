# TODO -- Zigbee Automaton

## General
- UI: Tabular "design" of sensors UI window looks like TOTAL SHIT. Some actual cell
  spacing and evening up should be introduced.
- UI: Both design and functionality of 5th window is a total misunderstanding.
  Instead of log-alike window, it should permanently list the rule-based
  automations and just re-draw whatever acted last under each one of them.
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
- DONE (2026-10-10) -- was: Implement the new *sequence* being per the approved brief in
  doc/architecture/sequence-entity.md (phases 1-7; design fully settled, nothing open). RESOLVED:
  SequenceBase (ordered steps, blocking mutex, optional loop driver with graceful stop + state keys
  sequence.<slug>.{active,phase,loop.active}) and SSequenceContainer singleton (config load, duplicate-slug/form
  validation, name/slug resolution, command/loop APIs, shutdown cleanup) under src/sequence/; wired into
  main.js startup/shutdown after DeviceContainer; etc/sequence/sequences.yaml.dist template + shallow
  validator (src/validators/sequences.js); /sequence UI command (list/run/loop start|stop with tab
  completion); tests/test-sequences.js scenarios A-H registered in bin/automaton-test; docs updated
  (configuration.md section 6, ui commands quick ref + detail). Along the way fixed humanToMs() to accept
  "ms" units as the brief documented, and made the loop driver yield an event-loop tick per cycle so
  zero-delay continuous loops never starve timers/UI.
- DONE (2026-10-11) -- was: looping sequences had no configurable gap between an OFF run and the
  next ON run (only off_delay_ms existed). RESOLVED: added symmetric loop.on_delay_ms (auto | duration,
  default auto; fires only on continuous cycles), parsed in SequenceBase exactly like off_delay_ms and
  applied as a second inter-phase wait slot in #driveLoop() reusing the same TimedAction/graceful-stop
  machinery (a stop during either wait cancels it -> straight to IDLE); validator schema extended
  (src/validators/sequences.js); sequences.yaml(.dist) header comments updated and the Salon Hazard Light
  entry now sets both gaps ('5s' each in the active config); tests/test-sequences.js scenarios I1/I2
  (both-gap oscillation + stop-during-pre-ON-wait) green; docs updated (configuration.md section 6,
  architecture doc D6/state machine/validation rules/test plan). Also restored missing final newlines
  on etc/sequence/*.yaml flagged by the convention gate.
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
- DONE (2026-10-10) -- was: teach CommandCorrelator.#evaluate() to recognize multi-channel suffixed echoes
  ({state_left/state_right}, {brightness_l1/brightness_l2}) so AUTOMATION commands on
  DualSwitch/DualDimmer consume their instant tokens via real echo matching instead of
  expiring by TTL. Today's fallback keeps attribution correct (origin set at publish +
  "preserve origin" inside the token window) but delays human-override detection until
  token expiry. Context: dual-switch work 2026-09; current semantics pinned by section D
  of tests/test-command-reassert.js section F. RESOLVED: register() derives per-channel expectations from the payload JSON; #evaluate() confirms on STATE channels (numeric fallback when no state); DeviceBase.#isCommandRedundant() proves {state_*,brightness_*,position_*} no-ops; DualDimmer correlates its split publishes onto STATE via options.correlateAs. See doc/ht-lights-bug.md finding #2.
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
