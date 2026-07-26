#!/usr/bin/env bash
# Run pinned Open WebUI API compatibility checks through agent-proxy.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${OPEN_WEBUI_IMAGE:-ghcr.io/open-webui/open-webui:v0.9.5}
RUNTIME=${OPEN_WEBUI_RUNTIME:-podman}
REQUIRE_LIVE=false
CASES=
CONTAINER=
PORT=
WEBUI_TEST_SECRET=$(openssl rand -hex 32)

usage() {
	cat <<EOF
Usage: ${0##*/} (--cases LIST | --all) [--require-live]

Cases: discovery,nonstream,stream,cancel,isolation,tools,accounting
Required environment: AGENT_PROXY_BASE_URL, PROXY_API_KEY
Cancellation also requires AGENT_PROXY_ADMIN_TOKEN.
EOF
}

cleanup() {
	if [[ -n "$CONTAINER" ]]; then
		"$RUNTIME" rm -f "$CONTAINER" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

while (($# > 0)); do
	case "$1" in
	--cases)
		CASES=${2:?--cases requires a comma-separated value}
		shift 2
		;;
	--all)
		CASES=discovery,nonstream,stream,cancel,isolation,tools,accounting
		shift
		;;
	--require-live)
		REQUIRE_LIVE=true
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

[[ -n "$CASES" ]] || {
	usage >&2
	exit 2
}
IFS=, read -r -a requested_cases <<<"$CASES"
for requested_case in "${requested_cases[@]}"; do
	case "$requested_case" in
	discovery | nonstream | stream | cancel | isolation | tools | accounting) ;;
	*)
		printf 'Unsupported case: %s\n' "$requested_case" >&2
		exit 2
		;;
	esac
done
if ! command -v "$RUNTIME" >/dev/null; then
	[[ "$REQUIRE_LIVE" == false ]] && {
		printf 'SKIP Open WebUI runtime is unavailable: %s\n' "$RUNTIME"
		exit 0
	}
	printf 'FAIL Open WebUI runtime is unavailable: %s\n' "$RUNTIME" >&2
	exit 1
fi
[[ -n ${AGENT_PROXY_BASE_URL:-} && -n ${PROXY_API_KEY:-} ]] || {
	[[ "$REQUIRE_LIVE" == false ]] && {
		printf 'SKIP AGENT_PROXY_BASE_URL and PROXY_API_KEY are required.\n'
		exit 0
	}
	printf 'FAIL AGENT_PROXY_BASE_URL and PROXY_API_KEY are required.\n' >&2
	exit 1
}
export AGENT_PROXY_BASE_URL
if [[ ",$CASES," == *,cancel,* || ",$CASES," == *,accounting,* ]] &&
	[[ -z ${AGENT_PROXY_ADMIN_TOKEN:-} ]]; then
	[[ "$REQUIRE_LIVE" == false ]] && {
		printf 'SKIP AGENT_PROXY_ADMIN_TOKEN is required for cancel and accounting cases.\n'
		exit 0
	}
	printf 'FAIL AGENT_PROXY_ADMIN_TOKEN is required for cancel and accounting cases.\n' >&2
	exit 1
fi

PORT=$(node -e '
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
')
CONTAINER="agent-proxy-openwebui-compat-$$"
OPENAI_API_KEY=$PROXY_API_KEY "$RUNTIME" run -d --rm \
	--name "$CONTAINER" \
	--network=host \
	-e HOST=127.0.0.1 \
	-e PORT="$PORT" \
	-e WEBUI_SECRET_KEY="$WEBUI_TEST_SECRET" \
	-e WEBUI_AUTH=false \
	-e ENABLE_OLLAMA_API=false \
	-e ENABLE_TITLE_GENERATION=false \
	-e ENABLE_TAGS_GENERATION=false \
	-e ENABLE_FOLLOW_UP_GENERATION=false \
	-e ENABLE_AUTOCOMPLETE_GENERATION=false \
	-e ENABLE_MEMORIES=false \
	-e ENABLE_WEB_SEARCH=false \
	-e ENABLE_IMAGE_GENERATION=false \
	-e RAG_EMBEDDING_ENGINE=openai \
	-e OPENAI_API_BASE_URL="${AGENT_PROXY_BASE_URL%/}/v1" \
	-e OPENAI_API_KEY \
	"$IMAGE" >/dev/null

base_url="http://127.0.0.1:$PORT"
for _ in {1..900}; do
	if curl --silent --fail "$base_url/health" >/dev/null 2>&1; then
		break
	fi
	if ! "$RUNTIME" inspect "$CONTAINER" >/dev/null 2>&1; then
		printf 'Open WebUI container exited before becoming healthy.\n' >&2
		exit 1
	fi
	sleep 0.2
done
curl --silent --show-error --fail "$base_url/health" >/dev/null

OPEN_WEBUI_BASE_URL=$base_url \
	OPEN_WEBUI_CASES=$CASES \
	OPEN_WEBUI_MODELS=${OPEN_WEBUI_MODELS:-gpt-5.6-sol,grok-build} \
	node "$PROJECT_DIR/scripts/openwebui/compat.mjs"

printf 'PASS Open WebUI %s compatibility using %s\n' "$CASES" "$IMAGE"
