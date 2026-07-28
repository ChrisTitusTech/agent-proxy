# Live client compatibility harness

`scripts/test-client-compat.sh` is the sanitized acceptance entrypoint for
unmodified Claude Code, Codex, GitHub Copilot CLI, and Grok Build clients. The
harness owns isolation, prerequisite handling, evidence capture, and redaction.
The current-user Phase 4 release gate requires the Codex and Copilot runners;
Claude and Grok require an authenticated subscription before required-live use.

## Usage

```bash
export AGENT_PROXY_BASE_URL=http://127.0.0.1:8300
export PROXY_API_KEY=sk-proxy-replace-me
export AGENT_PROXY_ADMIN_TOKEN=replace-with-admin-token

scripts/test-client-compat.sh --client codex
scripts/test-client-compat.sh --all --require-live
```

Each ordinary live client turn is bounded to 180 seconds. Set
`AGENT_PROXY_COMPAT_TURN_TIMEOUT` to a positive number of seconds when a slow
subscription backend needs a larger test window. The cancellation fixture
keeps its own shorter timeout.

Without `--require-live`, an unavailable executable or runner is reported as a
skip. Release and acceptance gates use `--require-live`, which converts every
skip into a failure.

Sanitized evidence is written to
`dist/client-compat/<timestamp>-<pid>/<client>/` by default. Use
`--artifacts-dir DIR` to select an empty destination. Each completed runner
produces:

- `metadata.json`, containing the client version, running server version,
  harness revision, timestamp, base URL, result, and runner exit code.
- `fixtures/`, containing sanitized runner output, server health metadata, and
  captured protocol fixtures.

The evidence directory is operator-owned test output and is ignored by Git.
Review it before sharing even though the harness applies automatic redaction.

## Isolation and secrets

Every runner receives a new temporary `HOME`, workspace, temporary directory,
and XDG config, cache, data, and runtime directories. The harness passes only a
minimal environment and removes the temporary tree after the runner exits,
fails, or receives a termination signal.

The proxy key is passed through the runner environment, never through command
arguments. The admin token is passed only when configured and is required for
the required-live cancellation check. Evidence redaction removes the exact
configured proxy or provider secrets and common authorization headers, cookies,
token fields, and query parameters. Protocol fixtures must be UTF-8 text;
binary artifacts are rejected.

Do not place account credentials in client arguments, filenames, fixture
filenames, or the base URL. `AGENT_PROXY_BASE_URL` must be a bare HTTP(S)
origin: no credentials, no path other than `/` (`/v1` is rejected), no query,
and no fragment. The runners append the required API paths themselves.

## Runner contract

The default runner directory is `scripts/client-compat/runners/`. A runner is
named `<client>.sh` and receives this clean environment:

- `AGENT_PROXY_BASE_URL`
- `PROXY_API_KEY`
- `COMPAT_CLIENT`
- `COMPAT_CLIENT_BINARY`
- `COMPAT_FIXTURE_DIR`
- `COMPAT_WORKSPACE`
- `AGENT_PROXY_COMPAT_TURN_TIMEOUT`
- `AGENT_PROXY_COMPAT_REQUIRE_LIVE`
- `AGENT_PROXY_ADMIN_TOKEN`, when configured
- isolated `HOME`, `TMPDIR`, and XDG paths
- the host `PATH` and locale

The runner writes non-secret request, response, streaming, cancellation, and
tool-loop fixtures below `COMPAT_FIXTURE_DIR`. Its standard output and error are
captured as another fixture.

Exit status `0` means pass, `77` means skip, and any other status means fail.
Required-live mode rejects both skips and failures.

## Self-test

The self-test uses fake clients, a local fake health endpoint, and synthetic
credentials. It performs no provider login or model request.

```bash
scripts/test-client-compat-self-test.sh
```

It verifies metadata, redaction, isolated state, cleanup after success and
failure, optional skip behavior, and required-live failure behavior.
