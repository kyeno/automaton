# TODO -- Zigbee Automaton

## General
- Postpone automations so they don't fire all at once
- Improve JSDoc generation (it's very messy and buggy) -- avoid `@ignore` on documented
  classes since it silently drops all their method pages from doc/api output; also fix
  module longnames coming out as "<file>\n<copyright>" for lib/* headers

## Architecture
- Prefix main config file paths with respective sections!
- CONSIDER naming unification. Some *services* are named "...Service" (MqttService, CacheService) while others - still being services - are not (DeviceContainer)
- LATER: Do something with the structure; src/service/ vs src/ai/; as well as other similar cases

## AI
- VERIFY: When AI fires request to sensor and we don't have cached data yet (machine was rebooted soon), data should get cached immediately after read
- LATER: Support `{"name": "get_device_list", "parameters": {}}` even if that tool is never exposed -- model still tries to access it with higher temp
- LATER: Support `get_time` tool that would return both time of the day from `lib/date` as well as actual hour/minutes

## LATER: SST
- Build entire speech-to-text architecture based on whisper-cpp

### LATER: Assistant personalization
- Dynamic temperature settings per persona!
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
- Improve how things are redrawn by statusbar; it seems to be constantly reading files
- LATER: Consistent color palette across all windows (status bar, device window)
- LATER: Proper nick highlighting (own messages emphasized in chat)
- VERY LATER: Do something with how ugly DeviceWindow is written. Consider some libs/ANSI helpers?

### Slash commands
- Add slash command to debug config
+/- Add slash commands to debug automation container, interaction container, device container
- Add slash commands to debug state and eventbus(?); probably rewrite /status command
- Consider using autocompletion for the commands
- Add "force" option to run automations via cmd
- LATER: `/whois`, `/wi`, `/wii` IRC-style commands for AI chat → device info
- Debug timers (LATER)

---

→ [Documentation Home](./index.md)
