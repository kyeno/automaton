# TODO -- Zigbee Automaton

## General
- CONSIDER: "ZigbeeMonitor" sharing the same "state change" logic as other monitors and populate that via local EventBus. Log real Zigbee state changes ONLY as trace; every higher level - via EventBus.
- CONSIDER: Dropping db's shm and wal to original DB more often, not just on quit?
- Create "greeter" TTS/AI automation that will work in tandem with network monitor and greet people when their computers go online; add "off period guard" on launching, so you don't greet person on reboot. Consider goodbye logic not to do the same.
- Add WiFi and WiFi devices support
- Add crypto price monitor
- LATER: Postpone automations so they don't fire all at once
- LATER: Improve JSDoc generation (it's very messy and buggy) -- avoid `@ignore` on documented
  classes since it silently drops all their method pages from doc/api output; also fix
  module longnames coming out as "<file>\n<copyright>" for lib/* headers

## Architecture
- CONSIDER naming unification. Some *services* are named "...Service" (MqttService, CacheService) while others - still being services - are not (DeviceContainer)
- LATER: Do something with the structure; src/service/ vs src/ai/; as well as other similar cases

## AI & TTS
- Allow multiple AI engines configuration and a monitor checking which is online, so we can route from best to worst
- Absurd anecdote generator (driver for AI)
- CONSIDER: Modifying AI so it does not use the same system prompt for everything; f.e., Weatherman overrides the system prompt instead of appending the user message. Consider pros vs cons when it comes to inference engine caching
- CONSIDER: Add quotes database?
- VERIFY: When AI fires request to sensor and we don't have cached data yet (machine was rebooted soon), data should get cached immediately after read
- LATER: Support `{"name": "get_device_list", "parameters": {}}` even if that tool is never exposed -- model still tries to access it with higher temp
- LATER: Support `get_time` tool that would return both time of the day from `lib/date` as well as actual hour/minutes
- LATER: Drive the "* AI thinking..." indicator from shared state instead of inline print -- expose `ai.busy` plus a start timestamp via StateService while processMessage() holds its FIFO lock; AiWindow observes it and either rewrites the line to "* AI thought for X seconds" on completion or appends an IRC `/me`-style follow-up message

## LATER: SST
- Build entire speech-to-text architecture based on whisper-cpp

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
- FIX: /config rendering YAMLs without indentation; reloading doesn't render greeting on AI channel
- MAYBELATER: Add slash commands to debug state and eventbus(?); probably rewrite /status command
- MAYBELATER: `/whois`, `/wi`, `/wii` IRC-style commands for AI chat → device info
- LATER: Debug timers (LATER)

---

→ [Documentation Home](./index.md)
