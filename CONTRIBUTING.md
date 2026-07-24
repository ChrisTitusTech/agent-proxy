# Contributing to agent-proxy

Thank you for helping improve agent-proxy. Keep changes focused, reviewable,
and aligned with [SPEC.md](./SPEC.md) and [ROADMAP.md](./ROADMAP.md).

## Development setup

Requirements:

- Linux
- Node.js 24 or newer
- npm
- Optional authenticated provider CLIs for live integration tests

Install dependencies and validate the repository:

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

Tests that need an unavailable CLI must skip cleanly. Unit tests must not read,
modify, or delete a developer's normal provider sessions or credentials.

The live Codex resume test is opt-in because it creates a provider session and
uses the authenticated account:

```bash
RUN_CODEX_INTEGRATION=1 npm test -- \
  packages/server/src/providers/codex-cli-resume.integration.test.ts
```

## Pull requests

1. Create a focused branch.
2. Add tests for behavior changes and regressions.
3. Keep source, tests, errors, dashboard text, and documentation in English.
4. Never commit API keys, login state, prompts, private logs, or generated
   SQLite data.
5. Update documentation when behavior or configuration changes.
6. Run the complete validation suite before opening the pull request.

Provider executables must be spawned directly with argument arrays. Do not
construct shell command strings from request or configuration data.

## Compatibility claims

Do not describe an endpoint as drop-in compatible until its acceptance criteria
in `SPEC.md` and `ROADMAP.md` pass against an unmodified client. Document the
tested CLI and client versions.

## Licensing

The project uses the MIT License. Contributions must preserve
[LICENSE](./LICENSE) and required upstream attribution. Additional upstream
notice obligations remain under review before stable redistribution.
