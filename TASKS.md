# agent-proxy implementation tasks

This file tracks work derived from [SPEC.md](./SPEC.md) and
[ROADMAP.md](./ROADMAP.md). A task is complete only when its listed validation
passes.

Last updated: 2026-07-23

## Phase 1: Linux service baseline

Status: Complete

- [x] P1-01: Build a versioned Linux release archive.
  - Acceptance: the archive contains compiled server/shared output, production
    dependencies, systemd assets, and a version manifest.
  - Validation: `scripts/test-release.sh`.
- [x] P1-02: Install, upgrade, roll back, back up, and uninstall safely.
  - Acceptance: releases live under `/opt/agent-proxy/releases`; configuration
    and state remain outside releases; upgrades create backups; uninstall
    preserves operator data unless `--purge` is explicit.
  - Validation: `scripts/test-linux-install.sh`.
- [x] P1-03: Run under a hardened systemd service account.
  - Acceptance: the unit uses `User=agent-proxy`, has no ambient capabilities,
    restricts writable paths, and gives shutdown a bounded stop timeout.
  - Validation: `systemd-analyze verify`; `systemd-analyze security` review.
- [x] P1-04: Validate production prerequisites before listening.
  - Acceptance: startup rejects missing enabled CLI executables, non-writable
    state paths, missing configuration, and empty admin credentials with
    path-specific English errors.
  - Validation: preflight unit tests and `agent-proxy --check`.
- [x] P1-05: Shut down without orphaned provider processes.
  - Acceptance: SIGTERM stops acceptance, allows a bounded drain, terminates
    provider children, closes SQLite, and exits.
  - Validation: shutdown and process-lifecycle unit tests.
- [x] P1-06: Publish the Linux operator runbook.
  - Acceptance: install, CLI authentication, start/stop/restart, health,
    upgrade, rollback, backup/restore, security review, and uninstall are
    documented.
  - Validation: Markdown lint and command review.
- [x] P1-07: Prove restart persistence and external health.
  - Acceptance: a service-style smoke test creates state, restarts the server,
    verifies the state remains, and passes an HTTP health probe.
  - Validation: `scripts/test-linux-service.sh`.

Phase exit gate:

```bash
npm ci
npm run typecheck
npm test
npm run build
for script in start.sh scripts/*.sh; do
  bash -n "$script"
done
shellcheck start.sh scripts/*.sh
shfmt -d start.sh scripts/*.sh
scripts/test-linux-install.sh
scripts/test-linux-service.sh
scripts/test-release.sh
systemd-analyze verify packaging/systemd/agent-proxy.service
systemd-analyze security --offline=yes \
  packaging/systemd/agent-proxy.service
```

## Phase 2: OpenAI Responses compatibility

Status: Complete

Completed: 2026-07-23

- [x] P2-01: Define and validate the supported Responses request schema.
  - Acceptance: `model`, string and item-array `input`, `instructions`,
    `stream`, function `tools`, `tool_choice`, `max_output_tokens`, reasoning
    fields, and `previous_response_id` have explicit validation and compatible
    errors.
  - Validation: focused request-schema tests in
    `packages/server/src/routes/v1/responses.test.ts`.
- [x] P2-02: Normalize Responses input without losing roles or content items.
  - Acceptance: system/developer instructions, user and assistant content,
    images, function calls, and function results survive conversion into the
    provider contract.
  - Validation: table-driven converter tests with text, image, and tool
    fixtures.
- [x] P2-03: Implement complete non-streaming Responses output.
  - Acceptance: stable response IDs, status, model, output items, content,
    finish state, reasoning where supported, and usage conform to the supported
    Responses subset.
  - Validation: OpenAI SDK non-streaming contract tests against an in-process
    server.
- [x] P2-04: Implement ordered Responses SSE output and terminal errors.
  - Acceptance: creation, item, content-part, delta, completion, and terminal
    events appear in valid order; failures produce one terminal failed event.
  - Validation: event-sequence fixtures plus OpenAI SDK streaming tests.
- [x] P2-05: Round-trip one complete Responses function-tool loop.
  - Acceptance: tool definitions and choice reach the provider, tool-call IDs
    return to the client, tool results are accepted, and the final assistant
    response completes.
  - Validation: deterministic fake-provider tool-loop test and one supported
    live-provider acceptance test.
- [x] P2-06: Define response continuation and retention.
  - Acceptance: `previous_response_id` or the documented equivalent maps to a
    bounded, model-aware, client-isolated session with expiration and explicit
    not-found behavior.
  - Validation: continuation, expiration, model-change, and cross-client
    isolation tests.
