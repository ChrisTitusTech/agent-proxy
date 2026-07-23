#!/usr/bin/env bash
# Install and operate versioned agent-proxy Linux releases.

set -euo pipefail

COMMAND=${1:-}
[[ -n "$COMMAND" ]] && shift

ARCHIVE=
DESTDIR=/
NO_SYSTEMD=false
PURGE=false

usage() {
	cat <<'EOF'
Usage:
  install.sh install|upgrade --archive FILE [--root DIR] [--no-systemd]
  install.sh rollback [--root DIR] [--no-systemd]
  install.sh backup [--root DIR] [--no-systemd]
  install.sh uninstall [--root DIR] [--no-systemd] [--purge]

Configuration and state are preserved by default. --purge permanently removes
them during uninstall.
EOF
}

while (($# > 0)); do
	case "$1" in
	--archive)
		ARCHIVE=${2:?--archive requires a file}
		shift 2
		;;
	--root)
		DESTDIR=${2:?--root requires a directory}
		shift 2
		;;
	--no-systemd)
		NO_SYSTEMD=true
		shift
		;;
	--purge)
		PURGE=true
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

case "$COMMAND" in
install | upgrade | rollback | backup | uninstall) ;;
*)
	usage >&2
	exit 2
	;;
esac

DESTDIR=${DESTDIR%/}
[[ -n "$DESTDIR" ]] || DESTDIR=/

root_path() {
	if [[ "$DESTDIR" == / ]]; then
		printf '%s' "$1"
	else
		printf '%s%s' "$DESTDIR" "$1"
	fi
}

OPT_DIR=$(root_path /opt/agent-proxy)
ETC_DIR=$(root_path /etc/agent-proxy)
STATE_DIR=$(root_path /var/lib/agent-proxy)
LOG_DIR=$(root_path /var/log/agent-proxy)
BACKUP_DIR=$(root_path /var/backups/agent-proxy)
UNIT_PATH=$(root_path /etc/systemd/system/agent-proxy.service)
INSTALL_EXTRACT_DIR=
INSTALL_RELEASE_DIR=
INSTALL_RESTORE_SERVICE=false
INSTALL_ACTIVATION_STARTED=false
INSTALL_HAD_CURRENT=false
INSTALL_HAD_PREVIOUS=false
INSTALL_OLD_CURRENT_TARGET=
INSTALL_OLD_PREVIOUS_TARGET=
INSTALL_UNIT_MODIFIED=false
INSTALL_HAD_UNIT=false
INSTALL_OLD_UNIT_PATH=

cleanup_partial_install() {
	set +e
	if [[ "$INSTALL_ACTIVATION_STARTED" == true ]]; then
		if [[ "$INSTALL_HAD_CURRENT" == true ]]; then
			ln -sfn "$INSTALL_OLD_CURRENT_TARGET" "$OPT_DIR/current"
		else
			rm -f "$OPT_DIR/current"
		fi
		if [[ "$INSTALL_HAD_PREVIOUS" == true ]]; then
			ln -sfn "$INSTALL_OLD_PREVIOUS_TARGET" "$OPT_DIR/previous"
		else
			rm -f "$OPT_DIR/previous"
		fi
	fi
	if [[ "$INSTALL_UNIT_MODIFIED" == true ]]; then
		if [[ "$INSTALL_HAD_UNIT" == true ]]; then
			install -D -m 0644 "$INSTALL_OLD_UNIT_PATH" "$UNIT_PATH"
		else
			rm -f "$UNIT_PATH"
		fi
	fi
	if [[ -n "$INSTALL_EXTRACT_DIR" ]]; then
		rm -rf "$INSTALL_EXTRACT_DIR"
	fi
	if [[ -n "$INSTALL_RELEASE_DIR" ]]; then
		rm -rf "$INSTALL_RELEASE_DIR"
	fi
	if [[ "$INSTALL_RESTORE_SERVICE" == true ]]; then
		service_start || true
	fi
}

use_systemd() {
	[[ "$NO_SYSTEMD" == false && "$DESTDIR" == / ]] && command -v systemctl >/dev/null
}

service_stop() {
	if use_systemd; then
		systemctl stop agent-proxy.service 2>/dev/null || true
	fi
}

service_start() {
	if use_systemd; then
		systemctl daemon-reload
		systemctl enable --now agent-proxy.service
	fi
}

service_is_active() {
	use_systemd && systemctl is-active --quiet agent-proxy.service
}

service_enable() {
	if use_systemd; then
		systemctl daemon-reload
		systemctl enable agent-proxy.service
	fi
}

ensure_root() {
	if [[ "$DESTDIR" == / && $EUID -ne 0 ]]; then
		printf 'Run this command as root, or use --root for a staged installation.\n' >&2
		exit 1
	fi
}

ensure_service_account() {
	if [[ "$DESTDIR" != / ]]; then
		return
	fi
	if ! getent group agent-proxy >/dev/null; then
		groupadd --system agent-proxy
	fi
	if ! id agent-proxy >/dev/null 2>&1; then
		useradd --system --gid agent-proxy --home-dir /var/lib/agent-proxy \
			--create-home --shell /usr/sbin/nologin agent-proxy
	fi
}

