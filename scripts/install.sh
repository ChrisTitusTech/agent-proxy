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

service_stop_all() {
	if use_systemd; then
		systemctl --user stop agent-proxy.service herdr.service 2>/dev/null || true
	fi
}

service_enable() {
	local start_now=${1:-true}
	if use_systemd; then
		systemctl --user daemon-reload
		systemctl --user enable herdr.service agent-proxy.service
		if [[ "$start_now" == true ]]; then
			systemctl --user start herdr.service agent-proxy.service
		fi
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
		agent-proxy/packages/server/dist/herdr/server.js
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

systemd_quote_value() {
	printf '%s' "$1" |
		sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'
}

install_units() {
	local release_dir=$1
	local data_escaped config_escaped state_escaped
	data_escaped=$(escape_sed "$(systemd_quote_value "$DATA_DIR")")
	config_escaped=$(escape_sed "$(systemd_quote_value "$CONFIG_DIR")")
	state_escaped=$(escape_sed "$(systemd_quote_value "$STATE_DIR")")
	mkdir -p "$UNIT_DIR"
	sed \
		-e "s|@DATA_DIR@|$data_escaped|g" \
		-e "s|@CONFIG_DIR@|$config_escaped|g" \
		-e "s|@STATE_DIR@|$state_escaped|g" \
		"$release_dir/packaging/systemd/agent-proxy.service" >"$PROXY_UNIT"
	sed \
		-e "s|@DATA_DIR@|$data_escaped|g" \
		-e "s|@CONFIG_DIR@|$config_escaped|g" \
		-e "s|@STATE_DIR@|$state_escaped|g" \
		"$release_dir/packaging/systemd/herdr.service" >"$HERDR_UNIT"
	chmod 0644 "$PROXY_UNIT" "$HERDR_UNIT"
}

validate_release_config() {
	local release_dir=$1
	CONFIG_PATH="$CONFIG_DIR/config.yaml" \
		AGENT_PROXY_DATABASE_PATH="$STATE_DIR/agent-proxy.db" \
		/usr/bin/env node "$release_dir/packages/server/dist/index.js" --check-config
}

create_backup() (
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
	trap 'rm -rf "$stage"' EXIT
	[[ ! -d "$CONFIG_DIR" ]] || cp -a "$CONFIG_DIR" "$stage/config"
	if [[ -d "$STATE_DIR" ]]; then
		mkdir -p "$stage/state"
		tar -C "$STATE_DIR" --exclude='./backups' -cf - . |
			tar -C "$stage/state" -xf -
	fi
	archive="$BACKUP_DIR/agent-proxy-backup-$(date -u +%Y%m%dT%H%M%S%N)Z.tar.gz"
	(umask 077 && tar -C "$stage" -czf "$archive" "${paths[@]}")
	chmod 0600 "$archive"
	printf '%s\n' "$archive"
)

backup_consistently() {
	local restart=false
	if service_is_active; then
		restart=true
		service_stop
	fi
	local status=0
	create_backup || status=$?
	if [[ "$restart" == true ]] && use_systemd; then
		systemctl --user start agent-proxy.service
	fi
	return "$status"
}

install_release() (
	set -E
	local start_service=${1:-true}
	validate_archive
	local extract_dir release_id release_dir old_current='' old_previous=''
	local activation_started=false
	extract_dir=$(mktemp -d)
	trap 'rm -rf "$extract_dir"' EXIT
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

	[[ ! -L "$DATA_DIR/current" ]] || old_current=$(readlink "$DATA_DIR/current")
	[[ ! -L "$DATA_DIR/previous" ]] || old_previous=$(readlink "$DATA_DIR/previous")
	# shellcheck disable=SC2317,SC2329 # Invoked indirectly by the ERR trap below.
	rollback_activation() {
		local status=$?
		trap - ERR
		set +e
		service_stop_all
		if [[ "$activation_started" == true ]]; then
			if [[ -n "$old_current" ]]; then
				ln -sfn "$old_current" "$DATA_DIR/current"
			else
				rm -f "$DATA_DIR/current"
			fi
			if [[ -n "$old_previous" ]]; then
				ln -sfn "$old_previous" "$DATA_DIR/previous"
			else
				rm -f "$DATA_DIR/previous"
			fi
		fi
		if [[ -n "$old_current" ]]; then
			install_units "$old_current"
		else
			rm -f "$PROXY_UNIT" "$HERDR_UNIT"
		fi
		if use_systemd; then
			systemctl --user daemon-reload
			if [[ "$start_service" == true && -n "$old_current" ]]; then
				systemctl --user start herdr.service agent-proxy.service
			fi
		fi
		rm -rf "$release_dir"
		printf 'Release activation failed; restored the previous current-user release.\n' >&2
		exit "$status"
	}
	trap rollback_activation ERR

	service_stop_all
	mkdir -p "$CONFIG_DIR" "$DATA_DIR/releases" "$STATE_DIR"
	chmod 0700 "$CONFIG_DIR" "$DATA_DIR" "$DATA_DIR/releases" "$STATE_DIR"
	cp -a "$extract_dir/agent-proxy" "$release_dir"

	if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
		install -m 0600 "$release_dir/packaging/systemd/config.example.yaml" \
			"$CONFIG_DIR/config.yaml"
	fi
	if [[ ! -f "$CONFIG_DIR/agent-proxy.env" ]]; then
		install -m 0600 /dev/null "$CONFIG_DIR/agent-proxy.env"
		{
			printf 'ADMIN_TOKEN=%s\n' "$(generate_secret '')"
			printf 'PROXY_API_KEY=%s\n' "$(generate_secret 'sk-proxy-')"
			printf 'CONFIG_PATH=%s/config.yaml\n' "$CONFIG_DIR"
			printf 'AGENT_PROXY_DATABASE_PATH=%s/agent-proxy.db\n' "$STATE_DIR"
			printf 'AGENT_PROXY_HOST=127.0.0.1\nAGENT_PROXY_PORT=8300\n'
			printf 'SHUTDOWN_TIMEOUT_MS=30000\n'
		} >"$CONFIG_DIR/agent-proxy.env"
	fi

	validate_release_config "$release_dir"
	[[ -z "$old_current" ]] || ln -sfn "$old_current" "$DATA_DIR/previous"
	ln -sfn "$release_dir" "$DATA_DIR/current"
	activation_started=true
	install_units "$release_dir"
	service_enable "$start_service"
	trap - ERR
	printf 'Activated current-user agent-proxy release %s\n' "$release_id"
)

case "$COMMAND" in
install)
	[[ -n "$ARCHIVE" ]] || {
		printf -- '--archive is required for install.\n' >&2
		exit 2
	}
	install_release true
	;;
