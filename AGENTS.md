# Repository agent instructions

## Product contract

`agent-proxy` is a per-login-user Linux desktop gateway. Local API clients
submit inference requests, and every request routed to a built-in CLI must
create or reuse a Herdr-managed agent owned by the current user.

Treat these requirements as hard boundaries:

- Do not introduce a dedicated `agent-proxy` Unix account.
- Do not require root for normal install, upgrade, rollback, backup, or
  uninstall operations.
- Use the user-owned XDG paths defined in `SPEC.md`.
- Do not launch built-in provider processes invisibly outside Herdr.
- Do not add a silent headless fallback when Herdr is unavailable.
- Health, model discovery, and admin-only requests must not spawn agents.
- Keep the localhost API authenticated even though it binds to loopback. The
  only exception is a minimal unauthenticated `/health` liveness response that
  exposes no provider, Herdr, version, path, or configuration details.
- Prevent child provider configurations from recursively calling this proxy.

## Planning sources

Read these files before changing product behavior:

1. `SPEC.md` defines the product contract.
2. `ROADMAP.md` defines phase boundaries and acceptance criteria.
3. `TASKS.md` defines implementation tasks and validation.

Phases 4 and 5 are complete. New work must preserve the user-owned Herdr
execution and provider-reliability exit gates while following the next planned
phase in `ROADMAP.md`. Do not mark a task complete until its listed validation
passes.

## Implementation guidance

- Keep provider protocol translation separate from Herdr process lifecycle.
- Use structured owner-only IPC for provider input and output; never scrape
  rendered terminal text.
- Pass executable arguments as arrays and avoid shell interpolation.
- Serialize or isolate concurrent turns that share a Herdr pane.
- Correlate every provider attempt with request, client session, provider,
  model, pane, and terminal state.
- Map cancellation, timeout, fallback, and shutdown to one terminal pane and
  provider state.
- Treat paths, API keys, provider credentials, prompts, and raw output as
  sensitive.
- Update `SPEC.md`, `ROADMAP.md`, and `TASKS.md` together when requirements or
  phase scope change.

## Dynamic entry points

Static dead-code tools must retain these dynamically launched files:

- `packages/server/src/herdr/worker.ts`
- `packages/server/src/herdr/server.ts`
- `scripts/client-compat/redact.mjs`
- `scripts/openwebui/compat.mjs`

Remove them only when their launchers and the associated feature are removed in
the same change.

`pino-pretty` is also loaded dynamically by the Fastify logger transport target
in `packages/server/src/app.ts`; it is a production runtime dependency even
though static import analysis cannot see it.

## Validation

Run focused tests while developing, then the complete local gate:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint:dead-code
scripts/validate-shell.sh
git diff --check
```

Use the phase-specific live and manual checks from `TASKS.md`. A green unit
suite does not replace current-user Herdr, Copilot, Codex, or Open WebUI
acceptance evidence.

Before calling a pull request ready, require current-head CI, an independent
review, no actionable unresolved review threads, a clean worktree, and planning
documents that match the implementation.