- [x] P2-07: Implement cancellation, timeout, retry, and disconnect behavior.
  - Acceptance: disconnects abort or safely detach, timeouts have compatible
    errors, retries are bounded, and no provider child remains orphaned.
  - Validation: abort and timeout integration tests plus process-lifecycle
    assertions.
- [x] P2-08: Make the Responses contract provider-independent.
  - Acceptance: the same contract suite runs against fake Codex and Grok
    adapters without route-specific branches; unsupported fields identify the
    exact parameter.
  - Validation: shared provider-contract matrix and
    `scripts/test-responses-compat.sh`.

Phase exit gate:

```bash
npm run typecheck
npm test -- packages/server/src/routes/v1/responses.test.ts
npm run build
scripts/test-responses-compat.sh
```

Pause point: keep the endpoint labeled experimental until Phase 3 live client
acceptance passes.

## Phase 3: Native CLI and Open WebUI compatibility

Status: Ready to begin

Entry gate verified: 2026-07-23

Entry point: P3-01. Phase 3 has not started; all tasks remain unchecked until
their listed validation passes.

- [ ] P3-01: Build a sanitized live-client compatibility harness.
  - Acceptance: the harness records client and server versions, uses temporary
    isolated state, redacts credentials, captures non-secret protocol
    fixtures, and supports a `--require-live` release mode.
  - Validation: harness self-tests prove redaction, cleanup, skip, and
    required-live failure behavior.
- [ ] P3-02: Validate unmodified Claude Code.
  - Acceptance: a pinned Claude Code release completes text, streaming,
    cancellation, session isolation, and one Anthropic tool loop through
    `/v1/messages`.
  - Validation: `scripts/test-client-compat.sh --client claude --require-live`.
- [ ] P3-03: Validate unmodified Codex as a proxy client.
  - Acceptance: a pinned Codex release uses a custom Responses provider and
    completes text, streaming, cancellation, continuation, isolation, and one
    coding tool loop.
  - Validation: `scripts/test-client-compat.sh --client codex --require-live`.
- [ ] P3-04: Validate unmodified Grok Build as a proxy client.
  - Acceptance: a pinned Grok Build release uses a custom model and completes
    text, streaming or documented buffered fallback, cancellation, isolation,
    and one coding tool loop.
  - Validation: `scripts/test-client-compat.sh --client grok --require-live`.
- [ ] P3-05: Validate subscription authentication as the production service
      account.
  - Acceptance: Codex reports a valid ChatGPT login and Grok reports a valid
    supported subscription login when invoked with the exact systemd user,
    `HOME`, `PATH`, working directory, and hardening policy; no token appears in
    output.
  - Validation:
    `scripts/test-provider-auth.sh --providers codex,grok --require-live`.
- [ ] P3-06: Validate Open WebUI model discovery and basic chat.
  - Acceptance: a pinned Open WebUI release connects through its standard
    OpenAI settings, authenticates with a proxy key, discovers Codex and Grok
    aliases through `/v1/models`, and completes non-streaming text with both.
  - Validation:
    `scripts/test-open-webui-compat.sh --cases discovery,nonstream --require-live`.
- [ ] P3-07: Validate Open WebUI streaming, cancellation, and isolation.
  - Acceptance: Codex renders incrementally, buffered backends are labeled,
    cancelling a chat stops provider work, and two concurrent chats cannot
    observe each other's history.
  - Validation:
    `scripts/test-open-webui-compat.sh --cases stream,cancel,isolation --require-live`.
- [ ] P3-08: Validate one advertised Open WebUI function-tool loop.
  - Acceptance: Open WebUI sends a function definition, receives a compatible
    call with stable ID and arguments, returns the tool result, and displays the
    final model response for each backend that advertises tool calling.
  - Validation:
    `scripts/test-open-webui-compat.sh --cases tools --require-live`.
- [ ] P3-09: Validate native, Docker, and Podman Open WebUI topologies.
  - Acceptance: documented URLs work for a native process, a Docker container,
    and a Podman container; host reachability does not require publishing the
    proxy to an untrusted interface.
  - Validation: topology matrix in
    `scripts/test-open-webui-topologies.sh`.
- [ ] P3-10: Define Open WebUI optional-capability and background-task behavior.
  - Acceptance: documentation states which backend handles embeddings, RAG,
    speech, and images; title, tag, follow-up, and memory-related model calls
    can be disabled or routed separately; every generated request is visible in
    accounting.
  - Validation: configuration review plus an Open WebUI request-count fixture.
- [ ] P3-11: Return actionable compatibility and reauthentication errors.
  - Acceptance: unsupported fields, missing model mappings, missing logins,
    expired logins, and unreachable providers are distinguishable without
    exposing executable paths, account identifiers, or tokens.
  - Validation: error-shape tests and sanitized live negative tests.