upgrade)
	[[ -n "$ARCHIVE" ]] || {
		printf -- '--archive is required for upgrade.\n' >&2
		exit 2
	}
	was_active=false
	if service_is_active; then
		was_active=true
		service_stop
	fi
	if [[ -d "$CONFIG_DIR" || -d "$STATE_DIR" ]]; then
		if ! create_backup >/dev/null; then
			if [[ "$was_active" == true ]] && use_systemd; then
				systemctl --user start agent-proxy.service
			fi
			exit 1
		fi
	fi
	install_release "$was_active"
	;;
rollback)
	[[ -L "$DATA_DIR/previous" ]] || {
		printf 'No previous release is available.\n' >&2
		exit 1
	}
	[[ -L "$DATA_DIR/current" ]] || {
		printf 'No current release is active; cannot roll back.\n' >&2
		exit 1
	}
	current=$(readlink "$DATA_DIR/current")
	previous=$(readlink "$DATA_DIR/previous")
	[[ -n "$current" && -n "$previous" ]] || {
		printf 'Current or previous release link is invalid; cannot roll back.\n' >&2
		exit 1
	}
	service_stop_all
	ln -sfn "$previous" "$DATA_DIR/current"
	ln -sfn "$current" "$DATA_DIR/previous"
	install_units "$previous"
	service_enable
	printf 'Rolled back to %s\n' "$previous"
	;;
backup)
	backup_consistently
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
