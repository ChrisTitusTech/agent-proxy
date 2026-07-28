#!/usr/bin/env bash
# Install and operate versioned agent-proxy releases for the logged-in user.

set -euo pipefail

COMMAND=${1:-}
[[ -n "$COMMAND" ]] && shift

ARCHIVE=
NO_SYSTEMD=false
PURGE=false

usage() {
	cat <<'EOF'
Usage:
  install.sh install|upgrade --archive FILE [--no-systemd]
  install.sh rollback|backup [--no-systemd]
  install.sh uninstall [--no-systemd] [--purge]

All files are installed into the current user's XDG directories. Configuration
and state are preserved by default. --purge removes them during uninstall.
EOF
}

while (($# > 0)); do
	case "$1" in
	--archive)
		ARCHIVE=${2:?--archive requires a file}
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

: "${HOME:?HOME must be set}"
CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
DATA_HOME=${XDG_DATA_HOME:-"$HOME/.local/share"}
STATE_HOME=${XDG_STATE_HOME:-"$HOME/.local/state"}

CONFIG_DIR="$CONFIG_HOME/agent-proxy"
DATA_DIR="$DATA_HOME/agent-proxy"
STATE_DIR="$STATE_HOME/agent-proxy"
BACKUP_DIR="$STATE_DIR/backups"
UNIT_DIR="$CONFIG_HOME/systemd/user"
PROXY_UNIT="$UNIT_DIR/agent-proxy.service"
HERDR_UNIT="$UNIT_DIR/herdr.service"

use_systemd() {
	[[ "$NO_SYSTEMD" == false ]] &&
		command -v systemctl >/dev/null &&
		systemctl --user show-environment >/dev/null 2>&1
}

service_stop() {
	if use_systemd; then
		systemctl --user stop agent-proxy.service 2>/dev/null || true
	fi
}

service_enable() {
	if use_systemd; then
		systemctl --user daemon-reload
		systemctl --user enable --now herdr.service agent-proxy.service
	fi
}

service_is_active() {
	use_systemd && systemctl --user is-active --quiet agent-proxy.service
}

validate_archive() {
	[[ -f "$ARCHIVE" ]] || {
		printf 'Release archive not found: %s\n' "$ARCHIVE" >&2
		exit 1
	}
	local listing metadata member
	local required=(
		agent-proxy/VERSION
		agent-proxy/packages/server/dist/index.js
		agent-proxy/packages/server/dist/herdr/worker.js
		agent-proxy/packaging/systemd/agent-proxy.service
		agent-proxy/packaging/systemd/herdr.service
		agent-proxy/packaging/systemd/agent-proxy.env
		agent-proxy/packaging/systemd/config.example.yaml
	)
	listing=$(tar -tzf "$ARCHIVE") || {
		printf 'Release archive could not be read.\n' >&2
		exit 1
	}
	if awk '
		substr($0, 1, 1) == "/" { unsafe = 1 }
		{
			count = split($0, part, "/")
			for (i = 1; i <= count; i++) if (part[i] == "..") unsafe = 1
		}
		END { exit unsafe ? 0 : 1 }
	' <<<"$listing"; then
		printf 'Release archive contains an unsafe path.\n' >&2
		exit 1
	fi
	metadata=$(tar -tvzf "$ARCHIVE") || exit 1
	if awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { bad = 1 }
		END { exit bad ? 0 : 1 }' <<<"$metadata"; then
		printf 'Release archive contains an unsupported member type.\n' >&2
		exit 1
	fi
	for member in "${required[@]}"; do
		tar -tzf "$ARCHIVE" -- "$member" >/dev/null 2>&1 || {
			printf 'Release archive is missing required file: %s\n' "$member" >&2
			exit 1
		}
	done
}

generate_secret() {
	local prefix=$1
	printf '%s' "$prefix"
	od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

escape_sed() {
	printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

install_units() {
	local release_dir=$1
	local data_escaped config_escaped state_escaped
	data_escaped=$(escape_sed "$DATA_DIR")
	config_escaped=$(escape_sed "$CONFIG_DIR")
	state_escaped=$(escape_sed "$STATE_DIR")
	mkdir -p "$UNIT_DIR"
	sed \
		-e "s|@DATA_DIR@|$data_escaped|g" \
		-e "s|@CONFIG_DIR@|$config_escaped|g" \
		-e "s|@STATE_DIR@|$state_escaped|g" \
		"$release_dir/packaging/systemd/agent-proxy.service" >"$PROXY_UNIT"
	install -m 0644 "$release_dir/packaging/systemd/herdr.service" "$HERDR_UNIT"
	chmod 0644 "$PROXY_UNIT"
}

create_backup() {
	local paths=()
	[[ -d "$CONFIG_DIR" ]] && paths+=(config)
	[[ -d "$STATE_DIR" ]] && paths+=(state)
	((${#paths[@]} > 0)) || {
		printf 'No configuration or state exists to back up.\n' >&2
		return 1
	}
	mkdir -p "$BACKUP_DIR"
	chmod 0700 "$BACKUP_DIR"
	local stage archive
	stage=$(mktemp -d)
	trap 'rm -rf "$stage"' RETURN
	[[ ! -d "$CONFIG_DIR" ]] || cp -a "$CONFIG_DIR" "$stage/config"
	[[ ! -d "$STATE_DIR" ]] || cp -a "$STATE_DIR" "$stage/state"
	archive="$BACKUP_DIR/agent-proxy-backup-$(date -u +%Y%m%dT%H%M%S%NZ).tar.gz"
	(umask 077 && tar -C "$stage" -czf "$archive" "${paths[@]}")
	chmod 0600 "$archive"
	printf '%s\n' "$archive"
}

install_release() {
	validate_archive
	local extract_dir release_id release_dir old_current=
	extract_dir=$(mktemp -d)
	trap 'rm -rf "$extract_dir"' RETURN
	tar -C "$extract_dir" -xzf "$ARCHIVE"
	release_id=$(<"$extract_dir/agent-proxy/VERSION")
	[[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]] || {
		printf 'Invalid release identifier in archive.\n' >&2
		exit 1
	}
	release_dir="$DATA_DIR/releases/$release_id"
	[[ ! -e "$release_dir" ]] || {
		printf 'Release is already installed: %s\n' "$release_id" >&2
		exit 1
	}

	service_stop
	mkdir -p "$CONFIG_DIR" "$DATA_DIR/releases" "$STATE_DIR"
	chmod 0700 "$CONFIG_DIR" "$DATA_DIR" "$DATA_DIR/releases" "$STATE_DIR"
	cp -a "$extract_dir/agent-proxy" "$release_dir"
	[[ ! -L "$DATA_DIR/current" ]] || old_current=$(readlink "$DATA_DIR/current")
	[[ -z "$old_current" ]] || ln -sfn "$old_current" "$DATA_DIR/previous"
	ln -sfn "$release_dir" "$DATA_DIR/current"

	if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
		install -m 0600 "$release_dir/packaging/systemd/config.example.yaml" \
			"$CONFIG_DIR/config.yaml"
	fi
	if [[ ! -f "$CONFIG_DIR/agent-proxy.env" ]]; then
		{
			printf 'ADMIN_TOKEN=%s\n' "$(generate_secret '')"
			printf 'PROXY_API_KEY=%s\n' "$(generate_secret 'sk-proxy-')"
			printf 'CONFIG_PATH=%s/config.yaml\n' "$CONFIG_DIR"
			printf 'AGENT_PROXY_DATABASE_PATH=%s/agent-proxy.db\n' "$STATE_DIR"
			printf 'AGENT_PROXY_HOST=127.0.0.1\nAGENT_PROXY_PORT=8300\n'
			printf 'SHUTDOWN_TIMEOUT_MS=30000\n'
		} >"$CONFIG_DIR/agent-proxy.env"
		chmod 0600 "$CONFIG_DIR/agent-proxy.env"
	fi
	install_units "$release_dir"
	service_enable
	printf 'Activated current-user agent-proxy release %s\n' "$release_id"
}

case "$COMMAND" in
install)
	[[ -n "$ARCHIVE" ]] || {
		printf -- '--archive is required for install.\n' >&2
		exit 2
	}
	install_release
	;;
upgrade)
	[[ -n "$ARCHIVE" ]] || {
		printf -- '--archive is required for upgrade.\n' >&2
		exit 2
	}
	[[ ! -d "$CONFIG_DIR" && ! -d "$STATE_DIR" ]] || create_backup >/dev/null
	install_release
	;;
rollback)
	[[ -L "$DATA_DIR/previous" ]] || {
		printf 'No previous release is available.\n' >&2
		exit 1
	}
	service_stop
	current=$(readlink "$DATA_DIR/current")
	previous=$(readlink "$DATA_DIR/previous")
	ln -sfn "$previous" "$DATA_DIR/current"
	ln -sfn "$current" "$DATA_DIR/previous"
	install_units "$previous"
	service_enable
	printf 'Rolled back to %s\n' "$previous"
	;;
backup)
	create_backup
	;;
uninstall)
	service_stop
	if use_systemd; then
		systemctl --user disable --now agent-proxy.service herdr.service 2>/dev/null || true
	fi
	rm -f "$PROXY_UNIT" "$HERDR_UNIT"
	rm -rf "$DATA_DIR"
	if [[ "$PURGE" == true ]]; then
		rm -rf "$CONFIG_DIR" "$STATE_DIR"
	fi
	if use_systemd; then
		systemctl --user daemon-reload
	fi
	printf 'Uninstalled current-user agent-proxy%s.\n' \
		"$([[ "$PURGE" == true ]] && printf ' and purged data' || printf '; configuration and state were preserved')"
	;;
esac
