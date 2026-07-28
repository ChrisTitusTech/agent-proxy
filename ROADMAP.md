# agent-proxy roadmap

This roadmap implements [SPEC.md](./SPEC.md) in reviewable phases. A phase is
complete only when its acceptance criteria and validation commands pass.

Last updated: 2026-07-27

## Current direction

`agent-proxy` is a per-login-user desktop service. Local applications call its
localhost API, and every inference request routed to a built-in CLI executes as
a Herdr-managed agent owned by that same user.

The former machine-wide installation under a dedicated `agent-proxy` account
is superseded. Its completed tests remain useful historical evidence, but its
ownership, authentication, filesystem, and service model are not the target
for future releases.

## Phase 0: Repository cleanup

Status: Complete

Completed work:

- Renamed the project from `star-cliproxy` to `agent-proxy`.
- Retained Claude Code, Codex, Google Antigravity, and Grok as built-in agents.
- Removed legacy Gemini and Copilot provider implementations.
- Removed obsolete analyses, duplicate documentation, and superseded POCs.
- Added an English-only specification, roadmap, and focused README.

## Phase 1: Legacy Linux service baseline

Status: Superseded

Historical result:

- Built a versioned release and root installer.
- Ran under a dedicated non-root system account.
- Added systemd hardening, persistence, backup, rollback, and shutdown tests.

Why it is superseded:

- The dedicated account cannot naturally share the logged-in user's Herdr
  session or normal provider authentication.
- Root-owned `/opt`, `/etc`, and `/var` paths conflict with the single-user
  desktop product boundary.
- Headless provider children are not visible as Herdr agents.

The Phase 4 implementation removes this deployment path after equivalent
user-owned lifecycle coverage exists.

## Phase 2: OpenAI Responses compatibility

Status: Complete

Completed: 2026-07-23

Delivered:

- Dedicated `/v1/responses` route and schemas.
- String and item-array input normalization.
- Function tools, tool choice, reasoning, images, and output items.
- Ordered SSE events and terminal failures.
- Bounded response continuation and client isolation.
- Cancellation, timeout, and provider-independent contract tests.

The protocol adapter remains reusable, but Phase 4 must move its provider
execution behind the Herdr launcher.

## Phase 3: Native clients and Open WebUI compatibility

Status: Complete, with deployment evidence superseded

Completed: 2026-07-26

Delivered:

- Sanitized native-client compatibility harness.
- Live Codex Responses validation.
- Open WebUI discovery, streaming, cancellation, isolation, tools, and
  native/Docker/Podman topology coverage.
- Subscription readiness and reauthentication diagnostics.
- Provider-independent offline coverage for Claude and Grok.

Limitations:

- Claude live inference was waived because no subscription was available.
- Grok live inference was waived after device login failed.
- Live validation used the former service-account deployment.
- GitHub Copilot was not part of the live client matrix.

Phase 4 must rerun the enabled matrix as the logged-in user with Herdr
visibility as a required assertion.

## Phase 4: User-owned Herdr execution

Status: Ready to begin

Purpose:

- Replace the machine-wide service with a per-user login service.
- Ensure every built-in provider invocation is a Herdr-managed agent.
- Allow Copilot, Open WebUI, native clients, and SDKs to create visible agents
  through the localhost API.
- Remove superseded headless, service-account, and unused extension paths.

Scope:

- Install releases, configuration, state, logs, and runtime files in XDG user
  directories.
- Add a systemd user unit and login-start integration for Herdr and
  `agent-proxy`.
- Add a typed Herdr launcher and structured worker protocol.
- Create or reuse panes by client session, provider, and model.
- Route Chat Completions, Responses, and Messages provider attempts through the
  launcher.
- Preserve streaming, tools, cancellation, timeout, fallback, and shutdown.
- Prevent child-provider recursion into the localhost proxy.
- Add Copilot CLI BYOK compatibility coverage.
- Remove the root installer, dedicated-user unit, and provider paths that
  bypass the required Herdr execution contract.
- Add a durable unused-code and dependency gate.

Acceptance criteria:

- A normal user installs, upgrades, rolls back, backs up, and uninstalls
  without root.
- `systemctl --user` starts Herdr before `agent-proxy` accepts inference.
- All created files are owned by the current user with restrictive
  permissions.
- Every built-in provider attempt appears in the expected Herdr session.
- Health, discovery, and admin-only calls create no agent panes.
- If Herdr is unavailable, inference returns an actionable `503` and no
  headless provider starts.
- Copilot CLI and Open WebUI complete streaming text and one tool loop through
  the localhost API.
