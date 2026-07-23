#!/usr/bin/env bash
# Exercise the installer lifecycle in an isolated filesystem root.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

ROOT_DIR="$TEST_DIR/root"
mkdir -p "$ROOT_DIR"

make_archive() {
	local release_id=$1
	local stage="$TEST_DIR/stage-$release_id"
	local archive="$TEST_DIR/agent-proxy-$release_id.tar.gz"
	mkdir -p "$stage/agent-proxy/packages/server/dist" \
		"$stage/agent-proxy/packaging/systemd"
	printf '%s\n' "$release_id" >"$stage/agent-proxy/VERSION"
	printf 'console.log("%s");\n' "$release_id" >"$stage/agent-proxy/packages/server/dist/index.js"
	cp "$PROJECT_DIR/packaging/systemd/"* "$stage/agent-proxy/packaging/systemd/"
	printf '# release %s\n' "$release_id" \
		>>"$stage/agent-proxy/packaging/systemd/agent-proxy.service"
	tar -C "$stage" -czf "$archive" agent-proxy
	printf '%s' "$archive"
}

ARCHIVE_V1=$(make_archive 1.0.0-test1)
ARCHIVE_V2=$(make_archive 1.0.0-test2)
ARCHIVE_V3=$(make_archive 1.0.0-test3)
run_installer() {
	local command=$1
	shift
	"$PROJECT_DIR/scripts/install.sh" "$command" --root "$ROOT_DIR" --no-systemd "$@"
}

run_installer install --archive "$ARCHIVE_V1"
[[ $(<"$ROOT_DIR/opt/agent-proxy/current/VERSION") == 1.0.0-test1 ]]
[[ -f "$ROOT_DIR/etc/systemd/system/agent-proxy.service" ]]

printf 'operator-config\n' >>"$ROOT_DIR/etc/agent-proxy/config.yaml"
printf 'persistent-state\n' >"$ROOT_DIR/var/lib/agent-proxy/agent-proxy.db"

run_installer upgrade --archive "$ARCHIVE_V2"
[[ $(<"$ROOT_DIR/opt/agent-proxy/current/VERSION") == 1.0.0-test2 ]]
grep -q '# release 1.0.0-test2' "$ROOT_DIR/etc/systemd/system/agent-proxy.service"
grep -q 'operator-config' "$ROOT_DIR/etc/agent-proxy/config.yaml"
grep -q 'persistent-state' "$ROOT_DIR/var/lib/agent-proxy/agent-proxy.db"
compgen -G "$ROOT_DIR/var/backups/agent-proxy/*.tar.gz" >/dev/null
[[ $(stat -c '%a' "$ROOT_DIR/var/backups/agent-proxy") == 700 ]]
BACKUP_ARCHIVE=$(compgen -G "$ROOT_DIR/var/backups/agent-proxy/*.tar.gz" | head -1)
[[ $(stat -c '%a' "$BACKUP_ARCHIVE") == 600 ]]

run_installer rollback
[[ $(<"$ROOT_DIR/opt/agent-proxy/current/VERSION") == 1.0.0-test1 ]]
grep -q '# release 1.0.0-test1' "$ROOT_DIR/etc/systemd/system/agent-proxy.service"

chmod 0555 "$ROOT_DIR/opt/agent-proxy"
if run_installer upgrade --archive "$ARCHIVE_V3" >/dev/null 2>&1; then
	printf 'Installer activated a release without a writable link directory.\n' >&2
	exit 1
fi
chmod 0755 "$ROOT_DIR/opt/agent-proxy"
[[ $(<"$ROOT_DIR/opt/agent-proxy/current/VERSION") == 1.0.0-test1 ]]
[[ $(<"$ROOT_DIR/opt/agent-proxy/previous/VERSION") == 1.0.0-test2 ]]
[[ ! -e "$ROOT_DIR/opt/agent-proxy/releases/1.0.0-test3" ]]

run_installer backup >/dev/null
run_installer uninstall
[[ ! -e "$ROOT_DIR/opt/agent-proxy" ]]
[[ -f "$ROOT_DIR/etc/agent-proxy/config.yaml" ]]
[[ -f "$ROOT_DIR/var/lib/agent-proxy/agent-proxy.db" ]]

run_installer install --archive "$ARCHIVE_V1"
run_installer uninstall --purge
[[ ! -e "$ROOT_DIR/etc/agent-proxy" ]]
[[ ! -e "$ROOT_DIR/var/lib/agent-proxy" ]]
[[ ! -e "$ROOT_DIR/var/backups/agent-proxy" ]]

printf 'not-an-archive\n' >"$TEST_DIR/invalid.tar.gz"
if run_installer install --archive "$TEST_DIR/invalid.tar.gz" >/dev/null 2>&1; then
	printf 'Installer accepted an invalid release archive.\n' >&2
	exit 1
fi

LINK_STAGE="$TEST_DIR/link-stage"
mkdir -p "$LINK_STAGE/agent-proxy"
printf '1.0.0-link\n' >"$LINK_STAGE/agent-proxy/VERSION"
ln -s VERSION "$LINK_STAGE/agent-proxy/version-link"
tar -C "$LINK_STAGE" -czf "$TEST_DIR/symlink.tar.gz" agent-proxy
if run_installer install --archive "$TEST_DIR/symlink.tar.gz" >/dev/null 2>&1; then
	printf 'Installer accepted an archive containing a symbolic link.\n' >&2
	exit 1
fi

rm "$LINK_STAGE/agent-proxy/version-link"
ln "$LINK_STAGE/agent-proxy/VERSION" "$LINK_STAGE/agent-proxy/version-hardlink"
tar -C "$LINK_STAGE" -czf "$TEST_DIR/hardlink.tar.gz" agent-proxy
if run_installer install --archive "$TEST_DIR/hardlink.tar.gz" >/dev/null 2>&1; then
	printf 'Installer accepted an archive containing a hard link.\n' >&2
	exit 1
fi

PARTIAL_STAGE="$TEST_DIR/partial-stage"
mkdir -p "$PARTIAL_STAGE/agent-proxy/packages/server/dist"
printf '1.0.0-partial\n' >"$PARTIAL_STAGE/agent-proxy/VERSION"
printf 'console.log("partial");\n' >"$PARTIAL_STAGE/agent-proxy/packages/server/dist/index.js"
tar -C "$PARTIAL_STAGE" -czf "$TEST_DIR/partial.tar.gz" agent-proxy
if run_installer install --archive "$TEST_DIR/partial.tar.gz" >/dev/null 2>&1; then
	printf 'Installer accepted an incomplete release archive.\n' >&2
	exit 1
fi
[[ ! -e "$ROOT_DIR/opt/agent-proxy/releases/1.0.0-partial" ]]

printf 'Linux installer lifecycle passed.\n'