ensure_runtime() {
	if [[ "$DESTDIR" != / ]]; then
		return
	fi
	if [[ ! -x /usr/bin/node ]]; then
		printf 'Node.js 24 or newer must be installed at /usr/bin/node.\n' >&2
		exit 1
	fi
	local node_major
	node_major=$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')
	if [[ ! "$node_major" =~ ^[0-9]+$ ]] || ((node_major < 24)); then
		printf 'Node.js 24 or newer is required; /usr/bin/node reports major version %s.\n' "$node_major" >&2
		exit 1
	fi
}

validate_archive() {
	[[ -f "$ARCHIVE" ]] || {
		printf 'Release archive not found: %s\n' "$ARCHIVE" >&2
		exit 1
	}
	local archive_listing archive_metadata required_member required_metadata
	local required_members=(
		agent-proxy/VERSION
		agent-proxy/packages/server/dist/index.js
		agent-proxy/packaging/systemd/agent-proxy.service
		agent-proxy/packaging/systemd/agent-proxy.env
		agent-proxy/packaging/systemd/config.example.yaml
	)
	if ! archive_listing=$(tar -tzf "$ARCHIVE"); then
		printf 'Release archive could not be read.\n' >&2
		exit 1
	fi
	if awk '
			substr($0, 1, 1) == "/" { unsafe = 1 }
			{
				count = split($0, part, "/")
				for (i = 1; i <= count; i++) {
					if (part[i] == "..") unsafe = 1
				}
			}
			END { exit unsafe ? 0 : 1 }
		' <<<"$archive_listing"; then
		printf 'Release archive contains an unsafe path.\n' >&2
		exit 1
	fi
	if ! archive_metadata=$(tar -tvzf "$ARCHIVE"); then
		printf 'Release archive metadata could not be read.\n' >&2
		exit 1
	fi
	if awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { found = 1 }
		END { exit found ? 0 : 1 }' <<<"$archive_metadata"; then
		printf 'Release archive contains an unsupported member type.\n' >&2
		exit 1
	fi
	for required_member in "${required_members[@]}"; do
		if ! required_metadata=$(tar -tvzf "$ARCHIVE" -- "$required_member" 2>/dev/null) ||
			[[ "$required_metadata" == *$'\n'* || ${required_metadata:0:1} != "-" ]]; then
			printf 'Release archive is missing required regular file: %s\n' \
				"$required_member" >&2
			exit 1
		fi
	done
}

