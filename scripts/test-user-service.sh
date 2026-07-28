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
	grep -q '^PrivateDevices=true$' "$unit"
	grep -q '^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$' "$unit"
	grep -q '^RestrictNamespaces=true$' "$unit"
	grep -q '^RestrictSUIDSGID=true$' "$unit"
	grep -q '^CapabilityBoundingSet=$' "$unit"
	grep -q '^LockPersonality=true$' "$unit"
	grep -q '^SystemCallArchitectures=native$' "$unit"
	grep -q '^ProtectKernelModules=true$' "$unit"
	grep -q '^ProtectKernelTunables=true$' "$unit"
	grep -q '^ProtectHostname=true$' "$unit"
done

grep -Eq '^After=.*herdr\.service' "$PROXY_UNIT"
grep -Eq '^Wants=.*herdr\.service' "$PROXY_UNIT"
grep -q '^EnvironmentFile="@CONFIG_DIR@/agent-proxy.env"$' "$HERDR_UNIT"
grep -q '^ExecStart=/usr/bin/env node "@DATA_DIR@/current/packages/server/dist/herdr/server.js"$' \
	"$HERDR_UNIT"
grep -q '@DATA_DIR@/current/packages/server/dist/index.js' "$PROXY_UNIT"
grep -q '^RuntimeDirectory=agent-proxy$' "$PROXY_UNIT"
grep -q '^RuntimeDirectoryMode=0700$' "$PROXY_UNIT"
grep -q '^RuntimeDirectory=agent-proxy$' "$HERDR_UNIT"
grep -q '^RuntimeDirectoryMode=0700$' "$HERDR_UNIT"
grep -q '"%t/agent-proxy"' "$PROXY_UNIT"
grep -q '^ExecStart=/usr/bin/env node "@DATA_DIR@/current/packages/server/dist/index.js"$' "$PROXY_UNIT"

printf 'Current-user service units passed.\n'
