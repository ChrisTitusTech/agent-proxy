# agent-proxy implementation tasks

This file tracks work derived from [SPEC.md](./SPEC.md) and
[ROADMAP.md](./ROADMAP.md). A task is complete only when its acceptance and
validation evidence pass.

Last updated: 2026-07-27

## Historical phases

### Phase 1: Legacy Linux service baseline

Status: Superseded

The former root installer, dedicated `agent-proxy` account, system service,
service-account authentication, and `/opt`/`/etc`/`/var` layout passed their
historical tests. They are not the target deployment model and must be removed
in Phase 4 after equivalent user-owned lifecycle tests exist.

### Phase 2: OpenAI Responses compatibility

Status: Complete

- [x] P2-01: Validate the supported Responses request schema.
- [x] P2-02: Preserve roles and content during input normalization.
- [x] P2-03: Produce compatible non-streaming Responses output.
- [x] P2-04: Produce ordered streaming events and terminal failures.
- [x] P2-05: Round-trip one complete function-tool loop.
- [x] P2-06: Bound response continuation and retention.
- [x] P2-07: Implement cancellation, timeout, retry, and disconnect behavior.
- [x] P2-08: Run a provider-independent Responses contract suite.

### Phase 3: Native clients and Open WebUI compatibility

Status: Complete, with deployment evidence superseded

- [x] P3-01: Build a sanitized live-client compatibility harness.
- [x] P3-02: Validate or explicitly waive unmodified Claude Code.
- [x] P3-03: Validate unmodified Codex.
- [x] P3-04: Validate or explicitly waive unmodified Grok Build.
- [x] P3-05: Validate provider authentication readiness.
- [x] P3-06: Validate Open WebUI discovery and non-streaming chat.
- [x] P3-07: Validate Open WebUI streaming, cancellation, and isolation.
- [x] P3-08: Validate an Open WebUI function-tool loop.
- [x] P3-09: Validate native, Docker, and Podman Open WebUI topologies.
- [x] P3-10: Document optional capabilities and background requests.
- [x] P3-11: Return actionable compatibility and authentication errors.

Phase 4 must rerun live evidence under the logged-in user's Herdr session.
Detailed Phase 3 acceptance criteria, versions, validation commands, waivers,
and sanitized evidence locations are preserved in
[docs/phase-3-evidence.md](./docs/phase-3-evidence.md).

## Phase 4: User-owned Herdr execution

Status: Ready to begin

- [ ] P4-01: Replace the machine-wide deployment with a user-owned XDG layout.
  - Acceptance: releases, configuration, data, state, backups, logs, and
    runtime jobs live in the paths defined by `SPEC.md`; install, upgrade,
    rollback, backup, and uninstall require no root and preserve ownership.
  - Validation: `scripts/test-user-install.sh` using isolated `HOME` and XDG
    directories, including spaces and shell metacharacters in paths.
- [ ] P4-02: Start Herdr and `agent-proxy` with the user login session.
  - Acceptance: systemd user units use no `User=` or `Group=`, Herdr becomes
    ready before inference is accepted, logout performs bounded shutdown, and
    the next login restores both services.
  - Validation: user-unit verification plus `scripts/test-user-service.sh`.
- [ ] P4-03: Add a typed Herdr launcher and worker protocol.
  - Acceptance: the proxy creates or reuses the designated workspace, tab, and
    pane; request arguments and results use owner-only structured IPC rather
    than terminal scraping or shell interpolation.
  - Validation: fake Herdr socket and fake provider contract tests.
- [ ] P4-04: Route every built-in provider attempt through Herdr.
  - Acceptance: Claude, Codex, Antigravity, and Grok non-streaming and
    streaming executions cannot bypass the launcher; health and admin probes
    do not create panes.
  - Validation: provider matrix with a direct-spawn canary that fails if a
    route launches outside Herdr.