Phase exit gate:

```bash
npm run typecheck
npm test
scripts/test-client-compat.sh --all --require-live
scripts/test-provider-auth.sh --providers codex,grok --require-live
scripts/test-open-webui-compat.sh --all --require-live
scripts/test-open-webui-topologies.sh --all
```

Rollback: keep Chat Completions available and remove unsupported models from
Open WebUI discovery while a client-specific regression is corrected.

## Phase 4: Provider reliability

Status: Planned

- [ ] P4-01: Normalize provider lifecycle and terminal-state handling.
  - Acceptance: spawn, success, failure, timeout, abort, and shutdown each
    produce exactly one terminal state and release tracked resources.
  - Validation: shared lifecycle contract tests for every built-in provider.
- [ ] P4-02: Add bounded queues and backpressure.
  - Acceptance: queue depth and wait time are bounded per provider; saturation
    returns a documented retryable response without unbounded process growth.
  - Validation: queue saturation integration and load tests.
- [ ] P4-03: Classify failures and retry policy.
  - Acceptance: executable, login, quota, model, validation, timeout, upstream,
    and internal failures map to explicit retryability and compatible API
    errors.
  - Validation: provider failure matrix and retry-decision unit tests.
- [ ] P4-04: Make fallback and accounting idempotent.
  - Acceptance: retries and fallback cannot duplicate global, key, provider, or
    Open WebUI background-request accounting.
  - Validation: multi-provider retry and fallback accounting tests.
- [ ] P4-05: Harden Codex resume and app-server concurrency.
  - Acceptance: concurrent clients cannot share threads, model changes
    invalidate incompatible state, worker restart is bounded, and cancellation
    cannot poison later requests.
  - Validation: Codex concurrency, restart, resume, and cancellation stress
    tests.
- [ ] P4-06: Harden Claude SDK and channel-worker isolation.
  - Acceptance: sessions, tool results, worker failures, and cancellation are
    isolated across concurrent clients and supported modes.
  - Validation: Claude mode-matrix stress tests.
- [ ] P4-07: Validate Antigravity model labels and buffered behavior.
  - Acceptance: invalid labels fail preflight and buffered responses emit one
    valid terminal stream sequence with accurate capability metadata.
  - Validation: startup validation and provider stream contract tests.
- [ ] P4-08: Harden Grok execution and streaming.
  - Acceptance: Grok uses native incremental output when supported, otherwise
    emits a documented buffered fallback; prompt-size, timeout, abort, and
    process cleanup behavior are bounded.
  - Validation: Grok version-matrix and stream contract tests.
- [ ] P4-09: Recover from subscription expiry and reauthentication.
  - Acceptance: an expired Codex or Grok session does not crash the proxy,
    requests receive sanitized reauthentication guidance, and a successful CLI
    login restores service without rotating the proxy API key.
  - Validation: fake-token-expiry tests and a sanitized live recovery rehearsal.
- [ ] P4-10: Stress Open WebUI request patterns.
  - Acceptance: concurrent chats, retries, cancellation, and enabled background
    tasks remain within configured queues and rate limits with no zombies,
    orphan processes, or cross-chat context.
  - Validation: `scripts/test-open-webui-load.sh`.

Phase exit gate:

```bash
npm run typecheck
npm test
scripts/test-provider-stress.sh
scripts/test-open-webui-load.sh
```

## Phase 5: Security and privacy

Status: Planned

- [ ] P5-01: Reject weak, empty, and placeholder production credentials.
  - Acceptance: admin and data-plane secrets are independent, meet documented
    entropy rules, and fail startup with path-specific errors.
  - Validation: configuration and preflight security tests.
- [ ] P5-02: Minimize provider child environments.
  - Acceptance: each provider receives only shared safe variables and its
    documented provider-specific variables; unrelated tokens never cross
    provider boundaries.
  - Validation: environment allowlist and secret-canary tests.
- [ ] P5-03: Add a safe chat-only execution profile.
  - Acceptance: Codex and Grok run in a dedicated working directory with
    read-only or equivalently constrained filesystem, command, and network
    behavior; an Open WebUI prompt cannot modify the repository or unrelated
    host paths.
  - Validation: adversarial write, command, and network denial acceptance tests.
- [ ] P5-04: Add an explicit tool-enabled execution profile.
  - Acceptance: provider-native tools require operator opt-in, allowed
    directories and permissions are explicit, and documentation distinguishes
    them from Open WebUI function tools.
  - Validation: profile-selection tests and permission-boundary review.
