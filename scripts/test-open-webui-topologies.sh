#!/usr/bin/env bash
# Verify native, Docker, and Podman Open WebUI reachability.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${OPEN_WEBUI_IMAGE:-ghcr.io/open-webui/open-webui:v0.9.5}
SELECTED=()
TEMP_ROOT=$(mktemp -d)
WEBUI_TEST_SECRET=$(openssl rand -hex 32)
NATIVE_PID=
CONTAINERS=()

usage() {
	printf 'Usage: %s (--topology native|docker|podman | --all)\n' "${0##*/}"
}

cleanup() {
	if [[ -n "$NATIVE_PID" ]]; then
		kill "$NATIVE_PID" >/dev/null 2>&1 || true
		wait "$NATIVE_PID" >/dev/null 2>&1 || true
	fi
	if ((${#CONTAINERS[@]} > 0)); then
		for entry in "${CONTAINERS[@]}"; do
			runtime=${entry%%:*}
			name=${entry#*:}
			if [[ "$runtime" == docker ]]; then
				sudo -n docker rm -f "$name" >/dev/null 2>&1 || true
			else
				podman rm -f "$name" >/dev/null 2>&1 || true
			fi
		done
	fi
	rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT

append_topology() {
	case "$1" in
	native | docker | podman) SELECTED+=("$1") ;;
	*)
		printf 'Unsupported topology: %s\n' "$1" >&2
		exit 2
		;;
	esac
}

while (($# > 0)); do
	case "$1" in
	--topology)
		append_topology "${2:?--topology requires a value}"
		shift 2
		;;
	--all)
		SELECTED=(native docker podman)
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage >&2
		exit 2
		;;
	esac
done

((${#SELECTED[@]} > 0)) || {
	usage >&2
	exit 2
}
[[ -n ${AGENT_PROXY_BASE_URL:-} && -n ${PROXY_API_KEY:-} ]] || {
	printf 'AGENT_PROXY_BASE_URL and PROXY_API_KEY are required.\n' >&2
	exit 1
}

free_port() {
	node -e '
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
'
}

wait_for_health() {
	local base_url=$1
	local process_id=${2:-}
	local runtime=${3:-}
	local container=${4:-}
	local attempts=${OPEN_WEBUI_STARTUP_ATTEMPTS:-3000}
	for ((attempt = 0; attempt < attempts; attempt++)); do
		curl --silent --fail "$base_url/health" >/dev/null 2>&1 && return
		if [[ -n "$process_id" ]] && ! kill -0 "$process_id" 2>/dev/null; then
			printf 'Open WebUI process exited before becoming healthy: %s\n' "$base_url" >&2
			return 1
		fi
		if [[ -n "$runtime" && -n "$container" ]]; then
			if [[ "$runtime" == docker ]]; then
				sudo -n docker inspect "$container" >/dev/null 2>&1 || {
					printf 'Open WebUI container exited before becoming healthy: %s\n' "$base_url" >&2
					return 1
				}
			elif ! podman inspect "$container" >/dev/null 2>&1; then
				printf 'Open WebUI container exited before becoming healthy: %s\n' "$base_url" >&2
				return 1
			fi
		fi
		sleep 0.2
	done
	printf 'Open WebUI did not become healthy: %s\n' "$base_url" >&2
	return 1
}

check_discovery() {
	local base_url=$1
	OPEN_WEBUI_BASE_URL=$base_url \
		AGENT_PROXY_BASE_URL=$AGENT_PROXY_BASE_URL \
		OPEN_WEBUI_CASES=discovery \
		OPEN_WEBUI_MODELS=${OPEN_WEBUI_MODELS:-gpt-5.6-sol,grok-build} \
		node "$PROJECT_DIR/scripts/openwebui/compat.mjs"
}

start_native() {
	command -v uvx >/dev/null || {
		printf 'uvx is required for the native topology.\n' >&2
		return 1
	}
	local port
	port=$(free_port)
	mkdir -p "$TEMP_ROOT/native-data"
	DATA_DIR="$TEMP_ROOT/native-data" \
		HOST=127.0.0.1 \
		PORT=$port \
		WEBUI_SECRET_KEY=$WEBUI_TEST_SECRET \
		WEBUI_AUTH=false \
		ENABLE_OLLAMA_API=false \
		ENABLE_TITLE_GENERATION=false \
		ENABLE_TAGS_GENERATION=false \
		ENABLE_FOLLOW_UP_GENERATION=false \
		ENABLE_AUTOCOMPLETE_GENERATION=false \
		ENABLE_MEMORIES=false \
		RAG_EMBEDDING_ENGINE=openai \
		OPENAI_API_BASE_URL="${AGENT_PROXY_BASE_URL%/}/v1" \
		OPENAI_API_KEY=$PROXY_API_KEY \
		uvx --python 3.11 "open-webui==0.9.5" serve \
		--host 127.0.0.1 \
		--port "$port" \
		>"$TEMP_ROOT/native.log" 2>&1 &
	NATIVE_PID=$!
	local base_url="http://127.0.0.1:$port"
	wait_for_health "$base_url" "$NATIVE_PID" || {
		sed -n '1,160p' "$TEMP_ROOT/native.log" >&2
		return 1
	}
	check_discovery "$base_url"
	kill "$NATIVE_PID"
	wait "$NATIVE_PID" >/dev/null 2>&1 || true
	NATIVE_PID=
	printf 'PASS native Open WebUI topology (%s)\n' "$base_url"
}

start_container() {
	local runtime=$1
	local name="agent-proxy-openwebui-${runtime}-$$"
	local port
	local -a command
	command -v "$runtime" >/dev/null || {
		printf '%s is required for its Open WebUI topology.\n' "$runtime" >&2
		return 1
	}
	if [[ "$runtime" == docker ]]; then
		sudo -n true >/dev/null 2>&1 || {
			printf 'Docker topology requires non-interactive sudo.\n' >&2
			return 1
		}
		command=(sudo -n --preserve-env=OPENAI_API_KEY docker)
		sudo -n systemctl start docker.service
	else
		command=(podman)
	fi
	port=$(free_port)
	OPENAI_API_KEY=$PROXY_API_KEY "${command[@]}" run -d --rm \
		--name "$name" \
		--network=host \
		-e HOST=127.0.0.1 \
		-e PORT="$port" \
		-e WEBUI_SECRET_KEY="$WEBUI_TEST_SECRET" \
		-e WEBUI_AUTH=false \
		-e ENABLE_OLLAMA_API=false \
		-e ENABLE_TITLE_GENERATION=false \
		-e ENABLE_TAGS_GENERATION=false \
		-e ENABLE_FOLLOW_UP_GENERATION=false \
		-e ENABLE_AUTOCOMPLETE_GENERATION=false \
		-e ENABLE_MEMORIES=false \
		-e RAG_EMBEDDING_ENGINE=openai \
		-e OPENAI_API_BASE_URL="${AGENT_PROXY_BASE_URL%/}/v1" \
		-e OPENAI_API_KEY \
		"$IMAGE" >/dev/null
	CONTAINERS+=("$runtime:$name")
	local base_url="http://127.0.0.1:$port"
	wait_for_health "$base_url" "" "$runtime" "$name"
	check_discovery "$base_url"
	"${command[@]}" rm -f "$name" >/dev/null
	printf 'PASS %s Open WebUI topology (%s)\n' "$runtime" "$base_url"
}

for topology in "${SELECTED[@]}"; do
	case "$topology" in
	native) start_native ;;
	docker | podman) start_container "$topology" ;;
	esac
done
