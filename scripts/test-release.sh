#!/usr/bin/env bash
# Verify the production release archive and its startup preflight.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
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

printf 'Production release archive passed.\n'
