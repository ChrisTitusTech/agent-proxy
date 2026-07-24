#!/usr/bin/env bash
# Run the provider-independent OpenAI Responses compatibility contract.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_DIR"

if [[ ${1:-} == "--require-live" ]]; then
	: "${AGENT_PROXY_BASE_URL:?Set AGENT_PROXY_BASE_URL for --require-live}"
	: "${PROXY_API_KEY:?Set PROXY_API_KEY for --require-live}"
	: "${AGENT_PROXY_MODEL:?Set AGENT_PROXY_MODEL for --require-live}"

	TEST_DIR=$(mktemp -d)
	trap 'rm -rf "$TEST_DIR"' EXIT
	AUTH_HEADERS="$TEST_DIR/auth-headers"
	umask 077
	printf 'Authorization: Bearer %s\nContent-Type: application/json\n' \
		"$PROXY_API_KEY" >"$AUTH_HEADERS"

	curl --silent --show-error --fail \
		-H "@$AUTH_HEADERS" \
		-d "$(printf '{"model":"%s","input":"Reply with exactly: phase-two-ok"}' "$AGENT_PROXY_MODEL")" \
		"${AGENT_PROXY_BASE_URL%/}/v1/responses" \
		>"$TEST_DIR/response.json"

	RESPONSE_FILE="$TEST_DIR/response.json" node --input-type=module -e '
import { readFileSync } from "node:fs";
const response = JSON.parse(readFileSync(process.env.RESPONSE_FILE, "utf8"));
if (response.object !== "response" || response.status !== "completed") {
  throw new Error("Live Responses request did not complete");
}
if (!Array.isArray(response.output) || response.output.length === 0) {
  throw new Error("Live Responses request returned no output items");
}
'

	curl --silent --show-error --fail --no-buffer \
		-H "@$AUTH_HEADERS" \
		-d "$(printf '{"model":"%s","input":"Reply with exactly: phase-two-stream-ok","stream":true}' "$AGENT_PROXY_MODEL")" \
		"${AGENT_PROXY_BASE_URL%/}/v1/responses" \
		>"$TEST_DIR/stream.sse"

	grep -q '^event: response.created$' "$TEST_DIR/stream.sse"
	grep -q '^event: response.output_text.delta$' "$TEST_DIR/stream.sse"
	grep -q '^event: response.completed$' "$TEST_DIR/stream.sse"

	printf 'Live Responses compatibility passed for %s.\n' "$AGENT_PROXY_MODEL"
	exit 0
fi

if [[ $# -ne 0 ]]; then
	printf 'Usage: %s [--require-live]\n' "${0##*/}" >&2
	exit 2
fi

npx vitest run packages/server/src/routes/v1/responses.test.ts
printf 'Provider-independent Responses compatibility passed.\n'
