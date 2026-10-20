# Email Notifications

EmailService sends locale-templated plain-text notifications to `house_owners` over SMTP. Delivery is independent of speech silence and AI/TTS availability.

The service owns four things:

- **The SMTP transport**, built from the `SMTP_*` secrets in `.env`.
- **The recipient list**, read from `house_owners:` in `etc/automaton.yaml`.
- **The templates**, loaded from `etc/i18n/<locale>/email.yaml` in the active locale.
- **A per-kind cooldown** limiting repeated requests of the same notification kind. The frozen-sensor monitor separately tracks each incident so voice reminders never request more mail.

## How a Notification Becomes a Mail

Call `EmailService.notify()` with a kind, message, and optional tokens/meta:

```js
await EmailService.notify({
    kind: 'sensor_frozen',
    message: 'Soil probe Gerbera has not moved in 24h.',
    tokens: { frozen_sensors: 'Gerbera (40%)' },
    meta: { frozen_count: 1 },
})
```

The service then:

1. Checks the **per-kind switch** (`email.notify.<kind>`). A kind set to `false` never mails; a kind with no switch is allowed.
2. Checks the **per-kind cooldown** (`email.cooldown`). The marker lives in Redis (`mail:cooldown:<kind>`) so it survives a restart; a Redis outage falls back to an in-memory timestamp and fails open.
3. Resolves the **locale template section** for the kind from `etc/i18n/<locale>/email.yaml`.
4. Renders the **subject** (prefix + template line) and the **body** (greeting, the announcement message, signature, footer).
5. Queues one copy per owner on a single FIFO chain and returns immediately — a slow or dead relay can never block the caller.

The body wraps the supplied message with the locale greeting and signature. Frozen-sensor notifications use the AI response when `use_ai` is enabled, including during quiet hours, without voicing the email request. If AI is unavailable, fails, or returns an empty reply, the existing plain TTS sentence becomes the email body. The signature places the assistant name and `Automaton {% short_commit_sha %}` on separate lines; the revision is resolved from the running checkout at startup (`unknown` when Git metadata is unavailable).

Unresolved `{% placeholder %}` tokens are removed.

## Configuration

The relay connection and its credentials are secrets and stay in `.env`; every behavioural setting lives in `etc/automaton.yaml`.

### `.env` (secrets)

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | Relay hostname. **Unset = the whole channel is disabled.** |
| `SMTP_PORT` | Relay port (default `465`). |
| `SMTP_SECURE` | `true` (TLS) or `false` (plain). Default `true`. |
| `SMTP_USER` | Login address. Also the sender fallback when `email.from` is empty. |
| `SMTP_PASS` | Login password. |

### `etc/automaton.yaml` (behaviour)

```yaml
house_owners:                     # who gets the mail
  - name: 'Anna'
    email: 'anna@example.com'

email:
  enabled: true                   # false disables the channel even with a relay set
  from: ''                        # sender address; falls back to SMTP_USER when empty
  subject_prefix: 'Automaton'     # prepended to every subject: "Automaton: <subject>"
  cooldown: "60m"              # per-kind silence after one notification; 0 = mail every event
  notify:                        # per-kind switches; a kind set to false never mails
    sensor_frozen: true
```

- **`house_owners`** — a list of `{ name, email }` (a bare address string is also accepted). Entries without a well-formed address are dropped, not mangled. A missing name falls back to the local part of the address.
- **`email.enabled`** — the master switch. `false` disables the channel even when `SMTP_HOST` is set.
- **`email.from`** — the sender address. When empty, `SMTP_USER` is used.
- **`email.subject_prefix`** — prepended to every subject. Empty string drops the prefix.
- **`email.cooldown`** — the per-kind re-notification window. `0` mails every event.
- **`email.notify`** — a map of kind → boolean. A kind set to `false` is muted; a kind with no entry is allowed.

## The `/mail` Command

The terminal UI exposes the channel through `/mail` (alias `/email`):

| Command | Effect |
|---------|--------|
| `/mail status` | Relay, sender, owners, kind switches and the send counters. Secrets are never shown. |
| `/mail test [address]` | Queue the configuration-check mail to the owner list, or to one explicit address. |
| `/mail help` | Usage. |

Test mail uses the `test` template and bypasses notification cooldowns.

## Delivery Model

- Sends are queued on a **single FIFO chain** and delivered one at a time (`maxConnections: 1`). A slow relay serialises delivery instead of dropping order, and it can never block an automation's `execute()`.
- The queue is capped at **25 pending** messages; deeper queues are dropped with a warning and counted as `skipped`.
- Every delivery updates the counters returned by `getStats()`: `sent`, `failed`, `skipped`.
- `flush()` awaits the current queue (used at shutdown and by tests); `cleanup()` unsubscribes and closes the transport.

## The `notify:email` Channel

Any component can request a mail without importing the service by emitting on the shared `notify:email` EventBus channel with the same `{ kind, message, tokens, meta }` payload. The service subscribes once at init and routes the payload through `notify()`.

## Component Paths

| Component | Path |
|-----------|------|
| Service | `src/service/emailService.js` |
| Announcement pipeline (email leg) | `src/lib/announcementPipeline.js` |
| `/mail` command | `src/ui/commands/mailCmd.js` |
| Config schema | `src/validators/main.js` (`email`, `house_owners`) |
| Templates | `etc/i18n/<locale>/email.yaml` (+ `.dist`) |
| Relay secrets | `.env` (`SMTP_*`) |
| Tests | `tests/test-email-service.js`, `tests/test-frozen-sensor-monitor.js` |

---

→ [Documentation Home](../index.md) · Related: [Configuration Guide](../configuration.md) · [TTS Gardener](../automations/gardener.md) · [Offline Alerts](../monitors/offline-alerts.md)