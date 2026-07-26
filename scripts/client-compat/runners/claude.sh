#!/usr/bin/env bash
# Exercise an unmodified Claude Code client against the Anthropic endpoint.

set -euo pipefail

MODEL=${AGENT_PROXY_CLAUDE_MODEL:-claude-sonnet-5}
TURN_TIMEOUT=${AGENT_PROXY_COMPAT_TURN_TIMEOUT:-180}
mkdir -p -- "$COMPAT_FIXTURE_DIR"

export ANTHROPIC_BASE_URL="$AGENT_PROXY_BASE_URL"
export ANTHROPIC_AUTH_TOKEN="$PROXY_API_KEY"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export CLAUDE_CODE_ATTRIBUTION_HEADER=0

run_claude() {
	timeout --signal=TERM --kill-after=5s "${TURN_TIMEOUT}s" \
		"$COMPAT_CLIENT_BINARY" \
		--print \
		--model "$MODEL" \
		--no-session-persistence \
		--setting-sources '' \
		"$@"
}

run_claude \
	--tools '' \
	--output-format json \
	'Reply with exactly CLAUDE_PROXY_TEXT_OK.' \
	>"$COMPAT_FIXTURE_DIR/text.json"

node -e '
const { readFileSync } = require("node:fs");
const result = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (result.is_error || result.result?.trim() !== "CLAUDE_PROXY_TEXT_OK") process.exit(1);
' "$COMPAT_FIXTURE_DIR/text.json"

run_claude \
	--tools '' \
	--output-format stream-json \
	--verbose \
	'Reply with exactly CLAUDE_PROXY_STREAM_OK.' \
	>"$COMPAT_FIXTURE_DIR/stream.jsonl"

node -e '
const { readFileSync } = require("node:fs");
const lines = readFileSync(process.argv[1], "utf8").trim().split(/\n+/).map(JSON.parse);
const final = lines.findLast((event) => event.type === "result");
if (!final || final.is_error || final.result?.trim() !== "CLAUDE_PROXY_STREAM_OK") process.exit(1);
if (!lines.some((event) => event.type === "assistant")) process.exit(1);
' "$COMPAT_FIXTURE_DIR/stream.jsonl"

printf 'seed\n' >"$COMPAT_WORKSPACE/claude-tool.txt"
(
	cd "$COMPAT_WORKSPACE"
	run_claude \
		--output-format json \
		--allowedTools Write \
		--dangerously-skip-permissions \
		'Use the Write tool to replace claude-tool.txt with exactly CLAUDE_TOOL_OK and then reply exactly CLAUDE_TOOL_DONE.' \
		>"$COMPAT_FIXTURE_DIR/tool-loop.json"
)
tool_result=$(<"$COMPAT_WORKSPACE/claude-tool.txt")
tool_result=${tool_result%$'\r'}
if [[ "$tool_result" != CLAUDE_TOOL_OK ]]; then
	printf 'Claude tool loop wrote %q; expected CLAUDE_TOOL_OK.\n' "$tool_result" >&2
	exit 1
fi

session_a=11111111-1111-4111-8111-111111111111
session_b=22222222-2222-4222-8222-222222222222
run_claude \
	--session-id "$session_a" \
	--tools '' \
	--output-format json \
	'Reply with exactly CLAUDE_ISOLATION_ALPHA.' \
	>"$COMPAT_FIXTURE_DIR/isolation-a.json"
run_claude \
	--session-id "$session_b" \
	--tools '' \
	--output-format json \
	'Reply with exactly CLAUDE_ISOLATION_BETA.' \
	>"$COMPAT_FIXTURE_DIR/isolation-b.json"
node -e '
const { readFileSync } = require("node:fs");
const a = JSON.parse(readFileSync(process.argv[1], "utf8")).result ?? "";
const b = JSON.parse(readFileSync(process.argv[2], "utf8")).result ?? "";
if (!a.includes("CLAUDE_ISOLATION_ALPHA") || a.includes("CLAUDE_ISOLATION_BETA")) process.exit(1);
if (!b.includes("CLAUDE_ISOLATION_BETA") || b.includes("CLAUDE_ISOLATION_ALPHA")) process.exit(1);
' "$COMPAT_FIXTURE_DIR/isolation-a.json" "$COMPAT_FIXTURE_DIR/isolation-b.json"

set +e
timeout --signal=TERM --kill-after=5s 1s \
	"$COMPAT_CLIENT_BINARY" \
	--print \
	--model "$MODEL" \
	--tools '' \
	--no-session-persistence \
	--setting-sources '' \
	--output-format stream-json \
	--verbose \
	'Compatibility cancellation probe: produce a long response for at least thirty seconds.' \
	>"$COMPAT_FIXTURE_DIR/cancellation.jsonl" 2>&1
cancel_status=$?
set -e
[[ "$cancel_status" -eq 124 || "$cancel_status" -eq 137 ]]
printf 'cancel_exit=%s\n' "$cancel_status" >"$COMPAT_FIXTURE_DIR/cancellation-status.txt"
