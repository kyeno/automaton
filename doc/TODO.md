# TODO -- Zigbee Automaton

## General
- DONE: FIXME: Is using hours (sunrise/sunset) in home-office-rolers automation
  fucking things up?! -- Yes, it was, and it is fixed. The sun gates now resolve to
  civil twilight (not the geometric disc edge), the roller open rule is gated behind
  dawn *and* behind the park rule's illuminance floor, and `hour:` bounds accept
  minute-precision clock times (`1230` == 12:30) so the 12:30 shading boundary is
  writeable at all. See doc/architecture/time-of-day-periods.md and
  tests/test-roller-morning-darkness.js.

- Add safety validation for incoming MQTT messages with texts. Remove unwanted
  characters like emoji, remove special characters, leave just UTF8 responsible
  for basic languages (slavic, germanic, hispanic, etc)
- Always display date and sunrise+sunset hours for the day in UI's sensors window (2)
  Remember to refresh it (as everything) so it doesn't get stale
- Add a UI window for "last matched rule(s)" for each RuleBasedAutomation
  (easier rules debugging)
- Implement simple personalization by adding a config option allowing to name
  the AI; then in the main prompts it should replace "Nazywasz się Gerwazy" with
  interpolation, "Nazywasz się {% name %}" (or something). Also, the UI chat
  window (3) should then rename "AI" to the assistant's name in both "join"
  message, chat messages and actions.
- CONSIDER: home-theater light restore fires on ANY not-playing status, including the
  pre-settle window where a title is still dwelling (~60 s) and reports as `stopped` -- so
  lamps come back mid-browse whenever it's already dark enough (parity with the old
  delegation, but worth investigating whether restore should require a settled watch
  session, e.g., by dropping bare `stopped` from the not-playing list). Related settle
  semantics in src/monitor/videoPlayerMonitor.js #observe(): pausing after settling does
  NOT reset the dwell clock (resume re-darkens immediately), while switching titles or
  stopping clears the session entirely.
- LATER (when WiFi is here): Consider monitoring WiFi devices so you can greet our friends by their mobile phone presence

## HUGE MILESTONES
- Add WiFi and WiFi devices support
- Integrate cleaning robot
- Integrate A/C

## Architecture
- Add option to set human interaction threshold as parameter to the function,
  then add it as an option to tool calling for AI - so it could open the rollers
  for certain amount of time.
- Intoduce crontab.js and move many automations from purely timer based, to cron-alike configs
- LATER: Postpone automations so they don't fire all at once
- Lift shared TTS pipeline into RuleBasedAutomationBase: availability guard, AI->TTS routing fallback, i18n sentence resolution + interpolation, silent-period gate deduplication; drop parity-only loadDevices()/resolveCommand() overrides from both TTS classes afterwards
- Support per-rule speech/action alongside targets: and invoke_automation, enabling one rule to drive devices AND speak
- CONSIDER: naming unification. Some *services* are named "...Service" (MqttService, CacheService) while others - still being services - are not (DeviceContainer)
- Same about monitor names. networkPresence doesn't have the Monitor suffix. Decide if we want those there or not.
- LATER: Do something with the structure; src/service/ vs src/ai/; as well as other similar cases
- CONSIDER: "ZigbeeMonitor" sharing the same "state change" logic as other monitors and populate that via local EventBus. Log real Zigbee state changes ONLY as trace; every higher level - via EventBus.
- CONSIDER: Dropping db's shm and wal to original DB more often, not just on quit?
- CONSIDER: Teach CommandCorrelator.#evaluate() to recognize multi-channel suffixed echoes
  ({state_left/state_right}, {brightness_l1/brightness_l2}) so AUTOMATION commands on
  DualSwitch/DualDimmer consume their instant tokens via real echo matching instead of
  expiring by TTL. Today's fallback keeps attribution correct (origin set at publish +
  "preserve origin" inside the token window) but delays human-override detection until
  token expiry. Context: dual-switch work 2026-09; current semantics pinned by section D
  of tests/test-dualswitch.js ("Origin tracking & human-interaction detection").
- LATER: Improve JSDoc generation (it's very messy and buggy) -- avoid `@ignore` on documented
  classes since it silently drops all their method pages from doc/api output; also fix
  module longnames coming out as "<file>\n<copyright>" for lib/* headers

## Speech-to-text
- Build entire speech-to-text (SST) architecture based on whisper-cpp
- Build a separate simple chat web UI for AI interaction that will utilize MQTT and thus
  share the same state with CLI, so that non-tech house dwellers would be able to interact with it.

## AI & TTS
- LATER: Add crypto price monitor and TTS automation
- Allow multiple AI engines configuration and a monitor checking which is online, so we 
  can route from best to worst
- Absurd anecdote generator (driver for AI) -- note: a first iteration already lives inside
  WeatherMan's `ai_prefix` prompt hook (drunken-weather one-liner); the bigger intended
  feature is NOT done yet, do not treat as complete
- CONSIDER: Modifying AI so it does not use the same *system prompt* for everything; f.e., 
  Weatherman overrides the system prompt instead of appending the user message. Consider pros vs cons when it comes to inference engine caching
- CONSIDER: Add quotes database?
- VERIFY: When AI fires request to sensor and we don't have cached data yet (machine was rebooted soon), data should get cached immediately after read
- LATER: Support `{"name": "get_device_list", "parameters": {}}` even if that tool is never exposed -- model still tries to access it with higher temp

### TTS Greeter "Goodbye" enhance ideas
- Greet only when someone comes back -- extend the greeter to also say goodbye when their computer goes OFFLINE after being up for a while (measure online duration via priorStateDurationMs() on the offline event, symmetric to today's windows).
- Keep goodbyes distinct from greetings: separate bundle buckets/sentences per host, so "see you later" never reads like a welcome-back and vice versa.
- Guard against chatter: a quick step-away must not trigger both a greeting and a goodbye; consider suppressing the next-day welcome right after an already-said goodbye (and deduping repeat offline events).

## BitchX UI
- BUG: When detaching screen in a bigger terminal window and reattaching in a
  smaller one - automaton crashes with deadlock/livelock (CPU spike)
- BUG: Try to fix the re-render flicker (not sure if possible with termkit)
- LATER: Improve how things are redrawn by statusbar; it seems to be constantly reading files
- LATER: Consistent color palette across all windows (status bar, device window)
- MAYBELATER: Proper nick highlighting (own messages emphasized in chat)
- MAYBELATER: Nicer slash commands output, some color formatting etc.
- VERY LATER: Do something with how ugly DeviceWindow is written. Consider some libs/ANSI helpers?

### Slash commands
- MAYBELATER: Add slash commands to debug state and eventbus(?); probably rewrite /status command
- MAYBELATER: `/whois`, `/wi`, `/wii` IRC-style commands for AI chat → device info
- LATER: Debug timers (LATER)

## MAYBE LATER: AI Assistant personalization
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
