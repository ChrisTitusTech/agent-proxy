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
USER_PATH_BIN="$TEST_DIR/user-bin"
mkdir -p "$HOME" "$USER_PATH_BIN"
export PATH="$USER_PATH_BIN:$PATH"

make_archive() {
	local release_id=$1
	local stage="$TEST_DIR/stage-$release_id"
	local archive="$TEST_DIR/agent-proxy-$release_id.tar.gz"
	mkdir -p "$stage/agent-proxy/packages/server/dist/herdr" \
		"$stage/agent-proxy/packaging/systemd"
	printf '%s\n' "$release_id" >"$stage/agent-proxy/VERSION"
	printf '%s\n' \
		"if (process.argv.length !== 3 || process.argv[2] !== '--check-config') process.exit(2);" \
		"console.log(\"$release_id\");" \
		>"$stage/agent-proxy/packages/server/dist/index.js"
	printf 'process.exit(0);\n' >"$stage/agent-proxy/packages/server/dist/herdr/server.js"
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
ARCHIVE_V3=$(make_archive 1.0.0-test3)
ARCHIVE_V4=$(make_archive 1.0.0-test4)

run_installer install --archive "$ARCHIVE_V1"
[[ $(<"$XDG_DATA_HOME/agent-proxy/current/VERSION") == 1.0.0-test1 ]]
[[ -f "$XDG_CONFIG_HOME/systemd/user/agent-proxy.service" ]]
[[ -f "$XDG_CONFIG_HOME/systemd/user/herdr.service" ]]
grep -Fq "WorkingDirectory=\"${XDG_STATE_HOME//%/%%}/agent-proxy\"" \
	"$XDG_CONFIG_HOME/systemd/user/agent-proxy.service"
grep -Fq "ExecStart=/usr/bin/env node \"${XDG_DATA_HOME//%/%%}/agent-proxy/current/packages/server/dist/index.js\"" \
	"$XDG_CONFIG_HOME/systemd/user/agent-proxy.service"
grep -Fq "ExecStart=/usr/bin/env node \"${XDG_DATA_HOME//%/%%}/agent-proxy/current/packages/server/dist/herdr/server.js\"" \
	"$XDG_CONFIG_HOME/systemd/user/herdr.service"
[[ $(stat -c '%a' "$XDG_CONFIG_HOME/agent-proxy/agent-proxy.env") == 600 ]]
[[ $(stat -c '%a' "$XDG_CONFIG_HOME/agent-proxy/herdr.env") == 600 ]]
grep -Fq "PATH=$USER_PATH_BIN:" "$XDG_CONFIG_HOME/agent-proxy/agent-proxy.env"
grep -Fq "PATH=$USER_PATH_BIN:" "$XDG_CONFIG_HOME/agent-proxy/herdr.env"
if grep -Eq '^(ADMIN_TOKEN|PROXY_API_KEY)=' \
	"$XDG_CONFIG_HOME/agent-proxy/herdr.env"; then
	printf 'Herdr environment unexpectedly contains proxy credentials.\n' >&2
	exit 1
fi
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
HERDR_SYSTEMCTL_STATE="$TEST_DIR/herdr-systemctl.state"
SYSTEMCTL_FAIL_ONCE="$TEST_DIR/systemctl.fail-once"
export SYSTEMCTL_LOG SYSTEMCTL_STATE HERDR_SYSTEMCTL_STATE SYSTEMCTL_FAIL_ONCE
mkdir -p "$FAKE_BIN"
printf 'active\n' >"$SYSTEMCTL_STATE"
printf 'active\n' >"$HERDR_SYSTEMCTL_STATE"
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
"--user is-active --quiet herdr.service")
	[[ $(<"$HERDR_SYSTEMCTL_STATE") == active ]]
	;;
"--user stop agent-proxy.service")
	printf 'stop\n' >>"$SYSTEMCTL_LOG"
	printf 'inactive\n' >"$SYSTEMCTL_STATE"
	;;
"--user stop agent-proxy.service herdr.service")
	printf 'stop-both\n' >>"$SYSTEMCTL_LOG"
	printf 'inactive\n' >"$SYSTEMCTL_STATE"
	printf 'inactive\n' >"$HERDR_SYSTEMCTL_STATE"
	;;
"--user start agent-proxy.service")
	printf 'start\n' >>"$SYSTEMCTL_LOG"
	printf 'active\n' >"$SYSTEMCTL_STATE"
	;;
"--user start herdr.service")
	printf 'start-herdr\n' >>"$SYSTEMCTL_LOG"
	printf 'active\n' >"$HERDR_SYSTEMCTL_STATE"
	;;
"--user start herdr.service agent-proxy.service")
	printf 'start-both\n' >>"$SYSTEMCTL_LOG"
	if [[ -f "$SYSTEMCTL_FAIL_ONCE" ]]; then
		rm -f "$SYSTEMCTL_FAIL_ONCE"
		exit 1
	fi
	printf 'active\n' >"$SYSTEMCTL_STATE"
	printf 'active\n' >"$HERDR_SYSTEMCTL_STATE"
	;;
