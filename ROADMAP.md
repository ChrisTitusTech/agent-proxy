# agent-proxy roadmap

This roadmap implements [SPEC.md](./SPEC.md) in small phases. A phase is
complete only when its acceptance criteria and validation commands pass.

## Phase 0: Repository cleanup

Status: Complete

Scope:

- Rename the project from `star-cliproxy` to `agent-proxy`.
- Credit the upstream `starhunt/star-cliproxy` project.
- Make source, documentation, errors, tests, configuration, and dashboard copy
  English-only.
- Keep Claude Code, Codex, Google Antigravity, and Grok as built-in CLIs.
- Remove legacy Gemini and Copilot provider implementations.
- Remove the unused plugin loader, old analyses, historical plans, duplicate
  Korean documentation, and superseded POCs.
- Add a focused README, example environment, specification, and roadmap.

Acceptance criteria:

- `rg` finds no Hangul text in shipped files.
- Built-in provider registries and defaults contain exactly the four supported
  CLIs.
- The package lock matches the renamed workspaces.
- Typecheck, tests, build, and shell validation pass.

Validation:

```bash
npm ci
npm run typecheck
npm test
npm run build
bash -n start.sh
```

Pause point: review the reduced repository and product boundary before changing
wire-protocol behavior.

## Phase 1: Linux service baseline

Status: Complete

Scope:

- Add a production installer or package layout.
- Add a hardened systemd unit and environment file template.
- Run as a dedicated non-root service user.
- Validate enabled CLI binaries and writable state paths at startup.
- Implement graceful shutdown with a bounded drain timeout.
- Document install, upgrade, rollback, backup, and uninstall procedures.

Acceptance criteria:

- A clean Linux VM can install, start, stop, restart, and upgrade the service.
- Service restart preserves configuration, keys, mappings, and SQLite data.
- `systemd-analyze security` findings are reviewed and documented.
- Termination leaves no provider child processes.
- An external health probe passes after restart.

Rollback: retain the previous binary/package and a pre-upgrade SQLite backup.

Validation evidence is tracked in [TASKS.md](./TASKS.md), including the
installer lifecycle, restart persistence, external health probe, provider
process-group termination, release preflight, and systemd security review.

## Phase 2: OpenAI Responses compatibility

Status: Complete

Scope:

- Move `/v1/responses` from the application bootstrap into a dedicated route.
- Define request and response schemas.
- Preserve instructions, input items, function tools, tool choice, reasoning
  settings, and output items.
- Implement valid Responses SSE event ordering and terminal errors.
- Define response IDs, `previous_response_id`, and session retention.
- Add cancellation, timeout, and retry semantics.

Acceptance criteria:

- OpenAI SDK Responses calls pass for streaming and non-streaming text.
- One complete function-tool loop passes.
- Invalid requests return compatible error objects and HTTP status codes.
- Disconnecting a client terminates or detaches from the provider safely.
- Responses contract tests are provider-independent.

Pause point: do not call the endpoint drop-in compatible until the Codex and
Grok client tests in Phase 3 pass.

## Phase 3: Native CLI and Open WebUI compatibility

Status: Planned

Scope:

- Test Claude Code against `/v1/messages`.
- Test Codex against `/v1/responses` with a custom model provider.
- Test Grok Build against `/v1/responses` with a custom model.
- Test a pinned Open WebUI release against `/v1/models` and
  `/v1/chat/completions`.
- Validate Codex ChatGPT and supported Grok subscription logins from the same
  service account and `HOME` used by systemd.
- Test Open WebUI in native, Docker, and Podman connection topologies.
- Document exact supported client versions and configuration.
- Add protocol fixtures captured from non-secret test sessions.
- Document Open WebUI background model requests and separate configuration for
  embeddings, retrieval, speech, and image generation.

Acceptance criteria:

- Unmodified Claude Code completes a text request and one tool loop.
- Unmodified Codex completes a coding request and one tool loop.
- Unmodified Grok completes a coding request and one tool loop.
- Open WebUI discovers Codex and Grok aliases without a custom Pipe.
- Open WebUI completes non-streaming text, streaming text, cancellation, and
  one advertised function-tool loop.
- Concurrent Open WebUI chats cannot observe each other's provider session
  context.
- Missing and expired subscription logins produce actionable, sanitized
  reauthentication errors.
- Native, Docker, and Podman connection instructions pass against the supported
  host matrix.
- Streaming output renders incrementally in every client that supports it.
- Two concurrent client sessions cannot observe each other's context.
- Compatibility failures identify the unsupported field or event.

Rollback: keep Chat Completions available while Responses compatibility
stabilizes.

## Phase 4: Provider reliability

Status: Planned

Scope:

