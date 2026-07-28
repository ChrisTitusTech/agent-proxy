#!/usr/bin/env bash
# Exercise the current-user installer in isolated XDG directories.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

export HOME="$TEST_DIR/home"
export XDG_CONFIG_HOME="$TEST_DIR/config"
export XDG_DATA_HOME="$TEST_DIR/data"
export XDG_STATE_HOME="$TEST_DIR/state"
mkdir -p "$HOME"

make_archive() {
	local release_id=$1
	local stage="$TEST_DIR/stage-$release_id"
	local archive="$TEST_DIR/agent-proxy-$release_id.tar.gz"
	mkdir -p "$stage/agent-proxy/packages/server/dist/herdr" \
		"$stage/agent-proxy/packaging/systemd"
	printf '%s\n' "$release_id" >"$stage/agent-proxy/VERSION"
	printf 'console.log("%s");\n' "$release_id" >"$stage/agent-proxy/packages/server/dist/index.js"
	printf 'process.exit(0);\n' >"$stage/agent-proxy/packages/server/dist/herdr/worker.js"
	cp "$PROJECT_DIR/packaging/systemd/"* "$stage/agent-proxy/packaging/systemd/"
	printf '# release %s\n' "$release_id" \
		>>"$stage/agent-proxy/packaging/systemd/agent-proxy.service"
	tar -C "$stage" -czf "$archive" agent-proxy
	printf '%s' "$archive"
}

run_installer() {
	"$PROJECT_DIR/scripts/install.sh" "$1" --no-systemd "${@:2}"
}

ARCHIVE_V1=$(make_archive 1.0.0-test1)
ARCHIVE_V2=$(make_archive 1.0.0-test2)

run_installer install --archive "$ARCHIVE_V1"
[[ $(<"$XDG_DATA_HOME/agent-proxy/current/VERSION") == 1.0.0-test1 ]]
[[ -f "$XDG_CONFIG_HOME/systemd/user/agent-proxy.service" ]]
[[ -f "$XDG_CONFIG_HOME/systemd/user/herdr.service" ]]
[[ $(stat -c '%a' "$XDG_CONFIG_HOME/agent-proxy/agent-proxy.env") == 600 ]]
if find "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" ! -user "$(id -un)" -print -quit |
	grep -q .; then
	printf 'Installer created a file not owned by the current user.\n' >&2
	exit 1
fi

printf 'operator-config\n' >>"$XDG_CONFIG_HOME/agent-proxy/config.yaml"
printf 'persistent-state\n' >"$XDG_STATE_HOME/agent-proxy/agent-proxy.db"

run_installer upgrade --archive "$ARCHIVE_V2"
[[ $(<"$XDG_DATA_HOME/agent-proxy/current/VERSION") == 1.0.0-test2 ]]
grep -q 'operator-config' "$XDG_CONFIG_HOME/agent-proxy/config.yaml"
grep -q 'persistent-state' "$XDG_STATE_HOME/agent-proxy/agent-proxy.db"
compgen -G "$XDG_STATE_HOME/agent-proxy/backups/*.tar.gz" >/dev/null

run_installer rollback
[[ $(<"$XDG_DATA_HOME/agent-proxy/current/VERSION") == 1.0.0-test1 ]]
grep -q '# release 1.0.0-test1' "$XDG_CONFIG_HOME/systemd/user/agent-proxy.service"

run_installer uninstall
[[ ! -e "$XDG_DATA_HOME/agent-proxy" ]]
[[ -f "$XDG_CONFIG_HOME/agent-proxy/config.yaml" ]]
[[ -f "$XDG_STATE_HOME/agent-proxy/agent-proxy.db" ]]

run_installer install --archive "$ARCHIVE_V1"
run_installer uninstall --purge
[[ ! -e "$XDG_CONFIG_HOME/agent-proxy" ]]
[[ ! -e "$XDG_DATA_HOME/agent-proxy" ]]
[[ ! -e "$XDG_STATE_HOME/agent-proxy" ]]

printf 'Current-user installer lifecycle passed.\n'