"--user disable agent-proxy.service herdr.service")
	printf 'disable-both\n' >>"$SYSTEMCTL_LOG"
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

: >"$SYSTEMCTL_LOG"
if PATH="$FAKE_BIN:$PATH" "$PROJECT_DIR/scripts/install.sh" \
	upgrade --archive "$ARCHIVE_V2"; then
	printf 'Upgrade unexpectedly reinstalled the active release.\n' >&2
	exit 1
fi
[[ $(<"$SYSTEMCTL_STATE") == active ]]
[[ ! -s "$SYSTEMCTL_LOG" ]]

touch "$SYSTEMCTL_FAIL_ONCE"
if PATH="$FAKE_BIN:$PATH" "$PROJECT_DIR/scripts/install.sh" upgrade --archive "$ARCHIVE_V3"; then
	printf 'Upgrade unexpectedly succeeded after a service activation failure.\n' >&2
	exit 1
fi
[[ $(<"$XDG_DATA_HOME/agent-proxy/current/VERSION") == 1.0.0-test2 ]]
grep -q '# release 1.0.0-test2' "$XDG_CONFIG_HOME/systemd/user/agent-proxy.service"
[[ $(<"$SYSTEMCTL_STATE") == active ]]
[[ ! -e "$XDG_DATA_HOME/agent-proxy/releases/1.0.0-test3" ]]

previous_target=$(readlink "$XDG_DATA_HOME/agent-proxy/previous")
ln -sfn "$XDG_DATA_HOME/agent-proxy/releases/missing" "$XDG_DATA_HOME/agent-proxy/previous"
if run_installer rollback; then
	printf 'Rollback unexpectedly accepted an incomplete previous release.\n' >&2
	exit 1
fi
[[ $(<"$SYSTEMCTL_STATE") == active ]]
[[ $(<"$XDG_DATA_HOME/agent-proxy/current/VERSION") == 1.0.0-test2 ]]
ln -sfn "$previous_target" "$XDG_DATA_HOME/agent-proxy/previous"

current_target=$(readlink "$XDG_DATA_HOME/agent-proxy/current")
rm -f "$XDG_DATA_HOME/agent-proxy/current"
if run_installer rollback; then
	printf 'Rollback unexpectedly succeeded without a current release link.\n' >&2
	exit 1
fi
ln -s "$current_target" "$XDG_DATA_HOME/agent-proxy/current"

run_installer rollback
[[ $(<"$XDG_DATA_HOME/agent-proxy/current/VERSION") == 1.0.0-test1 ]]
grep -q '# release 1.0.0-test1' "$XDG_CONFIG_HOME/systemd/user/agent-proxy.service"

run_installer uninstall
[[ ! -e "$XDG_DATA_HOME/agent-proxy" ]]
[[ -f "$XDG_CONFIG_HOME/agent-proxy/config.yaml" ]]
[[ -f "$XDG_STATE_HOME/agent-proxy/agent-proxy.db" ]]

run_installer install --archive "$ARCHIVE_V1"
printf 'inactive\n' >"$SYSTEMCTL_STATE"
printf 'active\n' >"$HERDR_SYSTEMCTL_STATE"
: >"$SYSTEMCTL_LOG"
PATH="$FAKE_BIN:$PATH" "$PROJECT_DIR/scripts/install.sh" \
	upgrade --archive "$ARCHIVE_V4"
[[ $(<"$XDG_DATA_HOME/agent-proxy/current/VERSION") == 1.0.0-test4 ]]
[[ $(<"$SYSTEMCTL_STATE") == inactive ]]
[[ $(<"$HERDR_SYSTEMCTL_STATE") == active ]]
[[ $(paste -sd, "$SYSTEMCTL_LOG") == stop-both,start-herdr ]]
run_installer uninstall --purge
[[ ! -e "$XDG_CONFIG_HOME/agent-proxy" ]]
[[ ! -e "$XDG_DATA_HOME/agent-proxy" ]]
[[ ! -e "$XDG_STATE_HOME/agent-proxy" ]]

: >"$SYSTEMCTL_LOG"
touch "$SYSTEMCTL_FAIL_ONCE"
if PATH="$FAKE_BIN:$PATH" "$PROJECT_DIR/scripts/install.sh" install --archive "$ARCHIVE_V1"; then
	printf 'First install unexpectedly survived a service activation failure.\n' >&2
	exit 1
fi
grep -q '^disable-both$' "$SYSTEMCTL_LOG"
[[ ! -e "$XDG_DATA_HOME/agent-proxy/current" ]]
[[ ! -e "$XDG_CONFIG_HOME/systemd/user/agent-proxy.service" ]]
[[ ! -e "$XDG_CONFIG_HOME/systemd/user/herdr.service" ]]

printf 'Current-user installer lifecycle passed.\n'