- [ ] P4-05: Correlate API clients, sessions, and Herdr panes.
  - Acceptance: explicit client session IDs reuse only compatible panes;
    requests without an explicit ID remain isolated; model, provider,
    directory, and permission changes invalidate reuse.
  - Validation: session reuse, expiration, collision, and cross-client tests.
- [ ] P4-06: Preserve structured streaming and tool calls through the worker.
  - Acceptance: the proxy consumes raw structured output over IPC, not rendered
    terminal content; text deltas and tool events retain order, IDs, arguments,
    and terminal status.
  - Validation: Chat Completions, Responses, and Messages streaming/tool
    contract suites through a fake Herdr worker.
- [ ] P4-07: Implement cancellation, timeout, fallback, and shutdown cleanup.
  - Acceptance: aborting an API request stops its provider process and updates
    the pane exactly once; fallback starts only after the failed attempt is
    terminal; proxy shutdown leaves no orphaned worker or false working pane.
  - Validation: process-tree, timeout, fallback, and shutdown integration tests.
- [ ] P4-08: Fail closed when Herdr is unavailable.
  - Acceptance: incompatible or unavailable Herdr returns a sanitized `503`;
    no hidden headless provider process starts; health distinguishes API and
    Herdr readiness.
  - Validation: unavailable, stale-socket, protocol-mismatch, and reconnect
    tests.
- [ ] P4-09: Prevent provider recursion through the localhost proxy.
  - Acceptance: Codex, Copilot, Grok, and other supported client
    configurations that point the child provider back at the same listener are
    rejected before a pane starts.
  - Validation: configuration fixtures for direct, symlinked, hostname, IPv4,
    and IPv6 loopback endpoints.
- [ ] P4-10: Validate GitHub Copilot as a localhost API client.
  - Acceptance: pinned Copilot CLI discovers or selects the configured model
    and completes streaming text, cancellation, isolation, and one tool loop;
    every provider attempt is visible in Herdr.
  - Validation:
    `scripts/test-client-compat.sh --client copilot --require-live`.
- [ ] P4-11: Rerun Codex and Open WebUI under the current-user runtime.
  - Acceptance: enabled clients pass their Phase 3 matrix with current-user
    authentication and Herdr pane assertions.
  - Validation:
    `scripts/test-client-compat.sh --client codex --require-live` and
    `scripts/test-open-webui-compat.sh --all --require-live`.
- [ ] P4-12: Remove superseded execution and deployment code.
  - Acceptance: the root installer, dedicated-user unit, service-account
    wording in active code, configuration, and current runbooks, direct
    headless provider path, unsupported extension paths, and unused
    dependencies are absent. Clearly marked historical evidence may retain
    service-account terminology; documented dynamic entry points pass the
    dead-code gate.
  - Validation: scoped searches of active runtime and deployment artifacts
    separately from historical documentation, `npm run lint:dead-code`,
    package audit, release manifest review, and the full project gate.

Phase exit gate:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint:dead-code
scripts/validate-shell.sh
git diff --check
scripts/test-user-install.sh
scripts/test-user-service.sh
scripts/test-herdr-launcher.sh
scripts/test-client-compat.sh --client copilot --require-live
scripts/test-client-compat.sh --client codex --require-live
OPEN_WEBUI_MODELS=gpt-5.6-sol \
  scripts/test-open-webui-compat.sh --all --require-live
