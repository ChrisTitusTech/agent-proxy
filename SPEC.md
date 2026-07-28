# agent-proxy specification

Last updated: 2026-07-28

## 1. Purpose

`agent-proxy` is a single-user Linux desktop gateway that exposes localhost
OpenAI- and Anthropic-compatible APIs in front of AI command-line agents.
Applications such as GitHub Copilot, Open WebUI, SDK clients, and local
automation send inference requests to the gateway. The gateway launches or
reuses the selected CLI agent inside the current user's Herdr session and
translates the result back to the caller's protocol.

The first-class backends are:

- Claude Code (`claude`)
- Codex (`codex`)
- Google Antigravity (`agy`)
- Grok Build (`grok`)

The project originates from
[starhunt/star-cliproxy](https://github.com/starhunt/star-cliproxy). This
specification defines the narrower contract for the `agent-proxy` refactor.

## 2. Product boundary

### 2.1 Goals

1. Run entirely as the logged-in desktop user.
2. Start the Herdr server and `agent-proxy` in that user's login session.
3. Require authentication for inference, model, and administration requests on
   a loopback listener by default; allow only a minimal unauthenticated
   liveness response.
4. Launch or reuse every selected CLI backend as a Herdr-managed agent.
5. Make API-originated agents visible and controllable in Herdr regardless of
   which local application submitted the request.
6. Reuse the current user's normal CLI authentication and configuration.
7. Preserve streaming, tool calls, cancellation, usage, and session identity
   across supported protocol translations.
8. Route model aliases to one or more CLI backends with bounded fallback.
9. Keep configuration, state, releases, logs, sockets, and credentials owned by
   the current user.
10. Keep source, documentation, logs, errors, and dashboard text English-only.

### 2.2 Non-goals

- Running a machine-wide or multi-user inference service.
- Creating a dedicated `agent-proxy` Unix account.
- Installing releases under `/opt` or mutable state under `/etc` or `/var`.
- Launching hidden provider processes outside Herdr.
- Adopting an already-running headless process into a Herdr terminal.
- Reimplementing the supported agent runtimes.
- Managing provider subscriptions or bypassing provider terms and quotas.
- Exposing a public multi-tenant API without a separate identity layer.
- Claiming compatibility before the relevant acceptance matrix passes.
- Treating health, model discovery, or admin requests as agent invocations.

## 3. User and ownership contract

One `agent-proxy` instance belongs to one interactive Linux user.

- The process UID and GID must match the user who owns the Herdr session.
- Provider children must run with that same UID and GID.
- Provider authentication must come from that user's normal home and XDG
  directories.
- The installer must not require root for normal install, upgrade, rollback,
  backup, or uninstall operations.
- Files created by the installer or runtime must remain owned by the current
  user.
- A second Linux user receives a separate configuration, database, proxy and
  admin keys, Herdr session, and proxy instance. Provider credentials remain
  in that user's CLI-owned state.
- Simultaneous user sessions must use independently configurable ports.

The supported locations are:

| Purpose | Default |
| --- | --- |
| Configuration | `${XDG_CONFIG_HOME:-$HOME/.config}/agent-proxy` |
| Releases and durable data | `${XDG_DATA_HOME:-$HOME/.local/share}/agent-proxy` |
| Operational state | `${XDG_STATE_HOME:-$HOME/.local/state}/agent-proxy` |
| Runtime sockets, jobs, and staged provider inputs | `${XDG_RUNTIME_DIR}/agent-proxy` |
| User service unit | `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user` |

Secrets and generated state must use owner-only permissions.

## 4. Herdr execution contract

### 4.1 Required behavior

Every authenticated data-plane request that selects a CLI provider, including a
configured generic CLI provider, must execute through the current user's Herdr
server.

The launcher must:

1. Connect to the expected Herdr server and verify protocol compatibility.
2. Create or reuse a dedicated `agent-proxy` workspace and API-agent tab.
3. Create or reuse a pane using the authenticated client/session identity,
   provider, and model.
4. Run the actual provider CLI in that pane as the current user.
5. Preserve structured stdout, stderr, exit status, and streaming events for
   the API adapter without scraping rendered terminal text.
6. Report provider, model, request ID, session ID, state, and elapsed time to
   Herdr without exposing prompts or credentials.
7. Map API cancellation, timeout, and proxy shutdown to the Herdr-managed
   process and wait for bounded termination.
8. Mark the pane terminal state exactly once and retain or close completed panes
   according to a configurable policy.

Health, model discovery, and admin-only requests must not spawn agents.

### 4.2 Availability

Herdr is a required runtime dependency for all CLI-provider inference,
including configured generic CLI providers.

- The Herdr server must start with the user's login session.
- `agent-proxy` must verify Herdr readiness before accepting inference work.
- If Herdr is unavailable or incompatible, inference returns an actionable
  `503` error.
- The proxy must not silently fall back to a direct headless spawn.
- Health output must distinguish API health from Herdr execution readiness.
- Authenticated readiness must include non-spawning executable checks for
  enabled providers and any already-tracked subscription-login state.

### 4.3 Sessions and panes

- Requests with the same explicit client session ID may reuse one compatible
  agent pane and provider thread.
- Requests without an explicit session ID must receive an isolated request
  session; the API key alone must not merge unrelated conversations.
- Model, provider, working-directory, or permission-profile changes invalidate
  incompatible reusable state.
- Concurrent turns for one pane must be serialized unless the provider proves
  safe concurrent execution.
- Different client sessions must never observe each other's terminal output,
  provider thread, tool results, or retained prompt state.
- Pane/session storage must have bounded size and configurable expiration.
- A pane created for a starting request is reserved until its worker is active
  or the start fails; concurrent capacity cleanup must not close it.
- Expired panes are closed and recreated rather than silently revived.

### 4.4 Recursion prevention

Before launching an agent, the proxy must reject configurations where the
child CLI would route its own model traffic back to the same `agent-proxy`
listener. Diagnostics must identify the conflicting provider configuration
without printing credentials.

When native Codex targets agent-proxy through the root Codex provider, Codex
children must select a distinct upstream profile. The current-user example
uses `agent_proxy_upstream`; child execution must never inherit the native
client's localhost provider selection.

## 5. API contract

### 5.1 Required endpoints

| Endpoint | Contract | Primary consumers |
| --- | --- | --- |
| `POST /v1/responses` | OpenAI Responses subset | Codex, Copilot SDK, OpenAI SDKs |
| `POST /v1/chat/completions` | OpenAI Chat Completions subset | Copilot CLI, Open WebUI |
| `POST /v1/messages` | Anthropic Messages subset | Claude Code, Anthropic SDKs |
| `GET /v1/models` | OpenAI model list | Discovery and client validation |
| `GET /health` | Minimal unauthenticated liveness only | Probes |
| `GET /admin/health` | Authenticated API, Herdr, and provider readiness | Operators |
| `/admin/*` | Authenticated management API | Dashboard and automation |

Unsupported embedding, retrieval, speech, image-generation, and reranking
capabilities must not be advertised for CLI providers.

### 5.2 Definition of compatible

An endpoint is compatible with a target client only when:

1. The unmodified client can use the documented base URL and proxy credential.
2. Non-streaming and streaming text pass end-to-end.
3. One complete function-tool loop passes when tools are advertised.
4. A direct client disconnect terminates the Herdr-managed provider process.
   If an intermediary accepts cancellation without closing its upstream
   request, the proxy may use a configured bounded detach: provider work
   remains tracked until exit or timeout, its pane remains working until that
   terminal state, and the logical request is accounted exactly once with the
   detach outcome recorded.
5. Errors use the expected status, content type, and protocol shape.
6. Concurrent sessions remain isolated.
7. The agent appears in Herdr for the full provider execution.
8. Client and Herdr versions are pinned in sanitized acceptance evidence.

### 5.3 OpenAI Responses

`POST /v1/responses` must support:

- `model`
- string or item-array `input`
- `instructions`
- `stream`
- function tools and `tool_choice`
- supported reasoning fields
- `max_output_tokens`
- `previous_response_id` or the documented session mechanism

Streaming must use valid Server-Sent Events with exactly one terminal
`response.completed`, `response.incomplete`, or `response.failed` event. Tool
calls and results must round-trip without changing IDs or arguments.

### 5.4 Chat Completions

`POST /v1/chat/completions` must support ordered messages, supported content
parts, streaming, function tools, tool choice, token limits, and reasoning
fields. Roles, tool IDs, tool results, finish reasons, usage, and SSE framing
must remain compatible.

### 5.5 Anthropic Messages

`POST /v1/messages` must support messages, system content, streaming, tools,
tool choice, token limits, and supported thinking configuration. Tool-use and
tool-result blocks, images, stop reasons, usage, and event order must survive
translation.

## 6. Client contract

### 6.1 GitHub Copilot

Copilot CLI and supported Copilot applications may connect as an
OpenAI-compatible provider at `http://127.0.0.1:8300/v1`. The acceptance matrix
must cover model discovery where applicable, streaming, tool calling,
cancellation, session isolation, and Herdr visibility.

### 6.2 Open WebUI

Open WebUI must connect through its normal OpenAI-compatible settings without a
custom Pipe. Optional capabilities that the CLI providers do not implement
must use separately configured services. Background model requests must be
disabled or explicitly routed and accounted for.

### 6.3 Native agent clients

Native Claude Code, Codex, and Grok clients may target the compatible proxy
endpoint. A native client calling `agent-proxy` and the provider CLI launched by
the proxy are separate processes. The child must use a configuration that
reaches the upstream provider rather than recursively calling the proxy.

## 7. Provider contract

Every built-in provider must implement:

- Stable provider and model identity.
- Configuration and executable validation.
- Authentication-readiness reporting.
- Herdr-managed non-streaming and streaming execution.
- Timeout, abort, and process-tree cleanup.
- Compatible errors with secrets and user paths redacted.
- Explicit capability metadata.
- Model and reasoning translation.

Direct `child_process.spawn` execution is allowed only inside the
Herdr-launched worker that owns the pane. Route handlers and provider adapters
must not bypass the Herdr launcher.

Generic CLI providers inherit the same Herdr execution, cancellation, queue,
session-isolation, and recursion-prevention requirements.

## 8. Routing and accounting

1. A public model alias maps to ordered provider/model targets.
2. Disabled or unhealthy targets are skipped according to documented policy.
3. Queueing, retry, and fallback are bounded.
4. One logical request is counted once across retries and fallback.
5. Every provider attempt is correlated with its Herdr pane and request ID.
6. A provider failure may fall back only after the first pane reaches a
   terminal state.
7. Queue saturation returns a retryable error without creating a pane.

## 9. Security

Running providers as the desktop user is an explicit trust decision.

- The listener defaults to `127.0.0.1`.
- An unauthenticated `GET /health` response is limited to generic liveness.
  Provider names, Herdr readiness, versions, paths, and configuration require
  authentication.
- Data-plane and admin tokens remain independent.
- API keys are stored as one-way hashes.
- Empty, weak, or placeholder production credentials fail startup.
- Local processes are not automatically trusted merely because they share the
  user's UID.
- Provider arguments use arrays and never shell interpolation.
- Job control files and sockets use owner-only permissions under
  `XDG_RUNTIME_DIR`.
- Provider environments use allowlists.
- Prompts and raw output are not durably retained by default. Bounded in-memory
  normalized input and output retained for Responses
  `previous_response_id` continuation is the explicit exception; `store:
  false` disables retention of the new response.
- Logs and Herdr metadata never contain provider tokens, proxy keys, prompt
  bodies, account identifiers, or unsanitized home paths.
- Chat-only and tool-enabled profiles are separate and explicit.

The threat model must cover malicious localhost applications, prompt
injection, command execution, filesystem access as the desktop user, Herdr
socket control, cross-session leakage, recursion, and denial of service.

## 10. Login-session operations

The supported deployment uses systemd user services or an equivalent
login-session supervisor.

- Herdr starts before `agent-proxy` accepts inference requests.
- Normal startup does not require root or lingering after logout.
- Logging out may stop the proxy and its agents after bounded cleanup.
- Upgrade and rollback preserve user configuration, proxy keys, mappings,
  provider authentication, and SQLite state.
- The Herdr user service starts the executable selected by `herdr.binary`.
- Upgrade validates legacy configuration before switching `current`; removed
  execution-mode keys are ignored with an actionable migration warning.
- If unit installation, reload, enablement, or startup fails after activation,
  the installer restores the prior release, units, and running state.
- Shutdown stops new work, cancels or drains active panes within a bound,
  closes SQLite, and exits without orphaned workers.
- The operator can inspect both services with `systemctl --user` and
  `journalctl --user`.

## 11. Dashboard and observability

The dashboard remains optional and must:

- Authenticate with the admin token.
- Show Herdr readiness and compatibility.
- List active and retained API-originated agent panes.
- Distinguish unavailable executables, missing login, expired login, quota,
  upstream, timeout, and Herdr failures.
- Manage keys, mappings, limits, and supported provider settings.
- Avoid becoming a data-plane dependency.

Metrics and logs must correlate endpoint, request ID, model alias, provider,
Herdr pane, queue time, execution time, fallback, cancellation, and terminal
state without prompt content.

## 12. Quality gates

Every release must pass:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint:dead-code
scripts/validate-shell.sh
git diff --check
```

The user-owned Herdr runtime additionally requires:

- Installer lifecycle tests using isolated XDG directories.
- systemd user-unit verification.
- A fake-provider Herdr launcher contract suite.
- Streaming, cancellation, timeout, and shutdown tests.
- A real Herdr smoke test under the current user.
- Copilot CLI and Open WebUI localhost acceptance.
- Proof that every provider attempt appears in Herdr.
- Proof that no direct headless provider spawn remains.
- A clean dead-code report with documented dynamic entry points.
- Provider stress and live shared-pane load tests.

## 13. Open decisions

1. Define the client-session derivation used when a client cannot send
   `X-Agent-Proxy-Session-Id`.
2. Define the minimum supported Herdr and provider CLI versions.
3. Confirm upstream licensing, attribution, and notice obligations.
