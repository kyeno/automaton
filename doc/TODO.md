# TODO -- Zigbee Automaton

## General
- Add crypto price monitor and TTS automation
- Add flowers moisture TTS automation (warnings)
- BUG: DatabaService is *silent*, doesn't produce any lifecycle logs.

## HUGE MILESTONES
- Add WiFi and WiFi devices support
- Build entire speech-to-text (SST) architecture based on whisper-cpp

## Architecture
- Lift shared TTS pipeline into RuleBasedAutomationBase: availability guard, AI->TTS routing fallback, i18n sentence resolution + interpolation, silent-period gate deduplication; drop parity-only loadDevices()/resolveCommand() overrides from both TTS classes afterwards
- Add use_ai flag to weatherman config (default true) while greeter keeps false
- Support per-rule speech/action alongside targets: and invoke_automation, enabling one rule to drive devices AND speak
- CONSIDER: naming unification. Some *services* are named "...Service" (MqttService, CacheService) while others - still being services - are not (DeviceContainer)
- Same about monitor names. networkPresence doesn't have the Monitor suffix. Decide if we want those there or not.
- LATER: Do something with the structure; src/service/ vs src/ai/; as well as other similar cases
- CONSIDER: "ZigbeeMonitor" sharing the same "state change" logic as other monitors and populate that via local EventBus. Log real Zigbee state changes ONLY as trace; every higher level - via EventBus.
- CONSIDER: Dropping db's shm and wal to original DB more often, not just on quit?
- LATER: Postpone automations so they don't fire all at once
- LATER: Improve JSDoc generation (it's very messy and buggy) -- avoid `@ignore` on documented
  classes since it silently drops all their method pages from doc/api output; also fix
  module longnames coming out as "<file>\n<copyright>" for lib/* headers

## AI & TTS
- Allow multiple AI engines configuration and a monitor checking which is online, so we can route from best to worst
- Absurd anecdote generator (driver for AI)
- CONSIDER: Modifying AI so it does not use the same system prompt for everything; f.e., Weatherman overrides the system prompt instead of appending the user message. Consider pros vs cons when it comes to inference engine caching
- CONSIDER: Add quotes database?
- VERIFY: When AI fires request to sensor and we don't have cached data yet (machine was rebooted soon), data should get cached immediately after read
- LATER: Support `{"name": "get_device_list", "parameters": {}}` even if that tool is never exposed -- model still tries to access it with higher temp
- LATER: Support `get_time` tool that would return both time of the day from `lib/date` as well as actual hour/minutes
- LATER: Drive the "* AI thinking..." indicator from shared state instead of inline print -- expose `ai.busy` plus a start timestamp via StateService while processMessage() holds its FIFO lock; AiWindow observes it and either rewrites the line to "* AI thought for X seconds" on completion or appends an IRC `/me`-style follow-up message

### LATER: Assistant personalization
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

## TTS Greeter "Goodbye" enhance ideas
- Greet only when someone comes back -- extend the greeter to also say goodbye when their computer goes OFFLINE after being up for a while (measure online duration via priorStateDurationMs() on the offline event, symmetric to today's windows).
- Keep goodbyes distinct from greetings: separate bundle buckets/sentences per host, so "see you later" never reads like a welcome-back and vice versa.
- Guard against chatter: a quick step-away must not trigger both a greeting and a goodbye; consider suppressing the next-day welcome right after an already-said goodbye (and deduping repeat offline events).

---

→ [Documentation Home](./index.md)
