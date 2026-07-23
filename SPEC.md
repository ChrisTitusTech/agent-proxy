# agent-proxy specification

## 1. Purpose

`agent-proxy` is a Linux server that exposes stable HTTP APIs in front of
locally installed AI command-line tools. A client sends an OpenAI- or
Anthropic-compatible request, the server selects a configured CLI backend,
executes it under the service account, and translates the result back into the
client's expected protocol.

The first-class backends are:

- Claude Code (`claude`)
- Codex (`codex`)
- Google Antigravity (`agy`)
- Grok Build (`grok`)

The project originates from
[starhunt/star-cliproxy](https://github.com/starhunt/star-cliproxy). This
specification defines the narrower contract for the `agent-proxy` refactor.

## 2. Product goals

1. Run as a durable, non-root Linux service.
2. Present drop-in API endpoints to Claude Code, Codex, Grok Build, OpenAI
   SDKs, and Anthropic SDKs.
3. Reuse CLI authentication already established for the service account.
4. Route model aliases to one or more CLI backends with ordered fallback.
5. Preserve streaming, tool calls, usage metadata, cancellation, and session
   identity across protocol translation where the backend supports them.
6. Protect the service with API keys, rate limits, input validation, secret
   redaction, and safe child-process execution.
7. Provide enough health and request telemetry to operate the service without
   exposing prompts or credentials by default.
8. Keep source, documentation, logs, errors, and the dashboard English-only.

## 3. Non-goals

- Reimplementing the Claude Code, Codex, Antigravity, or Grok agent runtimes.
- Managing provider accounts, subscriptions, browser login, or credential
  refresh.
- Circumventing provider terms, quotas, billing, or technical restrictions.
- Providing public multi-tenant hosting without an external identity layer.
- Claiming protocol compatibility before the relevant acceptance suite passes.
- Supporting legacy Gemini CLI or GitHub Copilot CLI as built-in backends.
- Treating the dashboard as a required data-plane dependency.

## 4. Users

### 4.1 Operator

Installs and authenticates supported CLIs, configures the service, manages
model mappings and keys, and monitors health.

### 4.2 API client

Uses an existing SDK or CLI against `agent-proxy` by changing its base URL and
credential. The client should not require application code changes for the
supported subset of its native protocol.

## 5. Compatibility contract

### 5.1 Required endpoints

| Endpoint | Contract | Primary consumers |
| --- | --- | --- |
| `POST /v1/responses` | OpenAI Responses API subset | Codex, Grok, OpenAI SDKs |
| `POST /v1/chat/completions` | OpenAI Chat Completions subset | General OpenAI-compatible clients |
| `POST /v1/messages` | Anthropic Messages API subset | Claude Code, Anthropic SDKs |
| `GET /v1/models` | OpenAI model list | Discovery and client validation |
| `GET /health` | Service and provider summary | Probes and operators |
| `/admin/*` | Authenticated management API | Dashboard and automation |

### 5.2 Definition of drop-in

An endpoint is called drop-in only when all of the following are true:

1. The unmodified target client can be pointed at the server through its
   documented base URL and credential settings.
2. Non-streaming text requests pass an end-to-end acceptance test.
3. Streaming events are valid for the client protocol and arrive incrementally
   when the backend provides incremental output.
4. Function or tool calls round-trip through at least one complete tool loop.
5. Client cancellation terminates or safely detaches from the backend process.
6. Protocol errors use the expected HTTP status, content type, and error shape.
7. Multi-turn identity is isolated between distinct client sessions.
8. Compatibility is tested against pinned and documented client versions.

### 5.3 Responses API requirements

`POST /v1/responses` must accept at least:

- `model`
- `input` as a string or input-item array
- `instructions`
- `stream`
- `tools` with function tools
- `tool_choice`
- `max_output_tokens`
- `previous_response_id` or an equivalent documented session mechanism

Non-streaming responses must include a stable response ID, status, model,
output items, text content, and usage when available.

Streaming responses must use Server-Sent Events and maintain valid event order.
At minimum, the adapter must support response creation, output item creation,
content part creation, text deltas, completed text, completed output items, and
a terminal completed or failed response event.

The reference contract is the
[OpenAI Responses API streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal/delta).
Codex custom providers use a configurable `base_url` and Responses wire
protocol, as represented by the
[official Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json).

### 5.4 Chat Completions requirements

`POST /v1/chat/completions` must accept:

- `model`
- ordered `messages`
- text and supported image content parts
- `stream`
- function `tools` and `tool_choice`
- `max_tokens`
- `temperature`
- supported reasoning-effort fields

The adapter must preserve roles, tool call IDs, tool results, finish reasons,
usage, and OpenAI-compatible SSE framing.

### 5.5 Anthropic Messages requirements

`POST /v1/messages` must accept:

- `model`
- `messages`
- `system`
- `stream`
- `tools` and `tool_choice`
- `max_tokens`
- supported thinking configuration

Streaming must use Anthropic event names and ordering. Tool-use content blocks,
tool-result inputs, stop reasons, and usage must survive conversion.

Claude Code gateway configuration is based on Anthropic's documented
[`ANTHROPIC_BASE_URL` gateway support](https://docs.anthropic.com/en/docs/claude-code/llm-gateway).

### 5.6 Grok client compatibility

Grok Build must be able to select an `agent-proxy` custom model with a
configured `base_url` and environment-backed key. This follows xAI's documented
[custom model configuration](https://docs.x.ai/build/overview).

## 6. Provider contract

Every provider must implement:

- A stable provider name.
- Configuration validation.
- Health detection without consuming a model request when possible.
- Non-streaming execution.
- Streaming execution or an explicitly marked buffered fallback.
- Timeout and abort handling.
- Child-process cleanup.
- Debug metadata with secrets redacted.
- Model and reasoning-option translation.

### 6.1 Claude Code

Supported modes may include CLI print mode, Claude Agent SDK, and the managed
channel worker. Mode-specific state must not leak between clients.

### 6.2 Codex

Supported modes may include `codex exec`, `codex exec resume`, and persistent
`codex app-server`. Resume and app-server sessions must be keyed by an explicit
client session ID plus model.

### 6.3 Google Antigravity

Antigravity remains a first-class backend. The adapter must pass the exact
model display name expected by the installed CLI and must clearly label its
buffered streaming fallback when the CLI does not emit incremental output.

### 6.4 Grok Build

The adapter must support headless execution, model selection, reasoning effort,
plain-text parsing, and buffered streaming fallback when incremental output is
not available.

## 7. Routing and sessions

1. A public model alias maps to one or more provider/model targets.
2. Lower numeric priority is attempted first.
3. Disabled or unhealthy providers are skipped according to a documented
   policy.
4. Fallback must not double-charge global or per-key rate limits.
5. A client session identifier must be accepted through
   `X-Agent-Proxy-Session-Id`.
6. The server must never merge two explicit client session identifiers.
7. Session state must have a configurable time-to-live and bounded storage.
8. Model changes invalidate incompatible provider sessions.

## 8. Security

### 8.1 Authentication

- Data-plane endpoints accept bearer tokens and Anthropic-style `x-api-key`.
- Admin endpoints use a separate admin token.
- Stored API keys are one-way hashed.
- Secret comparisons are timing safe.
- Empty production credentials fail startup.

### 8.2 Process safety

- Provider executables are configured as paths, not shell command strings.
- Arguments are passed as arrays without shell interpolation.
- Built-in executable paths cannot be changed through the runtime admin API.
- The service runs as a dedicated non-root user.
- Working directories are explicit and constrained by operator policy.
- Child processes receive only the environment variables they require.

### 8.3 Data handling

- Prompts and raw provider output are not retained unless debug capture is
  explicitly enabled.
- Debug records redact API keys, authorization headers, cookies, tokens, and
  known provider secret formats.
- Logs have configurable retention.
- Exports do not include recoverable credentials.

## 9. Linux operations

The supported production deployment is a systemd service on a current Linux
distribution.

Required operational behavior:

- Configuration is loaded from an operator-owned file and environment file.
- State and logs use Linux filesystem hierarchy locations selected at install
  time.
- Startup validates configuration, required directories, credentials, and
  enabled CLI executables before listening.
- `SIGTERM` stops new work, aborts or drains active requests within a bounded
  grace period, terminates children, flushes state, and exits.
- Health checks distinguish server health from individual provider health.
- A documented reverse-proxy example provides TLS and request-size limits.
- Upgrade and rollback procedures preserve configuration and SQLite data.

Containers are optional. A container deployment must explicitly provide CLI
binaries and the authenticated service-user state; it must not imply that host
credentials are automatically available.

## 10. Configuration

Configuration precedence is:

1. Built-in defaults.
2. YAML configuration.
3. Environment substitution for secrets and deployment-specific values.
4. Validated runtime overrides stored in SQLite.

Unknown keys may be ignored for forward compatibility, but invalid known
values must fail startup with a path-specific English error.

The example configuration must include only supported built-in providers and
must never contain real credentials.

## 11. Observability

Each request receives a request ID. Metrics and logs must expose:

- Endpoint and response status.
- Selected public model alias.
- Provider and actual model.
- Queue time and execution latency.
- Fallback attempts.
- Token usage when reported or clearly marked estimates when inferred.
- Cancellation and timeout reason.
- Active request and queue depth counts.

Health, metrics, and normal logs must not include prompt bodies.

## 12. Dashboard

The dashboard is an optional operator interface over `/admin/*`. It must:

- Remain English-only.
- Require the admin token.
- Show provider health, active requests, recent errors, and usage.
- Manage keys, model mappings, rate limits, and allowed provider settings.
- Clearly distinguish persisted settings from restart-required settings.
- Avoid becoming a runtime dependency of data-plane endpoints.

## 13. Quality gates

Every release must pass:

```bash
npm ci
npm run typecheck
npm test
npm run build
bash -n start.sh
```

Additional release gates:

- No Hangul text remains in shipped source or documentation.
- No references to removed built-in providers remain in defaults or UI lists.
- No secrets are present in tracked files.
- API contract tests cover success, streaming, tool calls, cancellation, and
  protocol error shapes.
- End-to-end tests cover supported versions of Claude Code, Codex, and Grok
  against a real Linux service.
- Antigravity backend smoke tests run when the CLI is available.

## 14. Open decisions

1. Confirm and add the correct license file before redistribution.
2. Define the minimum supported versions of all four CLIs.
3. Decide whether generic CLI and HTTP adapters remain in the first stable
   release or move to a later extension package.
4. Choose the production reverse proxy and packaging format.
5. Define how Responses `previous_response_id` maps to provider-specific
   sessions and retention.
