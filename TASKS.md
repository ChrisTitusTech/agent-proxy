# agent-proxy implementation tasks

This file tracks work derived from [SPEC.md](./SPEC.md) and
[ROADMAP.md](./ROADMAP.md). A task is complete only when its listed validation
passes.

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
