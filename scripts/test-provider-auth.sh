#!/usr/bin/env bash
# Verify subscription-backed providers inside the hardened systemd identity.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REDACTOR="$PROJECT_DIR/scripts/client-compat/redact.mjs"
REQUIRE_LIVE=false
SELECTED=()
SUPPORTED=(claude codex grok)
ARTIFACT_ROOT=

usage() {
	cat <<EOF
Usage: ${0##*/} --providers claude,codex,grok [--require-live] [--artifacts-dir DIR]

Runs non-secret authentication readiness checks as the agent-proxy service
account with the production unit's HOME, PATH, working directory, and hardening.
EOF
}

append_provider() {
	local candidate=$1
	local supported
	for supported in "${SUPPORTED[@]}"; do
		if [[ "$candidate" == "$supported" ]]; then
			SELECTED+=("$candidate")
			return
		fi
	done
	printf 'Unsupported provider: %s\n' "$candidate" >&2
	exit 2
}

while (($# > 0)); do
	case "$1" in
	--providers)
		[[ $# -ge 2 ]] || {
			printf '%s\n' '--providers requires a comma-separated value.' >&2
			exit 2
		}
		IFS=, read -r -a requested <<<"$2"
		for provider in "${requested[@]}"; do
			append_provider "$provider"
		done
		shift 2
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

((${#SELECTED[@]} > 0)) || {
	usage >&2
	exit 2
}

command -v systemd-run >/dev/null || {
	printf 'systemd-run is required.\n' >&2
	exit 1
}
command -v node >/dev/null || {
	printf 'Node.js is required.\n' >&2
	exit 1
}
command -v rg >/dev/null || {
	printf 'ripgrep (rg) is required.\n' >&2
	exit 1
}
[[ -f "$REDACTOR" ]] || {
	printf 'Redactor is missing: %s\n' "$REDACTOR" >&2
	exit 1
}

if [[ -z "$ARTIFACT_ROOT" ]]; then
	run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
	ARTIFACT_ROOT="$PROJECT_DIR/dist/provider-auth/$run_id"
fi
if [[ -e "$ARTIFACT_ROOT" ]] &&
	find "$ARTIFACT_ROOT" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
	printf 'Artifact directory must be absent or empty: %s\n' "$ARTIFACT_ROOT" >&2
	exit 1
fi

umask 077
mkdir -p -- "$ARTIFACT_ROOT"
temp_root=$(mktemp -d)
trap 'rm -rf -- "$temp_root"' EXIT

if [[ $EUID -eq 0 ]]; then
	SUDO=()
elif sudo -n true >/dev/null 2>&1; then
	SUDO=(sudo -n)
else
	if [[ "$REQUIRE_LIVE" == true ]]; then
		printf 'FAIL provider auth checks require root or non-interactive sudo.\n' >&2
		exit 1
	fi
	printf 'SKIP provider auth checks require root or non-interactive sudo.\n'
	exit 0
fi

if ! id agent-proxy >/dev/null 2>&1; then
	if [[ "$REQUIRE_LIVE" == true ]]; then
		printf 'FAIL service account is missing: agent-proxy\n' >&2
		exit 1
	fi
	printf 'SKIP service account is missing: agent-proxy\n'
	exit 0
fi

SYSTEMD_PROPERTIES=(
	--property=User=agent-proxy
	--property=Group=agent-proxy
	--property=WorkingDirectory=/var/lib/agent-proxy
	--property=Environment=HOME=/var/lib/agent-proxy
	--property=Environment=PATH=/var/lib/agent-proxy/.local/bin:/usr/local/bin:/usr/bin:/bin
	--property=RuntimeMaxSec=60
	--property=NoNewPrivileges=yes
	--property=PrivateDevices=yes
	--property=PrivateTmp=yes
	--property=ProtectHome=yes
	--property=ProtectSystem=strict
	--property=ProtectProc=invisible
	"--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"
	--property=RestrictNamespaces=yes
	--property=RestrictRealtime=yes
	--property=RestrictSUIDSGID=yes
	--property=CapabilityBoundingSet=
	--property=AmbientCapabilities=
	--property=LockPersonality=yes
	"--property=ReadWritePaths=/var/lib/agent-proxy /var/log/agent-proxy /run/agent-proxy"
)

run_hardened() {
	local unit=$1
	shift
	"${SUDO[@]}" systemd-run \
		--wait \
		--pipe \
		--quiet \
		--collect \
		--unit "$unit" \
		"${SYSTEMD_PROPERTIES[@]}" \
		-- "$@"
}

failures=0
for provider in "${SELECTED[@]}"; do
	raw="$temp_root/$provider.txt"
	sanitized="$ARTIFACT_ROOT/$provider.txt"
	unit="agent-proxy-auth-${provider}-$$"
	case "$provider" in
	claude)
		binary=/var/lib/agent-proxy/.local/bin/claude
		check=("$binary" auth status --json)
		;;
	codex)
		binary=/var/lib/agent-proxy/.local/bin/codex
		check=("$binary" login status)
		;;
	grok)
		binary=/var/lib/agent-proxy/.local/bin/grok
		check=(
			"$binary"
			--tools ''
			--no-memory
			--no-subagents
			--disable-web-search
			--output-format plain
			--single
			'Reply with exactly GROK_AUTH_OK.'
		)
		;;
	esac

	if ! "${SUDO[@]}" test -x "$binary"; then
		if [[ "$REQUIRE_LIVE" == true ]]; then
			printf 'FAIL [%s] executable is missing: %s\n' "$provider" "$binary" >&2
			failures=$((failures + 1))
		else
			printf 'SKIP [%s] executable is missing: %s\n' "$provider" "$binary"
		fi
		continue
	fi

	set +e
	run_hardened "$unit" "${check[@]}" >"$raw" 2>&1
	status=$?
	set -e
	if ! node "$REDACTOR" "$raw" "$sanitized"; then
		printf 'FAIL [%s] evidence redaction failed for: %s\n' "$provider" "$raw" >&2
		failures=$((failures + 1))
		continue
	fi

	if ((status != 0)); then
		if [[ "$REQUIRE_LIVE" == true ]]; then
			printf 'FAIL [%s] subscription login is not ready; sanitized evidence: %s\n' \
				"$provider" "$sanitized" >&2
			failures=$((failures + 1))
		else
			printf 'SKIP [%s] subscription login is not ready; sanitized evidence: %s\n' \
				"$provider" "$sanitized"
		fi
		continue
	fi

	case "$provider" in
	claude)
		if ! rg -q '"loggedIn"[[:space:]]*:[[:space:]]*true' "$sanitized"; then
			printf 'FAIL [%s] Claude did not report a valid login; evidence: %s\n' \
				"$provider" "$sanitized" >&2
			failures=$((failures + 1))
			continue
		fi
		;;
	codex)
		if ! rg -qi 'logged in' "$sanitized" || rg -qi 'not logged in' "$sanitized"; then
			printf 'FAIL [%s] Codex did not report a valid login; evidence: %s\n' \
				"$provider" "$sanitized" >&2
			failures=$((failures + 1))
			continue
		fi
		;;
	grok)
		if ! rg -qx 'GROK_AUTH_OK' "$sanitized"; then
			printf 'FAIL [%s] Grok did not complete the inference readiness probe.\n' "$provider" >&2
			failures=$((failures + 1))
			continue
		fi
		;;
	esac
	printf 'PASS [%s] hardened service-account authentication; evidence: %s\n' \
		"$provider" "$sanitized"
done

((failures == 0))