```

Rollback:

- For a first-time user-owned install, stop and remove the user services and
  release while leaving preexisting CLI-owned provider state untouched.
- For migration, back up legacy configuration and database state before
  changes and leave the machine-wide deployment intact until acceptance. A
  pre-acceptance rollback stops the user services and restores the preserved
  legacy deployment and state.
- After intentional legacy removal, restore only a preserved user-owned
  release and user-data backup.
- If Herdr execution cannot be restored in any case, reject inference rather
  than launching hidden headless agents.

## Phase 5: Provider reliability

Status: Planned

- [ ] P5-01: Normalize request, pane, worker, and provider terminal states.
- [ ] P5-02: Add bounded queues and backpressure before pane creation.
- [ ] P5-03: Classify failures and retryability.
- [ ] P5-04: Make fallback and accounting idempotent.
- [ ] P5-05: Harden Codex resume and persistent-session concurrency.
- [ ] P5-06: Harden Claude session and tool isolation.
- [ ] P5-07: Validate Antigravity labels and buffered behavior.
- [ ] P5-08: Harden Grok execution and streaming.
- [ ] P5-09: Recover from subscription expiry and reauthentication.
- [ ] P5-10: Stress Copilot and Open WebUI request patterns.

Phase exit gate:

```bash
npm run typecheck
npm test
scripts/test-provider-stress.sh
scripts/test-herdr-load.sh
```

## Phase 6: Desktop-user security and privacy

Status: Planned

- [ ] P6-01: Reject weak, empty, and placeholder credentials.
- [ ] P6-02: Minimize provider and worker environments.
- [ ] P6-03: Add a safe chat-only execution profile.
- [ ] P6-04: Add an explicit tool-enabled profile.
- [ ] P6-05: Secure runtime IPC, debug capture, and retention.
- [ ] P6-06: Prevent export and import credential leakage.
- [ ] P6-07: Test body, prompt, tool-schema, and concurrency abuse limits.
- [ ] P6-08: Publish secure localhost and container-client topologies.
- [ ] P6-09: Publish and verify the desktop-user threat model.
- [ ] P6-10: Add release secret scanning.

Phase exit gate:

```bash
npm run typecheck
npm test
scripts/test-security.sh
scripts/scan-secrets.sh
```

## Phase 7: Observability and user operations

Status: Planned

- [ ] P7-01: Add production structured logging.
- [ ] P7-02: Add Prometheus-compatible metrics.
- [ ] P7-03: Separate API, Herdr, provider, authentication, and dependency health.
- [ ] P7-04: Add user-data backup and restore commands.
- [ ] P7-05: Add login-session and Herdr diagnostics.
- [ ] P7-06: Add provider authentication and quota runbooks.
- [ ] P7-07: Add Copilot and Open WebUI operations runbooks.
- [ ] P7-08: Add production notification and alert examples.
- [ ] P7-09: Build a sanitized current-user acceptance command.

Phase exit gate:

```bash
npm run typecheck
npm test
scripts/test-observability.sh
scripts/test-backup-restore.sh
scripts/acceptance-check.sh --require-live
```

## Phase 8: Stable desktop release

Status: Planned

- [ ] P8-01: Confirm upstream licensing and attribution obligations.
- [ ] P8-02: Remove or freeze the provider-side generic CLI and HTTP adapter
      boundary while retaining the reusable Phase 2 protocol adapters.
- [ ] P8-03: Freeze Linux, Herdr, client, provider, and capability versions.
- [ ] P8-04: Make user-owned release artifacts reproducible.
- [ ] P8-05: Rehearse clean installation and login startup.
- [ ] P8-06: Rehearse Copilot and Open WebUI deployment.
- [ ] P8-07: Rehearse upgrade, rollback, logout, and next-login recovery.
- [ ] P8-08: Publish release notes and known limitations.
- [ ] P8-09: Run the complete stable-release gate.

## Coverage matrix

| Specification area | Primary tasks |
| --- | --- |
| User ownership and XDG deployment | P4-01, P4-02, P4-12 |
| Herdr launcher and worker protocol | P4-03 through P4-08 |
| Session and pane isolation | P4-05, P4-07, P5-01, P5-05, P5-06 |
| Copilot, Codex, and Open WebUI clients | P4-10, P4-11, P5-10, P7-07, P8-06 |
| Recursion and localhost trust | P4-09, P6-03, P6-04, P6-09 |
| Provider reliability | P5-01 through P5-10 |
| Security and privacy | P6-01 through P6-10 |
| Operations and observability | P7-01 through P7-09 |
| Stable desktop release | P8-01 through P8-09 |
