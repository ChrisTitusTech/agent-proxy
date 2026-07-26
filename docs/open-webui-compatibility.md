# Open WebUI compatibility

Phase 3 pins Open WebUI `v0.9.5`. The compatibility scripts use a disposable
local Open WebUI account and delete their containers and native data when the
test completes. They never publish agent-proxy or Open WebUI beyond
`127.0.0.1`.

## Connection settings

Configure Open WebUI as a standard OpenAI-compatible client:

| Open WebUI location | OpenAI API base URL |
| --- | --- |
| Native process | `http://127.0.0.1:8300/v1` |
| Docker container with `--network=host` | `http://127.0.0.1:8300/v1` |
| Podman container with `--network=host` | `http://127.0.0.1:8300/v1` |

Use an agent-proxy API key as the OpenAI API key. Do not use the dashboard
admin token. The validation containers use host networking and force Open WebUI
itself to a random `127.0.0.1` port. This lets the container reach the proxy's
loopback listener without exposing either service on a LAN interface.

Run the live contract and topology matrices with:

```bash
export AGENT_PROXY_BASE_URL=http://127.0.0.1:8300
export PROXY_API_KEY=sk-proxy-replace-me
export AGENT_PROXY_ADMIN_TOKEN=replace-me
export OPEN_WEBUI_MODELS=gpt-5.6-sol
export OPEN_WEBUI_ALLOW_BOUNDED_DETACH=true

scripts/test-open-webui-compat.sh --all --require-live
scripts/test-open-webui-topologies.sh --all
```

The compatibility matrix uses Open WebUI's `/api/models` view for discovery
and its `/openai/chat/completions` relay for OpenAI protocol assertions. It
covers non-streaming chat, streaming SSE, browser cancellation,
concurrent-chat isolation, and a function-tool round trip. Codex is the
streaming and tool-capable baseline. Grok output is buffered by its provider
adapter, but Grok live validation is waived and it is disabled in this
installation because its subscription login would not complete. The accounting
fixture confirms that with background tasks disabled, one Open WebUI chat
produces exactly one accounted proxy request.

### Cancellation behavior in v0.9.5

Open WebUI `v0.9.5` accepts its browser Stop action and cancels the WebUI chat
task, but its OpenAI relay does not consistently close the upstream HTTP
stream. When that happens, agent-proxy safely detaches the browser and keeps
the provider process tracked until it exits or reaches the configured provider
timeout. The Phase 3 fixture reports whether cancellation terminated provider
work or used this bounded-detach fallback. Direct client disconnects from
agent-proxy still abort the provider process.

## Optional capabilities

agent-proxy Phase 3 supplies chat, Responses, and Anthropic Messages
compatibility. Open WebUI features outside that boundary need separate
backends:

| Capability | Phase 3 behavior |
| --- | --- |
| Embeddings and RAG | Configure a dedicated embedding provider. Do not route embedding requests to Codex or Grok aliases. |
| Speech-to-text and text-to-speech | Configure Open WebUI audio engines separately or leave them disabled. |
| Image generation | Configure a supported image backend separately or leave image generation disabled. |
| Web search and loaders | Open WebUI owns these integrations; they are not supplied by agent-proxy. |

Open WebUI task-model calls are additional model requests and therefore appear
as separate records in agent-proxy accounting. For the strict one-user-message
to one-provider-request profile used by validation, set:

```text
ENABLE_TITLE_GENERATION=False
ENABLE_TAGS_GENERATION=False
ENABLE_FOLLOW_UP_GENERATION=False
ENABLE_AUTOCOMPLETE_GENERATION=False
ENABLE_MEMORIES=False
```

If background features are wanted, set Open WebUI's external Task Model to a
dedicated alias and leave accounting enabled. This keeps titles, tags,
follow-ups, and autocomplete distinguishable from the primary chat model.
Open WebUI persists many admin configuration values after first startup, so
changing an environment variable later may not override the stored value.
Confirm the effective setting in Admin Panel > Settings > Interface.

## Native installation

The topology test uses Open WebUI with Python 3.11 through `uvx`:

```bash
DATA_DIR="$PWD/.open-webui" \
  OPENAI_API_BASE_URL=http://127.0.0.1:8300/v1 \
  OPENAI_API_KEY="$PROXY_API_KEY" \
  uvx --python 3.11 "open-webui==0.9.5" serve
```

Keep `DATA_DIR` outside the source tree for long-lived deployments and protect
it as user data. Use the container image for a production deployment; the
native process is part of the compatibility topology, not the recommended
service layout.
