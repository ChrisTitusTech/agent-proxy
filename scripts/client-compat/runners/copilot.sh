#!/usr/bin/env bash
# Exercise GitHub Copilot CLI through the OpenAI-compatible localhost API.

set -euo pipefail

MODEL=${AGENT_PROXY_COPILOT_MODEL:-gpt-5.6-sol}
TURN_TIMEOUT=${AGENT_PROXY_COMPAT_TURN_TIMEOUT:-180}
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_PROVIDER_BASE_URL="${AGENT_PROXY_BASE_URL%/}/v1"
export COPILOT_PROVIDER_API_KEY="$PROXY_API_KEY"
export COPILOT_MODEL="$MODEL"
export COPILOT_OFFLINE=true
mkdir -p "$COMPAT_FIXTURE_DIR"

run_copilot() {
	local stream=$1
	local prompt=$2
	local workspace=${3:-"$COMPAT_WORKSPACE"}
	timeout --signal=TERM --kill-after=5s "${TURN_TIMEOUT}s" \
		"$COMPAT_CLIENT_BINARY" \
		--prompt "$prompt" \
		--silent \
		--stream "$stream" \
		--no-custom-instructions \
		--disable-builtin-mcps \
		--no-remote \
		--no-auto-update \
		--allow-all-tools \
		-C "$workspace"
}

run_copilot off \
	'Reply with exactly COPILOT_PROXY_TEXT_OK and do not use tools.' \
	>"$COMPAT_FIXTURE_DIR/text.txt"
rg -q 'COPILOT_PROXY_TEXT_OK' "$COMPAT_FIXTURE_DIR/text.txt"

run_copilot on \
	'Reply with exactly COPILOT_PROXY_STREAM_OK and do not use tools.' \
	>"$COMPAT_FIXTURE_DIR/stream.txt"
rg -q 'COPILOT_PROXY_STREAM_OK' "$COMPAT_FIXTURE_DIR/stream.txt"

printf 'seed\n' >"$COMPAT_WORKSPACE/copilot-tool.txt"
run_copilot on \
	'Use a shell tool to replace copilot-tool.txt with exactly COPILOT_TOOL_OK, then reply exactly COPILOT_TOOL_DONE.' \
	>"$COMPAT_FIXTURE_DIR/tool-loop.txt"
[[ $(tr -d '\r\n' <"$COMPAT_WORKSPACE/copilot-tool.txt") == COPILOT_TOOL_OK ]]
rg -q 'COPILOT_TOOL_DONE' "$COMPAT_FIXTURE_DIR/tool-loop.txt"

mkdir -p "$COMPAT_WORKSPACE/isolation-a" "$COMPAT_WORKSPACE/isolation-b"
run_copilot on 'Reply exactly COPILOT_ISOLATION_ALPHA. Do not use tools.' \
	"$COMPAT_WORKSPACE/isolation-a" >"$COMPAT_FIXTURE_DIR/isolation-a.txt" &
pid_a=$!
run_copilot on 'Reply exactly COPILOT_ISOLATION_BETA. Do not use tools.' \
	"$COMPAT_WORKSPACE/isolation-b" >"$COMPAT_FIXTURE_DIR/isolation-b.txt" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
rg -q 'COPILOT_ISOLATION_ALPHA' "$COMPAT_FIXTURE_DIR/isolation-a.txt"
if rg -q 'COPILOT_ISOLATION_BETA' "$COMPAT_FIXTURE_DIR/isolation-a.txt"; then
	exit 1
fi
rg -q 'COPILOT_ISOLATION_BETA' "$COMPAT_FIXTURE_DIR/isolation-b.txt"
if rg -q 'COPILOT_ISOLATION_ALPHA' "$COMPAT_FIXTURE_DIR/isolation-b.txt"; then
	exit 1
fi