- [ ] P5-05: Secure debug capture and retention.
  - Acceptance: debug is off by default, retention is bounded, files are
    owner-only, and all supported credential, authorization, cookie, and token
    formats are redacted.
  - Validation: redaction corpus and retention-expiry tests.
- [ ] P5-06: Prevent export and import credential leakage.
  - Acceptance: exported settings contain no recoverable credentials and
    imports cannot override protected executable or credential paths.
  - Validation: secret-canary export/import tests.
- [ ] P5-07: Test size, concurrency, and prompt abuse boundaries.
  - Acceptance: oversized bodies, messages, prompts, images, tool schemas, and
    concurrent requests fail within bounded CPU, memory, and process use.
  - Validation: abuse and denial-of-service test suite.
- [ ] P5-08: Publish secure Open WebUI network topologies.
  - Acceptance: native, Docker, and Podman examples use TLS or trusted local
    networking, strong proxy keys, firewall rules, and no accidental public
    listener.
  - Validation: container network tests plus firewall and reverse-proxy
    configuration review.
- [ ] P5-09: Publish and verify the threat model.
  - Acceptance: prompt injection, command injection, provider-native tools,
    Open WebUI tools, SSRF, credential theft, cross-session leakage, debug
    leakage, and denial of service have documented mitigations and residual
    risk.
  - Validation: threat-model checklist mapped to automated tests.
- [ ] P5-10: Add release secret scanning.
  - Acceptance: source, fixtures, release archives, logs, and compatibility
    evidence contain no committed credentials or live provider tokens.
  - Validation: repository and built-artifact secret scan.

Phase exit gate:

```bash
npm run typecheck
npm test
scripts/test-security.sh
scripts/test-open-webui-topologies.sh --security
scripts/scan-secrets.sh
```

## Phase 6: Observability and operations

Status: Planned

- [ ] P6-01: Add production structured logging.
  - Acceptance: JSON logs correlate request, route, provider execution,
    fallback, cancellation, and terminal status without recording prompt
    content or credentials.
  - Validation: structured-log schema and redaction tests.
- [ ] P6-02: Add Prometheus-compatible metrics.
  - Acceptance: request rate, latency, failures, fallbacks, queue depth, active
    requests, provider availability, authentication readiness, and estimated
    versus reported usage are exposed with bounded label cardinality.
  - Validation: metrics snapshot and cardinality tests.
- [ ] P6-03: Separate process, provider, authentication, and dependency health.
  - Acceptance: health output distinguishes executable failure, missing or
    expired login, quota exhaustion, upstream outage, and degraded buffered
    capability where supported without exposing account data.
  - Validation: health-state matrix tests.
- [ ] P6-04: Complete database backup and restore commands.
  - Acceptance: backup is consistent, permissions are restrictive, restore is
    atomic or recoverable, and a fresh instance preserves keys, mappings,
    limits, and non-secret operational state.
  - Validation: fresh-instance backup/restore rehearsal.
- [ ] P6-05: Add host and service-account deployment diagnostics.
  - Acceptance: diagnostics report incompatible `ExecStart` Node.js runtime,
    inaccessible CLI paths, wrong `HOME`, unwritable state, missing login, and
    hardening-policy denials with actionable commands.
  - Validation: staged failure matrix using the production unit.
- [ ] P6-06: Add provider authentication and quota runbooks.
  - Acceptance: operators can verify, renew, and re-check Codex and Grok
    subscription logins as the service account without printing tokens; quota
    and upstream failures have separate recovery paths.
  - Validation: sanitized command review and live recovery rehearsal.
- [ ] P6-07: Add the Open WebUI operations runbook.
  - Acceptance: model discovery, proxy-key errors, native and container
    networking, streaming, cancellation, optional backends, background model
    requests, and provider login failures each have diagnosis and recovery
    steps.
  - Validation: runbook steps are executed against the pinned Open WebUI
    release.
- [ ] P6-08: Add production alert examples.
  - Acceptance: examples cover service down, provider down, login expiry, quota
    exhaustion, queue saturation, latency, error rate, repeated authentication
    failures, and abnormal Open WebUI request amplification.
  - Validation: alert-rule syntax tests and synthetic firing checks.
- [ ] P6-09: Build an operator acceptance command.
  - Acceptance: one command checks runtime, service account, CLI visibility,
    provider authentication, proxy health, model discovery, and optional Open
    WebUI connectivity while producing sanitized evidence.
  - Validation: `scripts/acceptance-check.sh --require-live`.

Phase exit gate:

```bash
npm run typecheck
npm test
scripts/test-observability.sh
scripts/test-backup-restore.sh
scripts/acceptance-check.sh --require-live
```

