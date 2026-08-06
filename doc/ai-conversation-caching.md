# AI Conversation Caching

## Overview

Automaton persists AI conversation history in Redis so that user-initiated chats survive application restarts. System-originated messages from the periodic service are explicitly excluded from caching to prevent indefinite TTL extension.

---

## How It Works

### Persistence

When a message is processed through `AiAssistant.processMessage()`, the full conversation (excluding the system prompt) is serialized and stored in Redis under the key `ai:conversation:default`. This happens after all tool-call iterations complete and before the response is returned.

On startup, `AiAssistant.init()` calls `#restoreConversation()` which loads this key back into memory, reconstructing the conversation array with a fresh system prompt prepended.

### TTL (Time-to-Live)

Each cached entry has an expiration measured in seconds:

| Parameter | Default | Config Key | Description |
|-----------|---------|------------|-------------|
| `conversation_ttl_sec` | 900 (15 min) | `conversation_ttl_sec` | TTL for the Redis conversation key |
| `max_conversation_turns` | 20 | `max_conversation_turns` | Maximum non-system messages kept in history |

After every successful user-originated exchange, the TTL resets to the configured value. If no user interacts within the TTL window, the Redis key expires and the conversation is lost on next restart.

### Message Trimming

Before persistence, the conversation is trimmed to at most `max_conversation_turns` non-system messages (oldest messages are dropped first). The system prompt at index 0 is always preserved.

---

## System vs User Origin

Messages carry an `_origin` field indicating their authorship:

| Origin | Value | Source | Cached? |
|--------|-------|--------|---------|
| **USER** | `'user'` | Human typed message in chat input | Yes |
| **SYSTEM** | `'system'` | AiPeriodicService timer tick | **No** |

The origin enum is defined in `src/enum/aiChatMessageOrigin.js`:

```javascript
const ChatMessageOrigin = Object.freeze({
    USER: 'user',
    SYSTEM: 'system'
})
```

### How `_origin` Propagation Works

When `processMessage()` is called with `{ origin: 'system' }`, the `_origin` value is propagated to **every** message generated during that entire conversation turn:

1. The initial user-role message (`_origin: 'system'`)
2. All assistant responses generated in the tool-call loop (`_origin: 'system'`)
3. All tool-result messages (`_origin: 'system'`)
4. Any fallback assistant message after max iterations (`_origin: 'system'`)

This ensures the entire system-originated exchange can be filtered out as a unit during persistence.

### Why System Messages Are Excluded from Cache

The AI Periodic Service (`src/service/aiPeriodicService.js`) sends automated prompts to the AI at regular intervals (default: every 15 minutes). Before this change, each periodic tick would call `#persistConversation()`, resetting the Redis TTL indefinitely — effectively making conversations never expire while Automaton was running.

Now there are **two** layers of protection:

1. **Skip persistence call** - When `processMessage()` detects `options.origin === ChatMessageOrigin.SYSTEM`, it skips both `#trimConversation()` and `#persistConversation()` entirely.
2. **Filter during persistence** - Even if system-originated messages exist in memory (from previous ticks), `#persistConversation()` filters them out via `_origin !== 'system'` before writing to Redis.

This means:

- System messages still appear in the UI during the session (kept in-memory)
- TTS still fires normally for system-originated responses
- The conversation cache TTL only advances on actual user interaction
- After restart, only user-initiated exchanges are restored
- System messages cannot "leak" into the cache when a subsequent user message triggers a save

---

## Message Flow

### User-Originated Exchange (Cached)

```
User types message in chat input
  │
  ├─ processMessage(text, { origin: 'user' })
  ├─ Push user message to #messages (_origin: 'user')
  ├─ Tool execution loop (all msgs get _origin: 'user')
  ├─ First AI text response received
  ├─ #trimConversation()          ← executed
  ├─ #persistConversation()       ← executed (resets TTL)
  │                              ← filters: role != 'system' AND _origin != 'system'
  ├─ EventBus.emit('tts:speak')   ← fired
  └─ Return response to UI
```

### System-Originated Exchange (Not Cached)

```
AiPeriodicService timer tick fires
  │
  ├─ processMessage(prompt, { origin: 'system' })
  ├─ Push user message to #messages (_origin: 'system')
  ├─ Tool execution loop (all msgs get _origin: 'system')
  ├─ First AI text response received
  ├─ #trimConversation()          ← SKIPPED (isSystemOrigin = true)
  ├─ #persistConversation()       ← SKIPPED (isSystemOrigin = true)
  ├─ EventBus.emit('tts:speak')   ← still fired
  └─ Return response to UI

Later, when a user message triggers persistence:
  │
  ├─ #persistConversation() called
  ├─ Filters out ALL messages with _origin === 'system'
  └─ Only user-originated turns written to Redis
```

---

## Configuration

All settings are in `etc/automaton.yaml`:

```yaml
# Conversation cache TTL in seconds (default: 900 = 15 minutes)
conversation_ttl_sec: 900

# Maximum messages kept in conversation history (default: 20)
max_conversation_turns: 20

# Periodic service interval in milliseconds (default: 900000 = 15 minutes; 0 to disable)
ai_periodic_message:
  interval_ms: 900000
```

To make conversations expire faster, reduce `conversation_ttl_sec`. To prevent periodic system messages entirely, set `interval_ms: 0`.

---

## File Map

| Component | File Path |
|-----------|-----------|
| AiAssistant (orchestrator, persistence logic) | `src/ai/aiAssistant.js` |
| ChatMessageOrigin enum | `src/enum/aiChatMessageOrigin.js` |
| AiPeriodicService (system message timer) | `src/service/aiPeriodicService.js` |
| CacheService (Redis client) | `src/service/cacheService.js` |
| AiWindow (UI display) | `src/ui/windows/aiWindow.js` |