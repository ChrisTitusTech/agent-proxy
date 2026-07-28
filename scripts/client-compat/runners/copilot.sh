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
	local timeout_seconds=${4:-"$TURN_TIMEOUT"}
	timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" \
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

if [[ -z ${AGENT_PROXY_ADMIN_TOKEN:-} ]]; then
	[[ ${AGENT_PROXY_COMPAT_REQUIRE_LIVE:-false} == false ]] || {
		printf 'AGENT_PROXY_ADMIN_TOKEN is required to verify Copilot cancellation.\n' >&2
		exit 1
	}
	printf 'cancel_verification=skipped_missing_admin_token\n' \
		>"$COMPAT_FIXTURE_DIR/cancellation-status.txt"
else
	: "${AGENT_PROXY_HERDR_RUNTIME_DIR:?Host Herdr runtime directory is required}"
	command -v herdr >/dev/null || {
		printf 'Herdr is required to verify Copilot pane cancellation.\n' >&2
		exit 1
	}
	ADMIN_HEADER_FILE="$COMPAT_WORKSPACE/.admin-header"
	printf 'x-admin-token: %s\n' "$AGENT_PROXY_ADMIN_TOKEN" >"$ADMIN_HEADER_FILE"
	chmod 0600 "$ADMIN_HEADER_FILE"

	active_request_count() {
		curl --silent --show-error --fail \
			--connect-timeout 5 \
			--max-time 10 \
			-H "@$ADMIN_HEADER_FILE" \
			"${AGENT_PROXY_BASE_URL%/}/admin/active-requests" |
			node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const state = JSON.parse(input);
  if (!Number.isInteger(state.count) || state.count < 0) process.exit(1);
  process.stdout.write(String(state.count));
});
'
	}

	proxy_working_pane_count() {
		local workspace_id
		workspace_id=$(
			XDG_RUNTIME_DIR="$AGENT_PROXY_HERDR_RUNTIME_DIR" herdr workspace list |
				node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const result = JSON.parse(input).result;
  const workspace = result.workspaces.find((item) => item.label === "agent-proxy");
  if (workspace) process.stdout.write(workspace.workspace_id);
});
'
		)
		if [[ -z "$workspace_id" ]]; then
			printf '0'
			return
		fi
		XDG_RUNTIME_DIR="$AGENT_PROXY_HERDR_RUNTIME_DIR" \
			herdr pane list --workspace "$workspace_id" |
			node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const panes = JSON.parse(input).result.panes;
  process.stdout.write(String(panes.filter((pane) => pane.agent_status === "working").length));
});
'
	}

	active_before=$(active_request_count)
	working_before=$(proxy_working_pane_count)
	set +e
	run_copilot on \
		'Compatibility cancellation probe: produce a long response for at least thirty seconds.' \
		"$COMPAT_WORKSPACE" 2 \
		>"$COMPAT_FIXTURE_DIR/cancellation.txt" 2>&1 &
	cancel_pid=$!
	set -e

	cancel_started=false
	for _ in {1..40}; do
		active_during=$(active_request_count)
		if ((active_during > active_before)); then
			cancel_started=true
			break
		fi
		if ! kill -0 "$cancel_pid" 2>/dev/null; then
			active_during=$(active_request_count)
			((active_during > active_before)) && cancel_started=true
			break
		fi
		sleep 0.1
	done

	set +e
	wait "$cancel_pid"
	cancel_status=$?
	set -e
	[[ "$cancel_status" -eq 124 || "$cancel_status" -eq 137 ]]
	[[ "$cancel_started" == true ]] || {
		printf 'Copilot cancellation probe did not start provider work.\n' >&2
		exit 1
	}

	active_after=-1
	working_after=-1
	for _ in {1..60}; do
		active_after=$(active_request_count)
		working_after=$(proxy_working_pane_count)
		if ((active_after <= active_before && working_after <= working_before)); then
			break
		fi
		sleep 0.1
	done
	if ((active_after > active_before || working_after > working_before)); then
		printf 'Copilot cancellation left request or Herdr pane work active.\n' >&2
		exit 1
	fi
	printf 'cancel_exit=%s active_before=%s active_after=%s working_before=%s working_after=%s\n' \
		"$cancel_status" "$active_before" "$active_after" "$working_before" "$working_after" \
		>"$COMPAT_FIXTURE_DIR/cancellation-status.txt"
fi