- Normalize provider lifecycle, timeout, abort, and cleanup behavior.
- Add bounded queues and backpressure.
- Classify retryable and non-retryable failures.
- Harden Codex resume and app-server concurrency.
- Harden Claude SDK and channel-worker isolation.
- Validate Antigravity model labels at startup.
- Add native Grok streaming when supported by the installed CLI.
- Classify executable, authentication, quota, upstream, and model-availability
  failures separately.
- Bound Open WebUI background-request amplification and account for every
  generated provider request.

Acceptance criteria:

- Queue saturation returns a documented status without process growth.
- Provider crashes do not crash the API server.
- Every request reaches one terminal state.
- Retry and fallback do not duplicate global or per-key accounting.
- Authentication expiry does not crash the service and recovery does not
  require replacing the proxy API key.
- Buffered providers are labeled accurately and produce one valid terminal
  stream sequence.
- Stress tests leave no zombie or orphan provider processes.

Rollback: keep the last validated provider mode available, disable new session
reuse or native-streaming paths independently, and retain bounded queues and
process cleanup during rollback.

## Phase 5: Security and privacy

Status: Planned

Scope:

- Add startup checks for weak or empty secrets.
- Minimize the environment inherited by child processes.
- Add configurable debug retention and secure defaults.
- Audit export/import for credential leakage.
- Add request-size, prompt-size, and concurrency abuse tests.
- Publish reverse-proxy TLS and firewall examples.
- Define a chat-only provider profile with a dedicated working directory and
  constrained filesystem, command, and network access.
- Define a separate opt-in tool-enabled profile and document the trust boundary
  between Open WebUI tools and provider-native CLI tools.
- Verify hardened systemd settings still permit only the required CLI
  executable, credential, state, and network access.

Acceptance criteria:

- Secret scanning finds no committed credentials.
- Redaction tests cover all supported provider credential formats.
- Debug capture is disabled by default.
- Admin and data-plane credentials are independently revocable.
- Open WebUI receives only a proxy key and cannot read provider credential
  stores.
- Chat-only acceptance tests cannot modify the repository or unrelated host
  paths.
- A documented threat model covers prompt injection, command injection, SSRF,
  cross-session data leakage, and denial of service.

Pause point: review the chat-only defaults, tool-enabled opt-in, service
hardening, and Open WebUI network exposure before changing production
permission defaults.

## Phase 6: Observability and operations

Status: Planned

Scope:

- Add structured JSON logging for production.
- Add Prometheus-compatible metrics.
- Distinguish process, provider, queue, and dependency health.
- Add database backup and restore commands.
- Add an operator runbook for common failures.
- Add sanitized provider-authentication readiness and reauthentication
  diagnostics.
- Add deployment diagnostics for Node.js runtime mismatch, inaccessible CLI
  paths, wrong service-account `HOME`, container networking, and Open WebUI
  model-discovery failures.
- Document how to control or reroute Open WebUI background model requests.

Acceptance criteria:

- Metrics expose request rate, latency, failures, fallbacks, queue depth, active
  requests, and provider availability.
- Logs correlate a request across routing and provider execution without prompt
  content.
- Health and diagnostics distinguish missing login, expired login, quota
  exhaustion, upstream outage, and executable failure where the CLI supports
  that distinction.
- Backup and restore are verified on a fresh instance.
- Alert examples cover service down, provider down, queue saturation, and
  repeated authentication failures.
- The Open WebUI runbook recovers model discovery, chat, and streaming from
  each documented failure without exposing subscription credentials.

Rollback: keep metrics exporters and enhanced diagnostics optional, preserve a
pre-migration database backup, and retain the previous operator runbook until
the new recovery rehearsal passes.

## Phase 7: Stable release

Status: Planned

Scope:

- Resolve the licensing decision and add the license file.
- Decide the future of generic CLI and HTTP adapters.
- Freeze the supported endpoint subset and CLI version matrix.
- Freeze the supported Open WebUI version and optional-capability matrix.
- Add release notes, checksums, and reproducible artifacts.
- Run upgrade and rollback rehearsals.
- Run the full systemd plus Open WebUI acceptance suite with authenticated
  Codex and Grok subscription sessions.

Acceptance criteria:

- All quality gates in `SPEC.md` pass.
- Documentation matches the shipped configuration and endpoints.
- A clean install and an in-place upgrade both pass on supported Linux targets.
- The exact Node.js runtime, service account, CLI paths, credential home, and
  Open WebUI topology used by production pass preflight and live acceptance.
- A pinned Open WebUI release discovers both subscription-backed models and
  passes text, streaming, cancellation, isolation, and advertised tool-loop
  tests.
- Open WebUI optional capabilities and background-request behavior match the
  published capability matrix.
- Known limitations are explicit.
- The release contains the required upstream attribution and license notices.

Rollback: retain the previous signed release, configuration backup, and SQLite
backup until clean-install, upgrade, rollback, and Open WebUI acceptance
evidence is reviewed.
