#!/usr/bin/env bash
# Exercise an unmodified Grok Build client through a custom Responses model.

set -euo pipefail

MODEL_ALIAS=${AGENT_PROXY_GROK_MODEL_ALIAS:-agent-proxy}
MODEL=${AGENT_PROXY_GROK_MODEL:-grok-build}
TURN_TIMEOUT=${AGENT_PROXY_COMPAT_TURN_TIMEOUT:-180}
export AGENT_PROXY_API_KEY="$PROXY_API_KEY"
mkdir -p -- "$HOME/.grok" "$COMPAT_FIXTURE_DIR"

base_url=${AGENT_PROXY_BASE_URL%/}/v1
{
	printf '[model.%s]\n' "$MODEL_ALIAS"
	printf 'model = "%s"\n' "$MODEL"
	printf 'base_url = "%s"\n' "$base_url"
	printf 'name = "agent-proxy"\n'
	printf 'env_key = "AGENT_PROXY_API_KEY"\n'
	printf '\n[models]\n'
	printf 'default = "%s"\n' "$MODEL_ALIAS"
} >"$HOME/.grok/config.toml"
chmod 0600 "$HOME/.grok/config.toml"

(
	cd "$COMPAT_WORKSPACE"
	"$COMPAT_CLIENT_BINARY" inspect --json >"$COMPAT_FIXTURE_DIR/inspect.json"
)

run_grok_in_workspace() {
	local workspace=$1
	shift
	timeout --signal=TERM --kill-after=5s "${TURN_TIMEOUT}s" \
		"$COMPAT_CLIENT_BINARY" \
		--cwd "$workspace" \
		--model "$MODEL_ALIAS" \
		--output-format streaming-json \
		--permission-mode bypassPermissions \
		--no-memory \
		--no-subagents \
		--disable-web-search \
		"$@"
}

run_grok() {
	run_grok_in_workspace "$COMPAT_WORKSPACE" "$@"
}

run_grok --tools '' --single \
	'Reply with exactly GROK_PROXY_TEXT_OK.' \
	>"$COMPAT_FIXTURE_DIR/text.jsonl"
rg -q 'GROK_PROXY_TEXT_OK' "$COMPAT_FIXTURE_DIR/text.jsonl"

run_grok --tools '' --single \
	'Reply with exactly GROK_PROXY_STREAM_OK.' \
	>"$COMPAT_FIXTURE_DIR/stream.jsonl"
rg -q 'GROK_PROXY_STREAM_OK' "$COMPAT_FIXTURE_DIR/stream.jsonl"
[[ $(wc -l <"$COMPAT_FIXTURE_DIR/stream.jsonl") -gt 1 ]]

printf 'seed\n' >"$COMPAT_WORKSPACE/grok-tool.txt"
run_grok --tools 'write' --single \
	'Use a filesystem tool to replace grok-tool.txt with exactly GROK_TOOL_OK, then reply exactly GROK_TOOL_DONE.' \
	>"$COMPAT_FIXTURE_DIR/tool-loop.jsonl"
[[ $(tr -d '\r\n' <"$COMPAT_WORKSPACE/grok-tool.txt") == GROK_TOOL_OK ]]

isolation_workspace="$COMPAT_WORKSPACE/isolation"
mkdir -p -- "$isolation_workspace/a" "$isolation_workspace/b"
(
	run_grok_in_workspace "$isolation_workspace/a" --tools '' --single \
		'Reply with exactly GROK_ISOLATION_ALPHA.' \
		>"$COMPAT_FIXTURE_DIR/isolation-a.jsonl"
) &
pid_a=$!
(
	run_grok_in_workspace "$isolation_workspace/b" --tools '' --single \
		'Reply with exactly GROK_ISOLATION_BETA.' \
		>"$COMPAT_FIXTURE_DIR/isolation-b.jsonl"
) &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
rg -q 'GROK_ISOLATION_ALPHA' "$COMPAT_FIXTURE_DIR/isolation-a.jsonl"
if rg -q 'GROK_ISOLATION_BETA' "$COMPAT_FIXTURE_DIR/isolation-a.jsonl"; then
	exit 1
fi
rg -q 'GROK_ISOLATION_BETA' "$COMPAT_FIXTURE_DIR/isolation-b.jsonl"
if rg -q 'GROK_ISOLATION_ALPHA' "$COMPAT_FIXTURE_DIR/isolation-b.jsonl"; then
	exit 1
fi

set +e
timeout --signal=TERM --kill-after=5s 1s \
	"$COMPAT_CLIENT_BINARY" \
	--cwd "$COMPAT_WORKSPACE" \
	--model "$MODEL_ALIAS" \
	--output-format streaming-json \
	--permission-mode dontAsk \
	--no-memory \
	--no-subagents \
	--disable-web-search \
	--tools '' \
	--single \
	'Compatibility cancellation probe: produce a long response for at least thirty seconds.' \
	>"$COMPAT_FIXTURE_DIR/cancellation.jsonl" 2>&1
cancel_status=$?
set -e
[[ "$cancel_status" -eq 124 || "$cancel_status" -eq 137 ]]
printf 'cancel_exit=%s\n' "$cancel_status" >"$COMPAT_FIXTURE_DIR/cancellation-status.txt"