create_backup() {
	local restart_after=${1:-true}
	local was_active=false
	if service_is_active; then
		was_active=true
	fi
	local paths=()
	[[ -d "$ETC_DIR" ]] && paths+=(etc/agent-proxy)
	[[ -d "$STATE_DIR" ]] && paths+=(var/lib/agent-proxy)
	if ((${#paths[@]} == 0)); then
		printf 'No configuration or state exists to back up.\n' >&2
		return 1
	fi

	install -d -m 0700 "$BACKUP_DIR"
	local stamp archive backup_status=0
	stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
	archive="$BACKUP_DIR/agent-proxy-backup-$stamp.tar.gz"
	service_stop
	if ! (umask 077 && tar -C "$DESTDIR" -czf "$archive" "${paths[@]}"); then
		backup_status=1
	fi
	if ((backup_status == 0)) && ! chmod 0600 "$archive"; then
		backup_status=1
	fi
	if ((backup_status != 0)); then
		rm -f "$archive"
		if [[ "$was_active" == true ]]; then
			service_start
		fi
		return "$backup_status"
	fi
	if [[ "$restart_after" == true && "$was_active" == true ]]; then
		service_start
	fi
	printf '%s\n' "$archive"
}

install_release() {
	local start_service=$1
	validate_archive
	local extract_dir release_id release_dir=''
	extract_dir=$(mktemp -d)
	INSTALL_EXTRACT_DIR=$extract_dir
	trap cleanup_partial_install EXIT
	tar -C "$extract_dir" -xzf "$ARCHIVE"
	release_id=$(<"$extract_dir/agent-proxy/VERSION")
	[[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]] || {
		printf 'Invalid release identifier in archive.\n' >&2
		exit 1
	}
	release_dir="$OPT_DIR/releases/$release_id"
	[[ ! -e "$release_dir" ]] || {
		printf 'Release is already installed: %s\n' "$release_id" >&2
		exit 1
	}
	INSTALL_RELEASE_DIR=$release_dir
	[[ ! -e "$OPT_DIR/current" || -L "$OPT_DIR/current" ]] || {
		printf 'Current release path is not a symbolic link.\n' >&2
		exit 1
	}
	[[ ! -e "$OPT_DIR/previous" || -L "$OPT_DIR/previous" ]] || {
		printf 'Previous release path is not a symbolic link.\n' >&2
		exit 1
	}
	INSTALL_RESTORE_SERVICE=$start_service

	service_stop
	mkdir -p "$OPT_DIR/releases" "$ETC_DIR" "$STATE_DIR" "$LOG_DIR"
	cp -a "$extract_dir/agent-proxy" "$release_dir"

	[[ -f "$ETC_DIR/config.yaml" ]] ||
		install -m 0640 "$release_dir/packaging/systemd/config.example.yaml" "$ETC_DIR/config.yaml"
	[[ -f "$ETC_DIR/agent-proxy.env" ]] ||
		install -m 0600 "$release_dir/packaging/systemd/agent-proxy.env" "$ETC_DIR/agent-proxy.env"
	INSTALL_OLD_UNIT_PATH="$extract_dir/previous-agent-proxy.service"
	if [[ -f "$UNIT_PATH" ]]; then
		cp -a "$UNIT_PATH" "$INSTALL_OLD_UNIT_PATH"
		INSTALL_HAD_UNIT=true
	fi
	INSTALL_UNIT_MODIFIED=true
	install -D -m 0644 "$release_dir/packaging/systemd/agent-proxy.service" "$UNIT_PATH"

	if [[ "$DESTDIR" == / ]]; then
		chown -R root:agent-proxy "$OPT_DIR" "$ETC_DIR"
		chown -R agent-proxy:agent-proxy "$STATE_DIR" "$LOG_DIR"
	fi

	if [[ -L "$OPT_DIR/current" ]]; then
		INSTALL_HAD_CURRENT=true
		INSTALL_OLD_CURRENT_TARGET=$(readlink "$OPT_DIR/current")
	fi
	if [[ -L "$OPT_DIR/previous" ]]; then
		INSTALL_HAD_PREVIOUS=true
		INSTALL_OLD_PREVIOUS_TARGET=$(readlink "$OPT_DIR/previous")
	fi

	INSTALL_ACTIVATION_STARTED=true
	if [[ "$INSTALL_HAD_CURRENT" == true ]]; then
		ln -sfn "$INSTALL_OLD_CURRENT_TARGET" "$OPT_DIR/previous"
	fi
	ln -sfn "$release_dir" "$OPT_DIR/current"

	if [[ "$start_service" == true ]]; then
		service_start
	else
		service_enable
	fi

	INSTALL_EXTRACT_DIR=
	INSTALL_RELEASE_DIR=
	INSTALL_RESTORE_SERVICE=false
	INSTALL_ACTIVATION_STARTED=false
	INSTALL_UNIT_MODIFIED=false
	trap - EXIT
	rm -rf "$extract_dir"
	printf 'Activated agent-proxy release %s\n' "$release_id"
}

ensure_root

case "$COMMAND" in
install)
	ensure_runtime
	ensure_service_account
	[[ -n "$ARCHIVE" ]] || {
		printf -- '--archive is required for install.\n' >&2
		exit 2
	}
	install_release false
	if use_systemd; then
		printf 'Set production credentials, authenticate providers, then start agent-proxy.service.\n'
	fi
	;;
upgrade)
	ensure_runtime
	ensure_service_account
	[[ -n "$ARCHIVE" ]] || {
		printf -- '--archive is required for upgrade.\n' >&2
		exit 2
	}
	upgrade_was_active=false
	if service_is_active; then
		upgrade_was_active=true
	fi
	if [[ -d "$ETC_DIR" || -d "$STATE_DIR" ]]; then
		create_backup false >/dev/null
	fi
	install_release "$upgrade_was_active"
	;;
rollback)
	[[ -L "$OPT_DIR/previous" ]] || {
		printf 'No previous release is available.\n' >&2
		exit 1
	}
	current_target=$(readlink "$OPT_DIR/current")
	previous_target=$(readlink "$OPT_DIR/previous")
	previous_unit="$previous_target/packaging/systemd/agent-proxy.service"
	[[ -f "$previous_unit" ]] || {
		printf 'Previous release does not contain a systemd unit: %s\n' \
			"$previous_target" >&2
		exit 1
	}
	service_stop
	install -D -m 0644 "$previous_unit" "$UNIT_PATH"
	ln -sfn "$previous_target" "$OPT_DIR/current"
	ln -sfn "$current_target" "$OPT_DIR/previous"
	service_start
	printf 'Rolled back to %s\n' "$previous_target"
	;;
backup)
	create_backup
	;;
uninstall)
	service_stop
	if use_systemd; then
		systemctl disable agent-proxy.service 2>/dev/null || true
	fi
	rm -f "$UNIT_PATH"
	rm -rf "$OPT_DIR"
	if [[ "$PURGE" == true ]]; then
		rm -rf "$ETC_DIR" "$STATE_DIR" "$LOG_DIR" "$BACKUP_DIR"
	fi
	if use_systemd; then
		systemctl daemon-reload
	fi
	printf 'Uninstalled agent-proxy%s.\n' "$([[ "$PURGE" == true ]] && printf ' and purged data' || printf '; configuration and state were preserved')"
	;;
esac
