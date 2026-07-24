# Responses API subset

`POST /v1/responses` implements the Phase 2 OpenAI Responses compatibility
contract. The endpoint remains experimental until the native Codex, Grok, and
Open WebUI acceptance matrix passes in Phase 3.

## Supported requests

The request schema accepts:

- `model`
- `input` as a string or an array of message, `function_call`, and
  `function_call_output` items
- `instructions`
- `stream`
- function `tools` and `tool_choice`
- `max_output_tokens`
- `reasoning.effort` and `reasoning.summary`
- `previous_response_id`
- `store`, string-valued `metadata`, `parallel_tool_calls`, and `temperature`

Message content accepts `input_text`, `output_text`, and `input_image` parts.
Image URLs are translated to the OpenAI Chat Completions `image_url` shape for
HTTP providers. `file_id` images require a provider adapter that supports that
source natively.
Function tools use the Responses shape with `name`, `description`,
`parameters`, and `strict`. Built-in OpenAI-hosted tools are not implemented;
an unsupported tool type returns an `invalid_request_error` identifying its
exact parameter.

## Output and streaming

Non-streaming responses include a stable `resp_` ID, status, model, typed
output items, usage, reasoning summaries when provided by the backend, and
function calls with their original `call_id`.

Streaming uses typed Server-Sent Events. Text responses emit creation,
in-progress, output-item, content-part, delta, done, and terminal events in
order. Function arguments use their corresponding delta and done events.
Failures after streaming begins emit one terminal `response.failed` event.

The proxy streams incrementally when the provider does. A provider with a
buffered fallback emits valid Responses events after its complete result
arrives.

Operator validation limits apply to message text, function arguments and
outputs, image references, and both buffered and streamed response text.
Oversized streamed text is capped and terminates as `response.incomplete`.

## Continuation

`previous_response_id` references bounded in-memory context:

- Context is isolated by API key or `X-Agent-Proxy-Session-Id`.
- A different model returns `model_mismatch`.
- An unknown, expired, cross-client, or post-restart ID returns
  `response_not_found`.
- Top-level `instructions` are not carried forward; resend them on every
  request.
- `store: false` prevents retention of the new response.
- `responses.retention_ttl_ms` defaults to 30 minutes.
- `responses.max_entries` defaults to 1000.

The proxy retains normalized input and output items, not provider credentials
or subscription tokens.

## Function loops

Client function tools are forwarded through the provider contract. Providers
that return tool calls produce Responses `function_call` output items. Send a
matching `function_call_output` item with the returned `call_id`, normally with
`previous_response_id`, to complete the loop.

`parallel_tool_calls: false` is forwarded to compatible HTTP providers and
enforced on provider output. Named `tool_choice` requests are also validated
against returned function calls so an adapter cannot silently return a
different tool.

Native CLIs do not automatically gain arbitrary client-function support. Tool
loops work only when the selected provider adapter emits client-visible tool
calls. Phase 3 determines which Codex and Grok versions and execution profiles
can advertise that capability.

## Validation

Run the self-contained SDK and provider matrix:

```bash
scripts/test-responses-compat.sh
```

Run an operator-approved live text and streaming smoke:

```bash
AGENT_PROXY_BASE_URL=http://127.0.0.1:8300 \
PROXY_API_KEY=sk-proxy-replace-me \
AGENT_PROXY_MODEL=gpt-5.6-sol \
scripts/test-responses-compat.sh --require-live
```

The live command does not print the API key or provider credentials.
