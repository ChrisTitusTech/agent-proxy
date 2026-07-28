#!/usr/bin/env bash
# Run sanitized live-client compatibility checks through isolated client state.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUNNER_DIR=${AGENT_PROXY_COMPAT_RUNNER_DIR:-"$PROJECT_DIR/scripts/client-compat/runners"}
REDACTOR="$PROJECT_DIR/scripts/client-compat/redact.mjs"
REQUIRE_LIVE=false
ARTIFACT_ROOT=
SELECTED_CLIENTS=()
ALL_CLIENTS=(claude codex grok copilot)
TEMP_ROOT=
TURN_TIMEOUT=${AGENT_PROXY_COMPAT_TURN_TIMEOUT:-180}
HOST_XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}

usage() {
	cat <<EOF
Usage: ${0##*/} (--client CLIENT | --all) [--require-live] [--artifacts-dir DIR]

Clients: claude, codex, grok, copilot

Without --require-live, unavailable clients and unfinished runners are reported
as skips. With --require-live, every selected client must execute and pass.
Sanitized evidence is written below dist/client-compat by default.
EOF
}

cleanup() {
	if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]]; then
		rm -rf -- "$TEMP_ROOT"
	fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

is_supported_client() {
	local candidate=$1
	local client
	for client in "${ALL_CLIENTS[@]}"; do
		[[ "$candidate" == "$client" ]] && return 0
	done
	return 1
}

append_client() {
	local candidate=$1
	local client
	is_supported_client "$candidate" || {
		printf 'Unsupported client: %s\n' "$candidate" >&2
		exit 2
	}
	for client in ${SELECTED_CLIENTS[@]+"${SELECTED_CLIENTS[@]}"}; do
		[[ "$candidate" == "$client" ]] && return
	done
	SELECTED_CLIENTS+=("$candidate")
}

while (($# > 0)); do
	case "$1" in
	--client)
		[[ $# -ge 2 ]] || {
			printf '%s\n' '--client requires a value.' >&2
			exit 2
		}
		append_client "$2"
		shift 2
		;;
	--all)
		SELECTED_CLIENTS=("${ALL_CLIENTS[@]}")
		shift
		;;
	--require-live)
		REQUIRE_LIVE=true
		shift
		;;
	--artifacts-dir)
		[[ $# -ge 2 ]] || {
			printf '%s\n' '--artifacts-dir requires a value.' >&2
			exit 2
		}
		ARTIFACT_ROOT=$2
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'Unknown argument: %s\n' "$1" >&2
		usage >&2
		exit 2
		;;
	esac
done

((${#SELECTED_CLIENTS[@]} > 0)) || {
	usage >&2
	exit 2
}

command -v curl >/dev/null || {
	printf 'curl is required for live client compatibility checks.\n' >&2
	exit 1
}
command -v node >/dev/null || {
	printf 'Node.js is required for live client compatibility checks.\n' >&2
	exit 1
}
command -v timeout >/dev/null || {
	printf 'timeout is required for live client compatibility checks.\n' >&2
	exit 1
}
command -v rg >/dev/null || {
	printf 'ripgrep (rg) is required for live client compatibility checks.\n' >&2
	exit 1
}
[[ "$TURN_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || {
	printf 'AGENT_PROXY_COMPAT_TURN_TIMEOUT must be a positive integer.\n' >&2
	exit 2
}
[[ -f "$REDACTOR" ]] || {
	printf 'Fixture redactor is missing: %s\n' "$REDACTOR" >&2
	exit 1
}

if [[ -z "$ARTIFACT_ROOT" ]]; then
	run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
	ARTIFACT_ROOT="$PROJECT_DIR/dist/client-compat/$run_id"
fi

if [[ -e "$ARTIFACT_ROOT" ]] &&
	find "$ARTIFACT_ROOT" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
	printf 'Artifact directory must be absent or empty: %s\n' "$ARTIFACT_ROOT" >&2
	exit 1
fi

umask 077
mkdir -p -- "$ARTIFACT_ROOT"
TEMP_ROOT=$(mktemp -d)

client_command_name() {
	case "$1" in
	claude) printf '%s' "${CLAUDE_BIN:-claude}" ;;
	codex) printf '%s' "${CODEX_BIN:-codex}" ;;
	grok) printf '%s' "${GROK_BIN:-grok}" ;;
	copilot) printf '%s' "${COPILOT_BIN:-copilot}" ;;
	esac
}

