#!/usr/bin/env bash
# Start and stop the development API server and dashboard.

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PID_FILE="$PROJECT_DIR/.api.pid"
DASHBOARD_PID_FILE="$PROJECT_DIR/.dashboard.pid"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"

is_running() {
	local pid_file=$1
	[[ -f "$pid_file" ]] && kill -0 "$(<"$pid_file")" 2>/dev/null
}

start_service() {
	local name=$1
	local pid_file=$2
	local log_file=$3
	local command=$4
	local url=$5

	if is_running "$pid_file"; then
		printf '%s is already running (PID %s)\n' "$name" "$(<"$pid_file")"
		return
	fi

	(
		cd "$PROJECT_DIR" || exit 1
		nohup npm run "$command" >"$log_file" 2>&1 &
		printf '%s\n' "$!" >"$pid_file"
	)

	printf '%s started at %s (PID %s)\n' "$name" "$url" "$(<"$pid_file")"
}

stop_service() {
	local name=$1
	local pid_file=$2

	if ! is_running "$pid_file"; then
		rm -f "$pid_file"
		printf '%s is not running\n' "$name"
		return
	fi

	local pid
	pid=$(<"$pid_file")
	pkill -P "$pid" 2>/dev/null || true
	kill "$pid" 2>/dev/null || true
	rm -f "$pid_file"
	printf '%s stopped (PID %s)\n' "$name" "$pid"
}

start_servers() {
	start_service "API server" "$API_PID_FILE" "$LOG_DIR/api.log" "dev" "http://localhost:8300"
	start_service "Dashboard" "$DASHBOARD_PID_FILE" "$LOG_DIR/dashboard.log" "dev:dashboard" "http://localhost:5300"
}

stop_servers() {
	stop_service "API server" "$API_PID_FILE"
	stop_service "Dashboard" "$DASHBOARD_PID_FILE"
}

show_service_status() {
	local name=$1
	local pid_file=$2
	local url=$3

	if is_running "$pid_file"; then
		printf '%-10s running at %s (PID %s)\n' "$name:" "$url" "$(<"$pid_file")"
	else
		printf '%-10s stopped\n' "$name:"
	fi
}

show_status() {
	printf 'agent-proxy server status\n'
	show_service_status "API" "$API_PID_FILE" "http://localhost:8300"
	show_service_status "Dashboard" "$DASHBOARD_PID_FILE" "http://localhost:5300"
}

case "${1:-start}" in
start)
	start_servers
	;;
stop)
	stop_servers
	;;
restart)
	stop_servers
	start_servers
	;;
status)
	show_status
	;;
*)
	printf 'Usage: %s {start|stop|restart|status}\n' "$0" >&2
	exit 1
	;;
esac
