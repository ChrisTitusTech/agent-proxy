# Phase 3 compatibility evidence

This document preserves the detailed acceptance and validation record for the
completed Phase 3 native-client and Open WebUI work. The live evidence was
collected under the historical machine-wide service-account deployment. Phase
4 must rerun the enabled matrix as the logged-in user and add Herdr visibility
assertions.

Historical status: completed under the superseded Phase 3 deployment

The historical `scripts/test-provider-auth.sh` command recorded below was
removed when Phase 4 replaced service-account authentication with normal
current-user CLI authentication. Current live acceptance uses
`scripts/test-client-compat.sh`, `scripts/test-open-webui-compat.sh`, and the
authenticated `/admin/health` endpoint.

Entry gate verified: 2026-07-23

Phase started: 2026-07-25

Completed: 2026-07-26

Codex passed its required-live matrix. The operator explicitly waived Claude
live validation because no Claude subscription was available and waived Grok
live validation because its xAI device login would not complete. Both waived
providers remained implemented and offline-tested but were disabled in the
production service profile.

## Completed tasks

- [x] P3-01: Build a sanitized live-client compatibility harness.
  - Acceptance: the harness records client and server versions, uses temporary
    isolated state, redacts credentials, captures non-secret protocol
    fixtures, and supports a `--require-live` release mode.
  - Validation: harness self-tests prove redaction, cleanup, skip, and
    required-live failure behavior.
  - Completed: 2026-07-25. Validation:
    `scripts/test-client-compat-self-test.sh`.
- [x] P3-02: Validate unmodified Claude Code.
  - Acceptance: a pinned Claude Code release completes text, streaming,
    cancellation, session isolation, and one Anthropic tool loop through
    `/v1/messages`; or the operator explicitly approves a live-validation
    waiver when no subscription is available, after offline tests pass and the
    provider is disabled in production.
  - Prescribed live validation:
    `scripts/test-client-compat.sh --client claude --require-live`.
  - Waived without a passing live run: 2026-07-26. The implementation and
    offline tests passed; the operator explicitly waived live authentication
    and inference because no Claude subscription was available.
- [x] P3-03: Validate unmodified Codex as a proxy client.
  - Acceptance: a pinned Codex release uses a custom Responses provider and
    completes text, streaming, cancellation, continuation, isolation, and one
    coding tool loop.
  - Validation: `scripts/test-client-compat.sh --client codex --require-live`.
  - Completed: 2026-07-26 with Codex `0.145.0`. Sanitized evidence:
    `dist/client-compat/20260726T062023Z-140526/codex`.
- [x] P3-04: Validate unmodified Grok Build as a proxy client.
  - Acceptance: a pinned Grok Build release uses a custom model and completes
    text, streaming or documented buffered fallback, cancellation, isolation,
    and one coding tool loop; or the operator explicitly approves a
    live-validation waiver when subscription login cannot complete, after
    offline tests pass and the provider is disabled in production.
  - Prescribed live validation:
    `scripts/test-client-compat.sh --client grok --require-live`.
  - Waived without a passing live run: 2026-07-26. Grok `0.2.112` was installed
    and offline-tested, but the operator explicitly waived live authentication
    and inference after its xAI device login repeatedly failed to complete.
- [x] P3-05: Validate subscription authentication as the production service
      account.
  - Acceptance: the dashboard reports and refreshes Claude, Codex, and Grok
    service-account logins; each enabled production CLI reports a valid
    supported subscription login when invoked with the exact systemd user,
    `HOME`, `PATH`, working directory, and hardening policy; explicitly waived
    providers pass offline validation and remain disabled; no token or account
    identifier appears in output.
  - Validation:
    `scripts/test-provider-auth.sh --providers codex --require-live`.
  - Completed: Codex `0.145.0` passed under the hardened systemd identity.
    Claude and Grok were explicitly waived and disabled.