resolve_command() {
	local configured=$1
	case "$configured" in
	*/*)
		[[ -x "$configured" ]] && printf '%s' "$configured"
		;;
	*)
		command -v -- "$configured" 2>/dev/null || true
		;;
	esac
}

report_unavailable() {
	local client=$1
	local reason=$2
	if [[ "$REQUIRE_LIVE" == true ]]; then
		printf 'FAIL [%s] %s\n' "$client" "$reason" >&2
		return 1
	fi
	printf 'SKIP [%s] %s\n' "$client" "$reason"
	return 0
}

json_quote() {
	node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

valid_base_url() {
	node -e '
try {
  const url = new URL(process.argv[1]);
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "" && url.pathname !== "/")
  ) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
' "$1"
}

write_metadata() {
	local output=$1
	local client=$2
	local client_version=$3
	local server_version=$4
	local base_url=$5
	local result=$6
	local runner_status=$7
	local revision
	local recorded_at
	revision=$(git -C "$PROJECT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'source')
	recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

	{
		printf '{\n'
		printf '  "schema_version": 1,\n'
		printf '  "recorded_at": %s,\n' "$(json_quote "$recorded_at")"
		printf '  "harness_revision": %s,\n' "$(json_quote "$revision")"
		printf '  "client": %s,\n' "$(json_quote "$client")"
		printf '  "client_version": %s,\n' "$(json_quote "$client_version")"
		printf '  "server_version": %s,\n' "$(json_quote "$server_version")"
		printf '  "server_base_url": %s,\n' "$(json_quote "$base_url")"
		printf '  "result": %s,\n' "$(json_quote "$result")"
		printf '  "runner_exit_code": %s\n' "$runner_status"
		printf '}\n'
	} >"$output"
	chmod 0600 "$output"
}

sanitize_fixtures() {
	local raw_dir=$1
	local output_dir=$2
	local raw_file
	local relative
	local destination
	while IFS= read -r -d '' raw_file; do
		relative=${raw_file#"$raw_dir"/}
		destination="$output_dir/$relative"
		mkdir -p -- "$(dirname "$destination")" || return 1
		node "$REDACTOR" "$raw_file" "$destination" || return 1
	done < <(find "$raw_dir" -type f -print0)
}

run_client() {
	local client=$1
	local runner="$RUNNER_DIR/$client.sh"
	local configured_command
	local client_binary
	local state_dir="$TEMP_ROOT/$client"
	local raw_dir="$state_dir/raw-fixtures"
	local raw_metadata="$state_dir/metadata.json"
	local artifact_dir="$ARTIFACT_ROOT/$client"
	local base_url=${AGENT_PROXY_BASE_URL:-}
	local api_key=${PROXY_API_KEY:-}
	local version_output
	local server_version
	local runner_status
	local result
	local runner_environment_file="$state_dir/runner-env.sh"

	[[ -x "$runner" ]] || {
		report_unavailable "$client" "runner is not implemented: $runner"
		return
	}

	configured_command=$(client_command_name "$client")
	client_binary=$(resolve_command "$configured_command")
	[[ -n "$client_binary" ]] || {
		report_unavailable "$client" "client executable is unavailable: $configured_command"
		return
	}

	[[ -n "$base_url" ]] || {
		report_unavailable "$client" 'AGENT_PROXY_BASE_URL is not set'
		return
	}
	[[ -n "$api_key" ]] || {
		report_unavailable "$client" 'PROXY_API_KEY is not set'
		return
	}
	valid_base_url "$base_url" || {
		printf 'FAIL [%s] AGENT_PROXY_BASE_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.\n' \
			"$client" >&2
		return 1
	}
	base_url=${base_url%/}

	mkdir -p \
		"$state_dir/home" \
		"$state_dir/config" \
		"$state_dir/cache" \
		"$state_dir/data" \
		"$state_dir/runtime" \
		"$state_dir/tmp" \
		"$state_dir/workspace" \
		"$raw_dir" \
		"$artifact_dir/fixtures" || return 1

	if ! version_output=$(
		timeout --signal=TERM --kill-after=5s 10s env -i \
			HOME="$state_dir/home" \
			PATH="$PATH" \
			LANG="${LANG:-C.UTF-8}" \
			XDG_CONFIG_HOME="$state_dir/config" \
			XDG_CACHE_HOME="$state_dir/cache" \
			XDG_DATA_HOME="$state_dir/data" \
			XDG_RUNTIME_DIR="$state_dir/runtime" \
			TMPDIR="$state_dir/tmp" \
			"$client_binary" --version 2>&1
	); then
		report_unavailable "$client" 'client version command failed'
		return
	fi
	printf '%s\n' "$version_output" >"$raw_dir/client-version.txt" || return 1

	if ! curl --silent --show-error --fail \
		--connect-timeout 5 \
		--max-time 10 \
		"$base_url/health" >"$raw_dir/server-health.json"; then
		report_unavailable "$client" "server health check failed: $base_url/health"
		return
	fi

	if ! node -e '
const { readFileSync } = require("node:fs");
const health = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (health.status !== "ok" || Object.keys(health).length !== 1) process.exit(1);
' "$raw_dir/server-health.json"; then
		printf 'FAIL [%s] server liveness exposed unexpected details.\n' "$client" >&2
		return 1
	fi
	server_version=unavailable
	if [[ -n ${AGENT_PROXY_ADMIN_TOKEN:-} ]]; then
		if ! curl --silent --show-error --fail \
			--connect-timeout 5 \
			--max-time 10 \
			-H "x-admin-token: $AGENT_PROXY_ADMIN_TOKEN" \
			"$base_url/admin/health" >"$raw_dir/server-readiness.json"; then
			report_unavailable "$client" 'authenticated server readiness failed'
			return
		fi
		if ! server_version=$(
			node -e '
const { readFileSync } = require("node:fs");
const health = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (typeof health.version !== "string" || health.version.length === 0) process.exit(1);
process.stdout.write(health.version);
' "$raw_dir/server-readiness.json"
		); then
			printf 'FAIL [%s] authenticated readiness has no version.\n' "$client" >&2
			return 1
		fi
	elif [[ "$REQUIRE_LIVE" == true ]]; then
		printf 'FAIL [%s] AGENT_PROXY_ADMIN_TOKEN is required for live evidence.\n' "$client" >&2
		return 1
	fi

	{
		printf 'export HOME=%q\n' "$state_dir/home"
		printf 'export PATH=%q\n' "$PATH"
		printf 'export LANG=%q\n' "${LANG:-C.UTF-8}"
		printf 'export XDG_CONFIG_HOME=%q\n' "$state_dir/config"
		printf 'export XDG_CACHE_HOME=%q\n' "$state_dir/cache"
		printf 'export XDG_DATA_HOME=%q\n' "$state_dir/data"
		printf 'export XDG_RUNTIME_DIR=%q\n' "$state_dir/runtime"
		printf 'export TMPDIR=%q\n' "$state_dir/tmp"
		printf 'export AGENT_PROXY_BASE_URL=%q\n' "$base_url"
		printf 'export AGENT_PROXY_COMPAT_REQUIRE_LIVE=%q\n' "$REQUIRE_LIVE"
		printf 'export AGENT_PROXY_COMPAT_TURN_TIMEOUT=%q\n' "$TURN_TIMEOUT"
		printf 'export PROXY_API_KEY=%q\n' "$api_key"
		printf 'export COMPAT_CLIENT=%q\n' "$client"
		printf 'export COMPAT_CLIENT_BINARY=%q\n' "$client_binary"
		printf 'export COMPAT_FIXTURE_DIR=%q\n' "$raw_dir/protocol"
		printf 'export COMPAT_WORKSPACE=%q\n' "$state_dir/workspace"
		if [[ ("$client" == codex || "$client" == copilot) && -n ${AGENT_PROXY_ADMIN_TOKEN:-} ]]; then
			printf 'export AGENT_PROXY_ADMIN_TOKEN=%q\n' "$AGENT_PROXY_ADMIN_TOKEN"
		fi
		if [[ "$client" == copilot && -n ${AGENT_PROXY_ADMIN_TOKEN:-} ]]; then
			if [[ -z "$HOST_XDG_RUNTIME_DIR" ]]; then
				printf 'FAIL [copilot] XDG_RUNTIME_DIR is required for Herdr cancellation evidence.\n' >&2
				return 1
			fi
			printf 'export AGENT_PROXY_HERDR_RUNTIME_DIR=%q\n' "$HOST_XDG_RUNTIME_DIR"
		fi
	} >"$runner_environment_file"
	chmod 0600 "$runner_environment_file"

	set +e
	# shellcheck disable=SC2016 # Positional parameters expand in the isolated child shell.
	timeout --signal=TERM --kill-after=5s "$((TURN_TIMEOUT * 8))s" \
		env -i bash -c 'source "$1"; exec "$2"' \
		bash "$runner_environment_file" "$runner" \
		>"$raw_dir/runner.log" 2>&1
	runner_status=$?
	set -e

	case "$runner_status" in
	0) result=passed ;;
	77) result=skipped ;;
	*) result=failed ;;
	esac

	sanitize_fixtures "$raw_dir" "$artifact_dir/fixtures" || return 1
	write_metadata \
		"$raw_metadata" \
		"$client" \
		"$version_output" \
		"$server_version" \
		"$base_url" \
		"$result" \
		"$runner_status" || return 1
	node "$REDACTOR" "$raw_metadata" "$artifact_dir/metadata.json" || return 1

	case "$result" in
	passed)
		printf 'PASS [%s] sanitized evidence: %s\n' "$client" "$artifact_dir"
		;;
	skipped)
		if [[ "$REQUIRE_LIVE" == true ]]; then
			printf 'FAIL [%s] runner skipped a required live check; evidence: %s\n' \
				"$client" "$artifact_dir" >&2
			return 1
		fi
		printf 'SKIP [%s] runner reported unavailable; evidence: %s\n' "$client" "$artifact_dir"
		;;
	failed)
		printf 'FAIL [%s] runner exited with %s; evidence: %s\n' \
			"$client" "$runner_status" "$artifact_dir" >&2
		return 1
		;;
	esac
}

failures=0
for client in "${SELECTED_CLIENTS[@]}"; do
	run_client "$client" || failures=$((failures + 1))
done

if ((failures > 0)); then
	exit 1
fi
