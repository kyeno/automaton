# AI Conversation Caching

User chat history is saved in Redis at `ai:conversation:default` and restored at startup
with a fresh system prompt. Automated announcements do not persist or extend its TTL.

## Configuration

In `etc/automaton.yaml`:

```yaml
ai:
  conversation_ttl: "15m"
  max_conversation_turns: 20
  fetch_timeout: "5m"
  include_chat_history_in_system_calls: false
```

| Key | Effect |
|-----|--------|
| `conversation_ttl` | Cache expiry; duration string or milliseconds (converted to Redis seconds) |
| `max_conversation_turns` | Maximum retained non-system messages; oldest dropped first |
| `fetch_timeout` | HTTP request deadline; duration string or milliseconds; timeout is not retried |
| `include_chat_history_in_system_calls` | Give announcements prior chat context; default `false` |

Each successful user exchange refreshes the cache TTL after tool calls finish.
The system prompt is preserved in memory but excluded from the cached messages.

## System vs User Origin

| `_origin` | Source | Retained after the turn? | Cached? |
|-----------|--------|--------------------------|---------|
| `user` | Human chat | Yes | Yes |
| `system` | Automated announcement | No | No |

Call `processMessage(text, { origin: 'system' })` for announcements. The origin applies
to the entire turn, including assistant replies, tool results, and fallback messages.

System turns use a fresh system prompt by default. With
`include_chat_history_in_system_calls: true`, they read existing chat history instead.
Both paths restore the previous message state in `finally`, including on failure.
They skip trimming and persistence; persistence also filters legacy system-origin messages.
UI output and TTS still run normally.

## Concurrency

`processMessage()` runs turns through a FIFO queue. A failed turn releases the queue.
Each provider request has its own abort controller and deadline.

## File Map

| Component | Path |
|-----------|------|
| Assistant and persistence | `src/ai/aiAssistant.js` |
| Origin enum | `src/enum/aiChatMessageOrigin.js` |
| Redis client | `src/service/cacheService.js` |
| UI transcript | `src/ui/windows/aiWindow.js` |
| Isolation tests | `tests/test-ai-conversation-isolation.js` |

Related: [Weather Man](../automations/weatherman.md) · [Configuration](../configuration.md)