## Phase 7: Stable release

Status: Planned

- [ ] P7-01: Confirm upstream licensing and attribution obligations.
  - Acceptance: the repository and release preserve the MIT license and contain
    all required upstream attribution, notices, and redistribution terms.
  - Validation: legal-file checklist and release archive inspection.
- [ ] P7-02: Decide the generic adapter boundary.
  - Acceptance: generic CLI and HTTP adapters are either included with a frozen
    support contract or removed from the stable artifact and documentation.
  - Validation: provider registry, configuration, UI, and documentation audit.
- [ ] P7-03: Freeze the compatibility and capability matrix.
  - Acceptance: supported Linux targets, Node.js runtime, provider CLI
    versions, Open WebUI version, endpoints, streaming modes, tool support, and
    optional Open WebUI capabilities are explicit.
  - Validation: matrix entries link to passing acceptance evidence.
- [ ] P7-04: Make release artifacts reproducible and verifiable.
  - Acceptance: clean builds produce matching manifests, checksums, required
    runtime dependencies, systemd assets, documentation, and version metadata.
  - Validation: two-build reproducibility comparison and checksum verification.
- [ ] P7-05: Rehearse clean production installation.
  - Acceptance: a supported clean Linux target installs the exact Node.js
    runtime and CLIs, authenticates Codex and Grok as `agent-proxy`, starts the
    hardened service, and passes external health and operator acceptance.
  - Validation: install VM transcript plus
    `scripts/acceptance-check.sh --require-live`.
- [ ] P7-06: Rehearse the pinned Open WebUI deployment.
  - Acceptance: native and supported container topology discovery works; Codex
    and Grok complete text, streaming or documented buffering, cancellation,
    isolation, and every advertised tool-loop test using only the proxy key in
    Open WebUI.
  - Validation:
    `scripts/test-open-webui-compat.sh --all --require-live`.
- [ ] P7-07: Rehearse upgrade and rollback with active integrations.
  - Acceptance: configuration, keys, mappings, subscription login state, and
    SQLite data survive upgrade; rollback restores the prior service; Open
    WebUI reconnects without replacing its proxy key.
  - Validation: supported-version upgrade and rollback matrix.
- [ ] P7-08: Publish release notes and known limitations.
  - Acceptance: release notes describe supported versions, configuration,
    security profiles, optional Open WebUI backends, background-request usage,
    buffered streaming, unsupported features, upgrade, and rollback.
  - Validation: documentation-to-capability-matrix audit.
- [ ] P7-09: Run the complete stable-release gate.
  - Acceptance: every required automated and live acceptance check passes with
    no unexplained skip, the worktree is clean, and evidence contains no
    secrets.
  - Validation: `scripts/release-gate.sh --require-live`.

Phase exit gate:

```bash
npm ci
npm run typecheck
npm test
npm run build
for script in start.sh scripts/*.sh; do
  bash -n "$script"
done
shellcheck start.sh scripts/*.sh
shfmt -d start.sh scripts/*.sh
scripts/test-linux-install.sh
scripts/test-linux-service.sh
scripts/test-release.sh
scripts/test-responses-compat.sh
scripts/test-client-compat.sh --all --require-live
scripts/test-provider-auth.sh --providers codex,grok --require-live
scripts/test-provider-stress.sh
scripts/test-security.sh
scripts/test-observability.sh
scripts/test-backup-restore.sh
scripts/test-open-webui-compat.sh --all --require-live
scripts/test-open-webui-topologies.sh --all
scripts/acceptance-check.sh --require-live
scripts/release-gate.sh --require-live
```

## Coverage matrix

| Specification area | Primary tasks |
| --- | --- |
| Responses API and provider-independent protocol | P2-01 through P2-08 |
| Claude Code, Codex, and Grok client compatibility | P3-01 through P3-04 |
| Subscription-backed service-account authentication | P3-05, P3-11, P4-09, P6-05, P6-06, P7-05 |
| Open WebUI discovery, chat, streaming, tools, and topology | P3-06 through P3-10, P4-10, P6-07, P7-06 |
| Provider lifecycle, queues, retry, fallback, and isolation | P4-01 through P4-10 |
| Safe chat-only and opt-in tool-enabled execution | P5-03, P5-04, P5-08, P5-09 |
| Secrets, debug data, abuse resistance, and threat model | P5-01, P5-02, P5-05 through P5-10 |
| Logging, metrics, health, backup, diagnostics, and alerts | P6-01 through P6-09 |
| Runtime, clean install, upgrade, rollback, and stable release | P7-01 through P7-09 |
