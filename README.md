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

Status updated: 2026-07-27

Phase 3 protocol and client compatibility is complete for the historical
service-account deployment, with live Codex evidence and explicit Claude and
Grok waivers. Phase 4 is ready to replace the superseded machine-wide service
with a current-user runtime where every built-in provider invocation is managed
and visible through Herdr. The existing direct headless execution and
dedicated-service-user packaging remain implementation debt until Phase 4
passes.

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

## Phase 4 target requirements

- Linux
- Node.js 24 or newer
- npm
- Herdr installed for the current user
- At least one supported CLI installed and authenticated for the current user
- A writable directory for SQLite data and logs

## Historical Phase 3 quick start

The following commands start the historical Phase 3 headless development
baseline. They do not implement the target Herdr execution contract and must
not be used as evidence that Phase 4 is complete. Phase 4 will replace this
section with Herdr login-session startup and readiness instructions.

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

The Phase 4 dashboard will check the current user's provider authentication and
Herdr readiness. Provider tokens and account identifiers must never be returned
by the admin API.

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

The former machine-wide systemd runbook is retained only as historical Phase 1
evidence in [docs/linux-service.md](./docs/linux-service.md). Phase 4 replaces
it with a user-owned login-session runbook.

## References

- [OpenAI Responses streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal/delta)
- [Claude Code LLM gateway configuration](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)
- [Grok Build custom model configuration](https://docs.x.ai/build/overview)

## License

This project is licensed under the MIT License; see [LICENSE](./LICENSE).
Upstream attribution and notice obligations must still be confirmed before the
stable release.
