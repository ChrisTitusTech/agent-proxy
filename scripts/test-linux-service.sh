#!/usr/bin/env bash
# Verify restart persistence, health, and bounded SIGTERM behavior.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d)
SERVER_PID=

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill -TERM "$SERVER_PID" 2>/dev/null || true
		for _ in {1..50}; do
			if ! kill -0 "$SERVER_PID" 2>/dev/null; then
				break
			fi
			sleep 0.1
		done
		if kill -0 "$SERVER_PID" 2>/dev/null; then
			kill -KILL "$SERVER_PID" 2>/dev/null || true
		fi
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	rm -rf "$TEST_DIR"
}
trap cleanup EXIT

PORT=$(node -e '
const net = require("net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
  server.close();
});
')

cat >"$TEST_DIR/fake-grok" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$$" >"$FAKE_PID_FILE"
trap 'exit 0' TERM INT
sleep 60 &
printf '%s\n' "$!" >"$FAKE_CHILD_PID_FILE"
wait
EOF
chmod 0700 "$TEST_DIR/fake-grok"

cat >"$TEST_DIR/config.yaml" <<'EOF'
---
server:
  host: "127.0.0.1"
  port: 8300
database:
  path: "${TEST_DATABASE_PATH}"
auth:
  enabled: true
  admin_token: "${ADMIN_TOKEN}"
  initial_keys:
    - name: "service-smoke"
      key: "${PROXY_API_KEY}"
providers:
  claude:
    enabled: false
  codex:
    enabled: false
  agy:
    enabled: false
  grok:
    enabled: true
    cli_path: "${TEST_FAKE_CLI}"
    default_model: "test-model"
    max_concurrent: 1
model_mappings:
  - alias: "shutdown-test"
    provider: "grok"
    actual_model: "test-model"
EOF

export CONFIG_PATH="$TEST_DIR/config.yaml"
export TEST_DATABASE_PATH="$TEST_DIR/state/agent-proxy.db"
export TEST_FAKE_CLI="$TEST_DIR/fake-grok"
export FAKE_PID_FILE="$TEST_DIR/fake-grok.pid"
export FAKE_CHILD_PID_FILE="$TEST_DIR/fake-grok-child.pid"
export ADMIN_TOKEN=service-smoke-admin-token
export PROXY_API_KEY=sk-proxy-service-smoke-key
export AGENT_PROXY_PORT="$PORT"
export SHUTDOWN_TIMEOUT_MS=3000

start_server() {
	node "$PROJECT_DIR/packages/server/dist/index.js" >"$TEST_DIR/server.log" 2>&1 &
	SERVER_PID=$!
	for _ in {1..100}; do
		if curl --silent --fail "http://127.0.0.1:$PORT/health" >/dev/null; then
			return
		fi
		if ! kill -0 "$SERVER_PID" 2>/dev/null; then
			cat "$TEST_DIR/server.log" >&2
			return 1
		fi
		sleep 0.1
	done
	cat "$TEST_DIR/server.log" >&2
	printf 'Server did not become healthy.\n' >&2
	return 1
}

stop_server() {
	kill -TERM "$SERVER_PID"
	local attempts=$(((SHUTDOWN_TIMEOUT_MS + 1000 + 99) / 100))
	for ((attempt = 0; attempt < attempts; attempt++)); do
		if ! kill -0 "$SERVER_PID" 2>/dev/null; then
			wait "$SERVER_PID"
			SERVER_PID=
			return
		fi
		sleep 0.1
	done
	printf 'Server did not stop within the bounded timeout.\n' >&2
	return 1
}

start_server
node "$PROJECT_DIR/packages/server/dist/index.js" \
	>"$TEST_DIR/conflicting-server.log" 2>&1 &
CONFLICT_PID=$!
for _ in {1..50}; do
	if ! kill -0 "$CONFLICT_PID" 2>/dev/null; then
		break
	fi
	sleep 0.1
done
if kill -0 "$CONFLICT_PID" 2>/dev/null; then
	kill -KILL "$CONFLICT_PID" 2>/dev/null || true
	wait "$CONFLICT_PID" 2>/dev/null || true
	printf 'Server stayed alive after a listen failure.\n' >&2
	exit 1
fi
if wait "$CONFLICT_PID"; then
	printf 'Server returned success after a listen failure.\n' >&2
	exit 1
fi

curl --silent --fail \
	-H "x-admin-token: $ADMIN_TOKEN" \
	-H 'content-type: application/json' \
	-d '{"alias":"phase-one-persisted","provider":"codex","actual_model":"test-model"}' \
	"http://127.0.0.1:$PORT/admin/model-mappings" >/dev/null
stop_server

[[ -s "$TEST_DATABASE_PATH" ]]
start_server
curl --silent --fail -H "x-admin-token: $ADMIN_TOKEN" \
	"http://127.0.0.1:$PORT/admin/model-mappings" |
	grep -q '"alias":"phase-one-persisted"'
curl --silent --fail "http://127.0.0.1:$PORT/health" >/dev/null

curl --silent --show-error \
	-H "authorization: Bearer $PROXY_API_KEY" \
	-H 'content-type: application/json' \
	-d '{"model":"shutdown-test","messages":[{"role":"user","content":"wait"}]}' \
	"http://127.0.0.1:$PORT/v1/chat/completions" >/dev/null 2>&1 &
REQUEST_PID=$!
for _ in {1..50}; do
	[[ -s "$FAKE_PID_FILE" && -s "$FAKE_CHILD_PID_FILE" ]] && break
	sleep 0.1
done
[[ -s "$FAKE_PID_FILE" ]]
[[ -s "$FAKE_CHILD_PID_FILE" ]]
PROVIDER_PID=$(<"$FAKE_PID_FILE")
PROVIDER_CHILD_PID=$(<"$FAKE_CHILD_PID_FILE")
stop_server
wait "$REQUEST_PID" 2>/dev/null || true
for pid in "$PROVIDER_PID" "$PROVIDER_CHILD_PID"; do
	if kill -0 "$pid" 2>/dev/null &&
		[[ ! -r "/proc/$pid/stat" || $(awk '{ print $3 }' "/proc/$pid/stat") != Z ]]; then
		printf 'Provider process survived shutdown: %s\n' "$pid" >&2
		exit 1
	fi
done

printf 'Linux service restart and health smoke test passed.\n'
