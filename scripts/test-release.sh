#!/usr/bin/env bash
# Verify the production release archive and its startup preflight.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d)
SERVER_PID=

stop_server() {
	if [[ -z "$SERVER_PID" ]]; then
		return
	fi
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		wait "$SERVER_PID" 2>/dev/null || true
		SERVER_PID=
		return
	fi

	kill -TERM "$SERVER_PID" 2>/dev/null || true
	for _ in {1..50}; do
		if ! kill -0 "$SERVER_PID" 2>/dev/null; then
			wait "$SERVER_PID" 2>/dev/null || true
			SERVER_PID=
			return
		fi
		sleep 0.1
	done

	cat "$TEST_DIR/release-server.log" >&2
	kill -KILL "$SERVER_PID" 2>/dev/null || true
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=
	return 1
}

cleanup() {
	stop_server || true
	rm -rf "$TEST_DIR"
}
trap cleanup EXIT
cd "$PROJECT_DIR"

ARCHIVE=$(scripts/build-release.sh --skip-build --output "$TEST_DIR" | tail -1)
test -f "$ARCHIVE"
tar -tzf "$ARCHIVE" >"$TEST_DIR/archive-manifest.txt"
grep -q '^agent-proxy/VERSION$' "$TEST_DIR/archive-manifest.txt"
grep -q '^agent-proxy/packages/server/dist/index.js$' "$TEST_DIR/archive-manifest.txt"
grep -q '^agent-proxy/packaging/systemd/config.example.yaml$' \
	"$TEST_DIR/archive-manifest.txt"
grep -q '^agent-proxy/node_modules/' "$TEST_DIR/archive-manifest.txt"
if grep -q '^agent-proxy/node_modules/react/' "$TEST_DIR/archive-manifest.txt"; then
	printf 'Production archive contains dashboard-only React dependencies.\n' >&2
	exit 1
fi
if tar -tvzf "$ARCHIVE" |
	awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { found = 1 }
		END { exit found ? 0 : 1 }'; then
	printf 'Production archive contains an unsupported member type.\n' >&2
	exit 1
fi
scripts/install.sh install --root "$TEST_DIR/root" --no-systemd --archive "$ARCHIVE"

export CONFIG_PATH="$TEST_DIR/root/etc/agent-proxy/config.yaml"
export AGENT_PROXY_DATABASE_PATH="$TEST_DIR/root/var/lib/agent-proxy/agent-proxy.db"
export ADMIN_TOKEN=release-test-admin-token
export PROXY_API_KEY=sk-proxy-release-test-key

PREFLIGHT_OUTPUT=$(
	node "$TEST_DIR/root/opt/agent-proxy/current/packages/server/dist/index.js" --check
)
grep -q 'Preflight passed' <<<"$PREFLIGHT_OUTPUT"
grep -q 'Enabled providers: none' <<<"$PREFLIGHT_OUTPUT"

start_release_server() {
	for _ in {1..5}; do
		AGENT_PROXY_PORT=$(node -e '
const net = require("net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
  server.close();
});
')
		export AGENT_PROXY_PORT
		node "$TEST_DIR/root/opt/agent-proxy/current/packages/server/dist/index.js" \
			>"$TEST_DIR/release-server.log" 2>&1 &
		SERVER_PID=$!
		for _ in {1..100}; do
			if curl --silent --fail \
				"http://127.0.0.1:$AGENT_PROXY_PORT/health" >/dev/null; then
				return
			fi
			if ! kill -0 "$SERVER_PID" 2>/dev/null; then
				wait "$SERVER_PID" 2>/dev/null || true
				SERVER_PID=
				break
			fi
			sleep 0.1
		done
		if [[ -n "$SERVER_PID" ]]; then
			cat "$TEST_DIR/release-server.log" >&2
			stop_server || true
			printf 'Installed production server did not become healthy.\n' >&2
			return 1
		fi
	done

	cat "$TEST_DIR/release-server.log" >&2
	printf 'Installed production server could not bind a test port.\n' >&2
	return 1
}

start_release_server
curl --silent --fail "http://127.0.0.1:$AGENT_PROXY_PORT/health" >/dev/null
stop_server

printf 'Production release archive passed.\n'
