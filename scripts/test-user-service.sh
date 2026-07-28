#!/usr/bin/env bash
# Verify the packaged units enforce a current-user Herdr-first lifecycle.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROXY_UNIT="$PROJECT_DIR/packaging/systemd/agent-proxy.service"
HERDR_UNIT="$PROJECT_DIR/packaging/systemd/herdr.service"

for unit in "$PROXY_UNIT" "$HERDR_UNIT"; do
	[[ -f "$unit" ]]
	if grep -Eq '^(User|Group)=' "$unit"; then
		printf 'User units must not select another account: %s\n' "$unit" >&2
		exit 1
	fi
	grep -q '^WantedBy=default.target$' "$unit"
done

grep -Eq '^After=.*herdr\.service' "$PROXY_UNIT"
grep -Eq '^Wants=.*herdr\.service' "$PROXY_UNIT"
grep -q '^ExecStart=/usr/bin/env herdr server$' "$HERDR_UNIT"
grep -q '@DATA_DIR@/current/packages/server/dist/index.js' "$PROXY_UNIT"

printf 'Current-user service units passed.\n'
