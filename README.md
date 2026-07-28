# agent-proxy

[![CI](https://github.com/ChrisTitusTech/agent-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/ChrisTitusTech/agent-proxy/actions/workflows/ci.yml)

`agent-proxy` is a single-user Linux desktop gateway for installed and
authenticated AI command-line tools. Local applications use familiar OpenAI
and Anthropic HTTP endpoints while the gateway launches Claude Code, Codex,
Google Antigravity, or Grok Build as visible agents in the logged-in user's
Herdr session.

## Project origin

This project is a focused refactor of
[starhunt/star-cliproxy](https://github.com/starhunt/star-cliproxy). The original
project supplied the initial provider, routing, dashboard, and compatibility
work. This fork narrows that foundation to a maintainable English-only Linux
server and credits the upstream project for that work.

## Status

Status updated: 2026-07-28

Phases 4 and 5 are complete. The supported deployment is owned by the logged-in
user, all CLI-provider inference runs in that user's Herdr session, and queue,
session, cancellation, fallback, and terminal-state behavior are bounded.
Live acceptance passes with Codex, GitHub Copilot CLI, and Open WebUI. Claude
and Grok remain disabled unless their normal current-user subscriptions are
authenticated.

See [SPEC.md](./SPEC.md) for the product contract and
[ROADMAP.md](./ROADMAP.md) for implementation phases.

## Built-in CLI backends

| Backend | Executable | Authentication |
| --- | --- | --- |
| Claude Code | `claude` | Complete the normal Claude Code login |
| Codex | `codex` | Complete the normal Codex login |
| Google Antigravity | `agy` | Complete the normal Google login |
| Grok Build | `grok` | Run `grok login` |

The target runtime invokes these tools in the current user's Herdr session.
Provider credentials remain in that user's normal CLI-owned state;
`agent-proxy` does not return or store provider tokens in its database. Each
user is responsible for complying with the terms and usage limits of every
configured provider.

## API surface

| Endpoint | Intended client contract |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat clients |
| `POST /v1/responses` | Codex, Grok, and Responses API clients |
| `POST /v1/messages` | Claude Code and Anthropic SDK clients |
| `GET /v1/models` | Model discovery |
| `GET /health` | Minimal unauthenticated liveness; authenticated readiness |
| `/admin/*` | Authenticated configuration and observability |

The server also retains optional generic CLI and OpenAI-compatible HTTP
adapters. They are extension points, not first-class backends.

The Responses subset supports text and image input items, instructions,
function tools, typed streaming events, cancellation, and bounded
`previous_response_id` continuation. Continuation is kept in memory, scoped to
the API key or `X-Agent-Proxy-Session-Id`, and expires according to the
`responses` configuration. See
[docs/responses-api.md](./docs/responses-api.md) for the exact contract and
limitations.

Custom HTTP providers reject localhost, LAN, link-local, and other reserved
network targets by default. Enable `allow_private_network` only when connecting
to an operator-controlled local service such as Ollama. HTTP provider timeouts
must be between 1 and 600 seconds, and redirects are rejected.

## Requirements

- Linux
- Node.js 24 or newer
- npm
- Herdr installed for the current user
- At least one supported CLI installed and authenticated for the current user
- A writable directory for SQLite data and logs

## Current-user quick start

Build a release and install it without root:

```bash
npm ci
scripts/build-release.sh
scripts/install.sh install --archive dist/releases/agent-proxy-*-linux-*.tar.gz
systemctl --user status herdr.service agent-proxy.service
```

The installer generates owner-only admin and proxy credentials, installs
versioned releases and user units in XDG directories, and starts both services
for the login session. The API defaults to `127.0.0.1:8300`.

For development:

```bash
cp config.example.yaml config.yaml
export ADMIN_TOKEN="$(openssl rand -hex 32)"
export PROXY_API_KEY="sk-proxy-$(openssl rand -hex 24)"
npm run build
npm start --workspace=packages/server
```

The dashboard development server listens on `127.0.0.1:5300`.

The authenticated `/admin/health` endpoint reports Herdr readiness and provider
availability. Provider tokens and account identifiers are never returned by the
admin API.

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

The server container is a legacy build target and cannot satisfy the
current-user Herdr execution contract. Containerized Open WebUI remains a
supported API client topology; containerized `agent-proxy` is not a stable
deployment target.

Set `AGENT_PROXY_UPSTREAM` on the dashboard container to the server URL visible
from its container network. Its standalone-safe default is
`http://127.0.0.1:8300`.

See [Open WebUI compatibility](./docs/open-webui-compatibility.md) for the
pinned release, loopback-only native/Docker/Podman topologies, background-task
settings, and the live validation commands.

## Client examples

Claude Code can use an Anthropic-compatible gateway:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8300
export ANTHROPIC_AUTH_TOKEN=sk-proxy-replace-me
claude
```

Codex can use a custom Responses provider in `~/.codex/config.toml`:

```toml
model = "gpt-5.6-sol"
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

These client examples define the intended compatibility target. The Responses
wire contract is covered by OpenAI SDK and provider-adapter tests. Native Codex
passes. Claude and Grok require their own live acceptance before either is
enabled in a future production profile.

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
npm run lint:dead-code
bash -n start.sh
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the complete contributor workflow
and [SECURITY.md](./SECURITY.md) for private vulnerability reporting.

See [docs/linux-service.md](./docs/linux-service.md) for the current-user
login-session runbook.

## References

- [OpenAI Responses streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal/delta)
- [Claude Code LLM gateway configuration](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)
- [Grok Build custom model configuration](https://docs.x.ai/build/overview)

## License

This project is licensed under the MIT License; see [LICENSE](./LICENSE).
Upstream attribution and notice obligations must still be confirmed before the
stable release.
