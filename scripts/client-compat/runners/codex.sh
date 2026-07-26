#!/usr/bin/env bash
# Exercise an unmodified Codex client through a custom Responses provider.

set -euo pipefail

MODEL=${AGENT_PROXY_CODEX_MODEL:-gpt-5.6-sol}
TURN_TIMEOUT=${AGENT_PROXY_COMPAT_TURN_TIMEOUT:-180}
export CODEX_HOME="$XDG_CONFIG_HOME/codex"
export AGENT_PROXY_API_KEY="$PROXY_API_KEY"
mkdir -p -- "$CODEX_HOME" "$COMPAT_FIXTURE_DIR"

base_url=${AGENT_PROXY_BASE_URL%/}/v1
{
	printf 'model = "%s"\n' "$MODEL"
	printf 'model_provider = "agent_proxy"\n'
	printf 'approval_policy = "never"\n'
	printf 'sandbox_mode = "workspace-write"\n'
	printf '\n[model_providers.agent_proxy]\n'
	printf 'name = "agent-proxy"\n'
	printf 'base_url = "%s"\n' "$base_url"
	printf 'env_key = "AGENT_PROXY_API_KEY"\n'
	printf 'wire_api = "responses"\n'
	printf '\n[features]\n'
	printf 'apps = false\n'
	printf 'browser_use = false\n'
	printf 'code_mode_host = false\n'
	printf 'goals = false\n'
	printf 'multi_agent = false\n'
	printf 'unified_exec = false\n'
} >"$CODEX_HOME/config.toml"
chmod 0600 "$CODEX_HOME/config.toml"

run_codex_in_workspace() {
	local workspace=$1
	shift
	timeout --signal=TERM --kill-after=5s "${TURN_TIMEOUT}s" \
		"$COMPAT_CLIENT_BINARY" exec \
		--json \
		--strict-config \
		--skip-git-repo-check \
		--ignore-rules \
		--sandbox workspace-write \
		-C "$workspace" \
		"$@"
}

run_codex() {
	run_codex_in_workspace "$COMPAT_WORKSPACE" "$@"
}

run_codex --ephemeral \
	'Reply with exactly CODEX_PROXY_TEXT_OK and do not use tools.' \
	>"$COMPAT_FIXTURE_DIR/text.jsonl"
node -e '
const { readFileSync } = require("node:fs");
const lines = readFileSync(process.argv[1], "utf8").trim().split(/\n+/).map(JSON.parse);
const text = lines
  .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
  .map((event) => event.item.text ?? "")
  .join("");
if (text.trim() !== "CODEX_PROXY_TEXT_OK") process.exit(1);
' "$COMPAT_FIXTURE_DIR/text.jsonl"

run_codex --ephemeral \
	'Reply with exactly CODEX_PROXY_STREAM_OK and do not use tools.' \
	>"$COMPAT_FIXTURE_DIR/stream.jsonl"
node -e '
const { readFileSync } = require("node:fs");
const lines = readFileSync(process.argv[1], "utf8").trim().split(/\n+/).map(JSON.parse);
if (!lines.some((event) => event.type === "thread.started")) process.exit(1);
if (!lines.some((event) => event.type === "turn.completed")) process.exit(1);
if (!lines.some((event) => event.type === "item.completed" && event.item?.text?.includes("CODEX_PROXY_STREAM_OK"))) process.exit(1);
' "$COMPAT_FIXTURE_DIR/stream.jsonl"

printf 'seed\n' >"$COMPAT_WORKSPACE/codex-tool.txt"
run_codex --ephemeral \
	'Use exec with tools.apply_patch to replace codex-tool.txt with exactly CODEX_TOOL_OK, then reply exactly CODEX_TOOL_DONE.' \
	>"$COMPAT_FIXTURE_DIR/tool-loop.jsonl"
[[ $(tr -d '\r\n' <"$COMPAT_WORKSPACE/codex-tool.txt") == CODEX_TOOL_OK ]]

run_codex \
	'Remember the marker CODEX_CONTINUATION_ALPHA and reply exactly CODEX_CONTINUATION_READY. Do not use tools.' \
	>"$COMPAT_FIXTURE_DIR/continuation-first.jsonl"
thread_id=$(
	node -e '
const { readFileSync } = require("node:fs");
for (const line of readFileSync(process.argv[1], "utf8").trim().split(/\n+/)) {
  const event = JSON.parse(line);
  if (event.type === "thread.started" && event.thread_id) {
    process.stdout.write(event.thread_id);
    process.exit(0);
  }
}
process.exit(1);
' "$COMPAT_FIXTURE_DIR/continuation-first.jsonl"
)
timeout --signal=TERM --kill-after=5s "${TURN_TIMEOUT}s" \
	"$COMPAT_CLIENT_BINARY" exec resume "$thread_id" \
	--json \
	--strict-config \
	--skip-git-repo-check \
	--ignore-rules \
	'Reply with only the marker I asked you to remember.' \
	>"$COMPAT_FIXTURE_DIR/continuation-second.jsonl"
rg -q 'CODEX_CONTINUATION_ALPHA' "$COMPAT_FIXTURE_DIR/continuation-second.jsonl"

isolation_workspace="$COMPAT_WORKSPACE/isolation"
mkdir -p -- "$isolation_workspace/a" "$isolation_workspace/b"
(
	run_codex_in_workspace "$isolation_workspace/a" --ephemeral \
		'Reply with exactly CODEX_ISOLATION_ALPHA and do not use tools.' \
		>"$COMPAT_FIXTURE_DIR/isolation-a.jsonl"
) &
pid_a=$!
(
	run_codex_in_workspace "$isolation_workspace/b" --ephemeral \
		'Reply with exactly CODEX_ISOLATION_BETA and do not use tools.' \
		>"$COMPAT_FIXTURE_DIR/isolation-b.jsonl"
) &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
rg -q 'CODEX_ISOLATION_ALPHA' "$COMPAT_FIXTURE_DIR/isolation-a.jsonl"
if rg -q 'CODEX_ISOLATION_BETA' "$COMPAT_FIXTURE_DIR/isolation-a.jsonl"; then
	exit 1
fi
rg -q 'CODEX_ISOLATION_BETA' "$COMPAT_FIXTURE_DIR/isolation-b.jsonl"
if rg -q 'CODEX_ISOLATION_ALPHA' "$COMPAT_FIXTURE_DIR/isolation-b.jsonl"; then
	exit 1
fi

set +e
timeout --signal=TERM --kill-after=5s 1s \
	"$COMPAT_CLIENT_BINARY" exec \
	--json \
	--strict-config \
	--ephemeral \
	--skip-git-repo-check \
	--ignore-rules \
	--sandbox read-only \
	-C "$COMPAT_WORKSPACE" \
	'Compatibility cancellation probe: produce a long response for at least thirty seconds.' \
	>"$COMPAT_FIXTURE_DIR/cancellation.jsonl" 2>&1
cancel_status=$?
set -e
[[ "$cancel_status" -eq 124 || "$cancel_status" -eq 137 ]]
printf 'cancel_exit=%s\n' "$cancel_status" >"$COMPAT_FIXTURE_DIR/cancellation-status.txt"
