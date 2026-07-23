# agent-proxy

[![CI](https://github.com/ChrisTitusTech/agent-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/ChrisTitusTech/agent-proxy/actions/workflows/ci.yml)

`agent-proxy` is a Linux-first API gateway for installed and authenticated AI
command-line tools. It exposes familiar OpenAI and Anthropic HTTP endpoints
while routing requests to Claude Code, Codex, Google Antigravity, or Grok Build.

## Project origin

This project is a focused refactor of
[starhunt/star-cliproxy](https://github.com/starhunt/star-cliproxy). The original
project supplied the initial provider, routing, dashboard, and compatibility
work. This fork narrows that foundation to a maintainable English-only Linux
server and credits the upstream project for that work.

## Status

The repository contains a working gateway foundation, but the full drop-in
compatibility target is still in progress. Chat Completions and Anthropic
Messages are the most mature paths. The Responses adapter exists, but complete
Codex and Grok tool-loop compatibility is a roadmap item.

See [SPEC.md](./SPEC.md) for the product contract and
[ROADMAP.md](./ROADMAP.md) for implementation phases.

## Built-in CLI backends

| Backend | Executable | Authentication |
| --- | --- | --- |
| Claude Code | `claude` | Complete the normal Claude Code login |
| Codex | `codex` | Complete the normal Codex login |
| Google Antigravity | `agy` | Complete the normal Google login |
| Grok Build | `grok` | Run `grok login` |

The server invokes these tools as child processes. It does not copy or manage
their credentials. Each operator is responsible for complying with the terms
and usage limits of every configured provider.

## API surface

| Endpoint | Intended client contract |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat clients |
| `POST /v1/responses` | Codex, Grok, and Responses API clients |
| `POST /v1/messages` | Claude Code and Anthropic SDK clients |
| `GET /v1/models` | Model discovery |
| `GET /health` | Unauthenticated service health |
| `/admin/*` | Authenticated configuration and observability |

The server also retains optional generic CLI and OpenAI-compatible HTTP
adapters. They are extension points, not first-class backends.

Custom HTTP providers reject localhost, LAN, link-local, and other reserved
network targets by default. Enable `allow_private_network` only when connecting
to an operator-controlled local service such as Ollama. HTTP provider timeouts
must be between 1 and 600 seconds, and redirects are rejected.

## Requirements

- Linux
- Node.js 24 or newer
- npm
- At least one supported CLI installed and authenticated for the service user
- A writable directory for SQLite data and logs

## Quick start

```bash
npm ci
cp .env.example .env
cp config.example.yaml config.yaml

node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('sk-proxy-' + require('crypto').randomBytes(24).toString('hex'))"

npm run build
npm start --workspace=packages/server
```

Put the first generated value in `ADMIN_TOKEN` and the second in
`PROXY_API_KEY`. The defaults bind to `127.0.0.1:8300`.

For development:

```bash
./start.sh start
./start.sh status
./start.sh stop
```

The dashboard development server listens on `127.0.0.1:5300`.

## Containers

The Dockerfile provides `server` and `dashboard` targets:

```bash
docker build --target server --tag agent-proxy-server .
docker build --target dashboard --tag agent-proxy-dashboard .
```

The server image binds to `0.0.0.0:8300` and accepts these deployment
overrides:

- `AGENT_PROXY_HOST`
- `AGENT_PROXY_PORT`
- `AGENT_PROXY_DATABASE_PATH`
- `ADMIN_TOKEN`

Mount an operator-owned `config.yaml`, persistent data directory, supported CLI
binaries, and the authenticated service-user state required by those CLIs.

Set `AGENT_PROXY_UPSTREAM` on the dashboard container to the server URL visible
from its container network. Its standalone-safe default is
`http://127.0.0.1:8300`.

## Client examples

Claude Code can use an Anthropic-compatible gateway:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8300
export ANTHROPIC_AUTH_TOKEN=sk-proxy-replace-me
claude
```

Codex can use a custom Responses provider in `~/.codex/config.toml`:

```toml
model = "gpt-5.5"
model_provider = "agent_proxy"

[model_providers.agent_proxy]
name = "agent-proxy"
base_url = "http://127.0.0.1:8300/v1"
env_key = "AGENT_PROXY_API_KEY"
wire_api = "responses"
```

```bash
export AGENT_PROXY_API_KEY=sk-proxy-replace-me
codex
```

Grok Build supports custom models in `~/.grok/config.toml`:

```toml
[model.agent-proxy]
model = "grok-build"
base_url = "http://127.0.0.1:8300/v1"
name = "agent-proxy"
env_key = "AGENT_PROXY_API_KEY"

[models]
default = "agent-proxy"
```

These client examples define the intended compatibility target. Until the
corresponding roadmap acceptance tests pass, treat complex tool calls,
streaming retries, and session continuation as experimental.

## Configuration

- `config.yaml` controls listeners, built-in providers, model mappings, rate
  limits, cache behavior, and validation limits.
- `.env` provides `ADMIN_TOKEN` and the initial `PROXY_API_KEY`.
- SQLite stores model mappings, keys, provider overrides, and request metadata.
- The dashboard can change supported runtime settings through `/admin/*`.

Never expose the API directly to the public internet without TLS, firewall
rules, strong tokens, and an upstream reverse proxy.

## Validation

```bash
npm run typecheck
npm test
npm run build
bash -n start.sh
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the complete contributor workflow
and [SECURITY.md](./SECURITY.md) for private vulnerability reporting.

Production systemd installation, upgrades, rollback, backup, restore, and
uninstall are documented in the
[Linux service operations runbook](./docs/linux-service.md).

## References

- [OpenAI Responses streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal/delta)
- [Claude Code LLM gateway configuration](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)
- [Grok Build custom model configuration](https://docs.x.ai/build/overview)

## License

No license file is currently included. License selection and confirmation of
upstream licensing are required before redistribution.
