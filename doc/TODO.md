# TODO -- Zigbee Automaton

## General
- Postpone automations so they don't fire all at once
- Remove all UTF-8 that's not diacritic chars; add a "linter" step that checks for this
- Improve JSDoc generation (it's very messy and buggy)

## Architecture
- Prefix main config file paths with respective sections!
- CONSIDER naming unification. Some *services* are named "...Service" (MqttService, CacheService) while others - still being services - are not (DeviceContainer)
- Do something with the structure; src/service/ vs src/ai/; as well as other similar cases

### MQTT & Zigbee Bridge

- **Wildcard subscription `zigbee/#` delivers all traffic to one handler**
  Every Zigbee message (sensor state + remote actions) shares `#processMessage`. This works but couples all device logic into one callback. Consider per-topic subscriptions as the system grows.

### Code Quality & Documentation

- **Dynamic method generation on `Temporal.prototype` (`lib/date.js`)**
  Day-period methods (`isMorning()`, `isNoon()`, etc.) and season methods are generated via `for...of` loops assigning to `Temporal.prototype`. IDEs may not autocomplete these, and minifiers could interfere. Document generated methods in JSDoc or list them explicitly.

## AI
- Do not return .00 values for AI tool calls; round them up!
- When AI fires request to sensor and we don't have cached data yet (machine was rebooted soon), data should get cached immediately after read
- Support `{"name": "get_device_list", "parameters": {}}` even if that tool is never exposed -- model still tries to access it with higher temp
- Support `get_time` tool that would return both time of the day from `lib/date` as well as actual hour/minutes
- Unify cache read messages vs real time reads on AiWindow:
  cache: [05:58:26am] * AI checked state of Balkon Temperatura
   live: [06:17:15am] * AI performed STATE on Balkon Temperatura
- Modify current TTS weather report to build message for AI locally, including sensor values and suggestions to warn about conditions, use AI only to construct nice sentence

### Assistant personalization
personas:
  hal9000:
    language: "pl"
    system_prompt: "Nazywasz się HAL-9000. Jesteś głównym komputerem pokładowym. Odpowiadasz niezwykle spokojnie, logicznie, wręcz chłodno i bezemocjonalnie."
    voice_model: "pl_PL-bass-medium.onnx"
    sox_effects: "speed 0.95 pitch -50 bandpass 1200 1500 norm -2"

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

- BUG: When running in `screen` and typing a long message it produces really weird results
- BUG: Try to fix the re-render flicker (not sure if possible with termkit)
- Consistent color palette across all windows (status bar, device window)
- `/whois`, `/wi`, `/wii` IRC-style commands for AI chat → device info
- Proper nick highlighting (own messages emphasized in chat)
- Improve how things are redrawn by statusbar; it seems to be constantly reading files
- Do something with how ugly DeviceWindow is written. Consider some libs/ANSI helpers?

### Slash commands
- Add slash command to debug config
- Add slash commands to debug automation container, interaction container, device container
- Add slash commands to debug state and eventbus(?); probably rewrite /status command
- Debug timers (LATER)