- Cancellation and shutdown leave no worker, provider, or pane in a false
  working state.
- Concurrent client sessions do not share pane, provider thread, output, or
  tool state.
- The repository contains no active dedicated-service-user deployment path.
- Static dead-code analysis reports no unexplained files, exports, or
  dependencies.

Validation:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint:dead-code
mapfile -d '' -t shell_files < <(
  printf '%s\0' start.sh
  find scripts -type f -name '*.sh' -print0
)
bash -n "${shell_files[@]}"
shellcheck "${shell_files[@]}"
shfmt -d "${shell_files[@]}"
scripts/test-user-install.sh
scripts/test-user-service.sh
scripts/test-herdr-launcher.sh
scripts/test-client-compat.sh --client copilot --require-live
scripts/test-client-compat.sh --client codex --require-live
OPEN_WEBUI_MODELS=gpt-5.6-sol \
  scripts/test-open-webui-compat.sh --all --require-live
```

Rollback:

- Preserve the previous user-owned release and user data backup.
- Keep the API healthy for diagnostics but reject inference if the Herdr
  launcher cannot be restored.
- Never roll back to invisible headless execution.

Pause point: review the current-user trust boundary, Herdr pane lifecycle, and
Copilot tool permissions before enabling tool-capable profiles by default.

## Phase 5: Provider reliability

Status: Planned

Scope:

- Normalize pane and provider lifecycle terminal states.
- Add bounded provider queues and backpressure.
- Classify executable, Herdr, login, quota, model, validation, timeout,
  upstream, and internal failures.
- Make retry, fallback, and accounting idempotent.
- Harden Codex resume and persistent-session concurrency.
- Harden Claude session and tool isolation.
- Validate Antigravity labels and buffered streaming.
- Add native Grok streaming when supported.
- Recover cleanly from authentication expiry.
- Stress concurrent Copilot and Open WebUI request patterns.

Acceptance criteria:

- Every pane and request reaches exactly one terminal state.
- Queue saturation creates no pane and causes no process growth.
- Provider crashes do not crash the API server.
- Retry and fallback do not duplicate accounting or leave stale panes.
- Stress tests leave no zombie, orphan, or falsely working process.

Validation:

```bash
npm run typecheck
npm test
scripts/test-provider-stress.sh
scripts/test-herdr-load.sh
```

## Phase 6: Desktop-user security and privacy

Status: Planned

Scope:

- Reject weak or placeholder credentials.
- Minimize provider and worker environments.
- Add chat-only and explicit tool-enabled permission profiles.
- Constrain runtime job files and Herdr socket usage.
- Harden debug retention, export/import, and redaction.
- Test prompt, body, tool-schema, and concurrency abuse limits.
- Publish the desktop-user threat model.
- Add release secret scanning.

Acceptance criteria:

- Localhost callers still require a valid proxy key.
- Chat-only prompts cannot modify unrelated user files.
- Herdr metadata and retained panes expose no credentials or prompt content.
- Provider-native tools require explicit operator opt-in.
- Secret scanning covers source, releases, logs, fixtures, and Herdr evidence.

## Phase 7: Observability and user operations

Status: Planned

Scope:

- Add structured logs and Prometheus-compatible metrics.
- Distinguish API, Herdr, provider, authentication, queue, and dependency
  health.
- Add user-data backup and restore commands.
- Add Herdr pane and session diagnostics.
- Publish recovery runbooks for Copilot and Open WebUI.
- Add login-session startup and notification diagnostics.
- Build one sanitized user acceptance command.

Acceptance criteria:

- Logs correlate an API request through its Herdr pane and provider execution.
- Metrics expose request, queue, pane, provider, failure, and cancellation
  behavior with bounded cardinality.
- Backup and restore pass in isolated XDG directories.
- The runbook recovers missing Herdr, model discovery, login, streaming, and
  stale-pane failures.

## Phase 8: Stable desktop release

Status: Planned

Scope:

- Complete licensing, attribution, and notices review.
- Freeze supported Linux, Herdr, client, and provider versions.
- Freeze the endpoint and capability matrix.
- Produce reproducible user-owned release artifacts.
- Rehearse clean install, upgrade, rollback, logout, and next-login startup.
- Run the complete Copilot, Codex, and Open WebUI acceptance matrix.
- Publish release notes and known limitations.

Acceptance criteria:

- Every quality gate in `SPEC.md` passes.
- A clean desktop user can install and operate the service without root.
- Login starts Herdr and the proxy in the correct order.
- Every inference request is visible in Herdr.
- Documentation matches the shipped user-owned paths and permissions.
- No unexplained skips, review findings, secrets, or dead code remain.