- [x] P3-06: Validate Open WebUI model discovery and basic chat for enabled
      production models.
  - Acceptance: a pinned Open WebUI release connects through its standard
    OpenAI settings, authenticates with a proxy key, discovers each enabled
    production alias through `/v1/models`, and completes non-streaming text
    with each enabled provider. Grok remains subject to its explicit live-test
    waiver and must not be advertised while disabled.
  - Validation:
    `OPEN_WEBUI_MODELS=gpt-5.6-sol scripts/test-open-webui-compat.sh
    --cases discovery,nonstream --require-live`.
  - Accepted with waiver: Open WebUI `v0.9.5` discovered and validated the
    production Codex alias. Grok chat was explicitly waived with Grok live
    validation, and the completed production profile did not advertise Grok.
- [x] P3-07: Validate Open WebUI streaming, cancellation, and isolation.
  - Acceptance: Codex renders incrementally, buffered backends are labeled,
    cancelling a chat terminates provider work or uses a documented,
    timeout-bounded detach, and two concurrent chats cannot observe each
    other's history.
  - Validation:
    `OPEN_WEBUI_MODELS=gpt-5.6-sol OPEN_WEBUI_ALLOW_BOUNDED_DETACH=true
    scripts/test-open-webui-compat.sh --cases stream,cancel,isolation
    --require-live`.
  - Completed: 2026-07-26 against Open WebUI `v0.9.5`. Its Stop action could
    detach without closing the upstream relay; direct proxy cancellation still
    terminated Codex.
- [x] P3-08: Validate one advertised Open WebUI function-tool loop.
  - Acceptance: Open WebUI sends a function definition, receives a compatible
    call with stable ID and arguments, returns the tool result, and displays the
    final model response for each backend that advertises tool calling.
  - Validation:
    `OPEN_WEBUI_MODELS=gpt-5.6-sol scripts/test-open-webui-compat.sh
    --cases tools --require-live`.
  - Completed: 2026-07-26 with a stable function call ID, arguments, tool
    result, and final response.
- [x] P3-09: Validate native, Docker, and Podman Open WebUI topologies.
  - Acceptance: documented URLs work for a native process, a Docker container,
    and a Podman container; host reachability does not require publishing the
    proxy to an untrusted interface.
  - Validation:
    `OPEN_WEBUI_MODELS=gpt-5.6-sol
    scripts/test-open-webui-topologies.sh --all`.
  - Completed: 2026-07-26 for native Python 3.11, Docker, and Podman using
    loopback-only host networking.
- [x] P3-10: Define Open WebUI optional-capability and background-task
      behavior.
  - Acceptance: documentation states which backend handles embeddings, RAG,
    speech, and images; title, tag, follow-up, and memory-related model calls
    are disabled for the Phase 3 production profile and documented for separate
    routing if later enabled. Each foreground chat is visible in accounting.
  - Validation: configuration review plus an Open WebUI request-count fixture
    with background model work disabled.
  - Completed: 2026-07-26. The disabled-background accounting fixture recorded
    exactly one proxy request for one foreground Open WebUI chat. Accounting
    with background model work enabled remained outside this task's scope.
- [x] P3-11: Return actionable compatibility and reauthentication errors.
  - Acceptance: unsupported fields, missing model mappings, missing logins,
    expired logins, and unreachable providers are distinguishable without
    exposing executable paths, account identifiers, or tokens.
  - Validation: error-shape tests and sanitized live negative tests.
  - Completed: 2026-07-26 with sanitized error-shape and provider-login tests.

## Historical Phase 3 exit gate

The commands below record what passed in Phase 3; they are not the current
release gate. Current validation is defined by the Phase 4 checks in
[TASKS.md](../TASKS.md), which require current-user ownership, Herdr-managed
execution, and Herdr visibility for every built-in CLI provider request.

```bash
npm run typecheck
npm test
scripts/test-client-compat.sh --client codex --require-live
scripts/test-provider-auth.sh --providers codex --require-live
OPEN_WEBUI_MODELS=gpt-5.6-sol OPEN_WEBUI_ALLOW_BOUNDED_DETACH=true \
  scripts/test-open-webui-compat.sh --all --require-live
OPEN_WEBUI_MODELS=gpt-5.6-sol scripts/test-open-webui-topologies.sh --all
```

Historical rollback: keep Chat Completions available and remove unsupported
models from Open WebUI discovery while a client-specific regression is
corrected.
