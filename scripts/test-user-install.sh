#!/usr/bin/env bash
# Exercise the current-user installer in isolated XDG directories.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

export HOME="$TEST_DIR/home"
export XDG_CONFIG_HOME="$TEST_DIR/config home%test"
export XDG_DATA_HOME="$TEST_DIR/data home%test"
export XDG_STATE_HOME="$TEST_DIR/state home%test"
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
grep -Fq "WorkingDirectory=\"${XDG_STATE_HOME//%/%%}/agent-proxy\"" \
	"$XDG_CONFIG_HOME/systemd/user/agent-proxy.service"
grep -Fq "ExecStart=/usr/bin/env node \"${XDG_DATA_HOME//%/%%}/agent-proxy/current/packages/server/dist/index.js\"" \
	"$XDG_CONFIG_HOME/systemd/user/agent-proxy.service"
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
first_backup=$(find "$XDG_STATE_HOME/agent-proxy/backups" -type f -name '*.tar.gz' -print -quit)
FAKE_BIN="$TEST_DIR/fake-bin"
SYSTEMCTL_LOG="$TEST_DIR/systemctl.log"
SYSTEMCTL_STATE="$TEST_DIR/systemctl.state"
export SYSTEMCTL_LOG SYSTEMCTL_STATE
mkdir -p "$FAKE_BIN"
printf 'active\n' >"$SYSTEMCTL_STATE"
cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
"--user show-environment")
	exit 0
	;;
"--user is-active --quiet agent-proxy.service")
	[[ $(<"$SYSTEMCTL_STATE") == active ]]
	;;
"--user stop agent-proxy.service")
	printf 'stop\n' >>"$SYSTEMCTL_LOG"
	printf 'inactive\n' >"$SYSTEMCTL_STATE"
	;;
"--user start agent-proxy.service")
	printf 'start\n' >>"$SYSTEMCTL_LOG"
	printf 'active\n' >"$SYSTEMCTL_STATE"
	;;
*)
	exit 0
	;;
esac
EOF
chmod 0700 "$FAKE_BIN/systemctl"
PATH="$FAKE_BIN:$PATH" "$PROJECT_DIR/scripts/install.sh" backup >/dev/null
[[ $(<"$SYSTEMCTL_STATE") == active ]]
[[ $(paste -sd, "$SYSTEMCTL_LOG") == stop,start ]]
second_backup=$(find "$XDG_STATE_HOME/agent-proxy/backups" -type f -name '*.tar.gz' ! -samefile "$first_backup" -print -quit)
[[ -n "$second_backup" ]]
if tar -tzf "$second_backup" | grep -q '^state/backups/'; then
	printf 'Backup archive recursively included prior backups.\n' >&2
	exit 1
fi

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
