# AI (Large Language Model) Integration

Automaton connects to any OpenAI-compatible API endpoint for its chat assistant. The AI can query device states, control devices via function calling, and converse in multiple languages through i18n-aware prompts.

## Requirements

- An LLM inference server exposing an **OpenAI-compatible** `/v1/chat/completions` endpoint
- `.env` variable `AI_API_URL` pointing to your server
- A model capable of reliable JSON function calling (see recommendations below)

## Configuration

### Environment Variable

Add to `.env`:

```env
AI_API_URL=http://your-llm-server:port/v1/chat/completions
```

If this variable is not set, the AI feature is disabled at startup with a warning message. You can get the same effect for a single run by starting Automaton with `--no-ai`, which overrides any configured AI settings.

### Main Config

In `etc/automaton.yaml`, the `[ai]` section controls behavior:

```yaml
ai:
  model: "gemma-4-e2b-it"
  temperature: 0.7
  max_tokens: 2048
  system_prompt_file: "etc/i18n/en_US/ai.yaml"
  conversation_cache_ttl: 3600
  origin_filter: true
```

See [Configuration Guide](../configuration.md#ai-section) for every option explained.

## Recommended Models

Automaton has been tested and proven stable against the **gemma-4-E2B-it** model family — a compact model capable of i18n-aware prompts and reliable tool calling. This is recommended as the smallest option that handles both multilingual conversations and structured function calls.

Other models may work but are untested; reliability depends on their function-calling implementation quality.

## Example Setups

### llama.cpp

Run locally via its built-in OpenAI-compatible server:

```bash
./llama-server \
    --model /path/to/gemma-4-e2b-it.Q4_K_M.gguf \
    --host 0.0.0.0 \
    --port 8080 \
    --embedding \
    --function-call
```

Then set `AI_API_URL=http://localhost:8080/v1/chat/completions`.

### Ollama

Pull and run a compatible model:

```bash
ollama pull gemma:2b
ollama serve # defaults to localhost:11434
```

Then set `AI_API_URL=http://localhost:11434/v1/chat/completions` (Ollama's proxy endpoint).

### vLLM

For larger models with GPU acceleration:

```bash
vllm serve /path/to/model \
    --host 0.0.0.0 \
    --port 8000 \
    --api-key dummy
```

Then set `AI_API_URL=http://localhost:8000/v1/chat/completions`.

## Conversation Caching

Automaton caches AI conversations in Redis for persistence across restarts. Cached entries are tagged by origin so that AI-generated echoes can be distinguished from human interactions during replay. See [AI Conversation Caching](../architecture/ai-conversation-caching.md) for details on TTL, filtering, and cache behavior.

## Automation vs Human Differentiation

Device commands dispatched by the AI chat assistant are classified as **human-directed input**, because a person gave the AI the order — only autonomous rule-engine actions count as automation. Every outgoing command carries an explicit provenance (`AUTOMATION` or `HUMAN`) and incoming MQTT reports are matched against causal tokens registered at dispatch time, so the system never confuses its own echoes with genuine user intervention. See [Automation vs Human Differentiation](../architecture/automation-human-differentiation.md) for the full policy, token verdicts, and cooldown behavior.

---

→ Back to [Installation & Requirements](./index.md) · Related: [TTS Integration](./tts-integration.md) · [STT Integration](./stt-integration.md) *(planned)*
