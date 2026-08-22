# AI Conversation Caching

## Overview

Automaton persists AI conversation history in Redis so that user-initiated chats survive application restarts. System-originated messages -- e.g., automated announcements sent by rule-based automations -- are isolated entirely: they never linger in the shared in-memory history between turns and are excluded from caching, so they can neither slow down later prompts nor extend TTLs indefinitely. All turns (user- and system-origin) run serialized through an internal FIFO queue, so concurrent callers can never interleave against one conversation.

---

## How It Works

### Persistence

When a message is processed through `AiAssistant.processMessage()`, the full conversation (excluding the system prompt) is serialized and stored in Redis under the key `ai:conversation:default`. This happens after all tool-call iterations complete and before the response is returned.

On startup, `AiAssistant.init()` calls `#restoreConversation()` which loads this key back into memory, reconstructing the conversation array with a fresh system prompt prepended.

### TTL (Time-to-Live)

Each cached entry has an expiration measured in seconds:

| Parameter | Default | Config Key | Description |
|-----------|---------|------------|-------------|
| `conversation_ttl_sec` | 900 s (`"15m"`) | `conversation_ttl_sec` | TTL for the Redis conversation key (human-readable duration or plain seconds) |
| `max_conversation_turns` | 20 | `max_conversation_turns` | Maximum non-system messages kept in history |
| `fetch_timeout_ms` | 300 s (`"5m"`) | `fetch_timeout_ms` | Per-request HTTP timeout for LLM calls (human-readable duration or plain ms); timeouts are treated as final -- not retried |

After every successful user-originated exchange, the TTL resets to the configured value. If no user interacts within the TTL window, the Redis key expires and the conversation is lost on next restart.

### Message Trimming

Before persistence, the conversation is trimmed to at most `max_conversation_turns` non-system messages (oldest messages are dropped first). The system prompt at index 0 is always preserved.

---

## System vs User Origin

Messages carry an `_origin` field indicating their authorship:

| Origin | Value | Source | Cached? |
|--------|-------|--------|---------|
| **USER** | `'user'` | Human typed message in chat input | Yes |
| **SYSTEM** | `'system'` | Rule-based automation announcement (e.g., weatherman timer tick) | **No** |

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

This ensures the entire system-originated exchange can be filtered out as a unit during persistence -- which now mostly matters as a secondary safeguard, because primary isolation removes the whole turn from memory before it ever reaches the cache (see below).

### Why System Messages Are Excluded from Cache

Rule-based automations send automated prompts to the AI on their own timers (e.g., hourly weather announcements). Historically, each such tick would call `#persistConversation()`, resetting the Redis TTL indefinitely — effectively making conversations never expire while Automaton was running. Worse, the ticks also *accumulated* in the shared in-memory history for the rest of the uptime, so every later prompt carried all previous reports (slower responses, and interactive replies referencing earlier weather).

There are now **three** layers of protection:

1. **Turn isolation (primary)** - When `processMessage()` detects `options.origin === ChatMessageOrigin.SYSTEM`, it snapshots the message-array length before pushing the prompt and restores it in a `finally` block after the turn completes -- success, tool-loop completion, or failure alike. A system turn therefore leaves zero residue: no accumulated context growth, and no orphan user messages when the LLM call fails mid-turn.
2. **Skip persistence call** - System-origin turns skip both `#trimConversation()` and `#persistConversation()` entirely, so they cannot reset the Redis TTL.
3. **Filter during persistence** - Even if system-originated messages were present in memory (e.g., legacy state restored before an upgrade), `#persistConversation()` filters them out via `_origin !== 'system'` before writing to Redis.

This means:

- System messages still appear live in the UI during their own turn and TTS fires normally
- They are not retained afterwards -- each tick starts from the same clean baseline as the last
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

### System-Originated Exchange (Isolated, Not Cached)

```
Rule-based automation runs (e.g., weatherman timer tick)
  │
  ├─ processMessage(prompt, { origin: 'system' })      [serialized via internal FIFO queue]
  ├─ Snapshot #messages.length                         ← isolation baseline
  ├─ Push user message to #messages (_origin: 'system')
  ├─ Tool execution loop (all msgs get _origin: 'system')
  ├─ First AI text response received
  ├─ #trimConversation()          ← SKIPPED (isSystemOrigin = true)
  ├─ #persistConversation()       ← SKIPPED (isSystemOrigin = true)
  ├─ EventBus.emit('tts:speak')   ← still fired
  ├─ Restore #messages.length     ← finally block -- zero residue, even when the LLM call fails
  └─ Return response to UI        (or rethrow so the automation can degrade visibly)

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
# Conversation cache TTL -- human-readable duration ("45s", "15m") or plain seconds
# (default: 900 = 15 minutes)
conversation_ttl_sec: "15m"

# Maximum messages kept in conversation history (default: 20)
max_conversation_turns: 20

# Per-request LLM HTTP timeout -- human-readable duration ("45s", "5m") or plain ms
# (default: 300 s). Local models on modest hardware can exceed a minute per completion;
# raise this if you see "Fetch timed out" errors under load.
fetch_timeout_ms: "5m"
```

To make conversations expire faster, reduce `conversation_ttl_sec`. Automated announcements are produced by rule-based automations rather than a built-in messenger -- control their cadence per automation (`timer_interval`, `silence_between`; see [weatherman example](../examples/weatherman.md)).

---

## Concurrency

`processMessage()` serializes turns through an internal FIFO chain: concurrent callers (interactive chat input vs periodic automation ticks) each receive their own promise and run strictly one-after-another in request order, so pushes into the shared message array and tool loops never interleave. A failing turn still releases the queue for the next caller. On the provider side, every HTTP request owns its AbortController and deadline locally -- overlapping requests cannot clear or abort each other's timers.

---

## File Map

| Component | File Path |
|-----------|-----------|
| AiAssistant (orchestrator, persistence logic) | `src/ai/aiAssistant.js` |
| ChatMessageOrigin enum | `src/enum/aiChatMessageOrigin.js` |
| CacheService (Redis client) | `src/service/cacheService.js` |
| AiWindow (UI display) | `src/ui/windows/aiWindow.js` |

---

## Related Documentation

| Document | Relation |
|----------|----------|
| [Automation vs Human Differentiation](./automation-human-differentiation.md) | Sibling deep-dive: how command provenance and origin classification work |
| [TTS Weather Man example](../examples/weatherman.md) | Consumer of system-originated announcements discussed here |
| [Architecture Overview](./index.md) | Project structure and core concepts |