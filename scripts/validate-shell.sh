#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd -- "$repo_root"

for required_command in shellcheck shfmt; do
	if ! command -v "$required_command" >/dev/null 2>&1; then
		printf 'Required command is unavailable: %s\n' "$required_command" >&2
		exit 1
	fi
done

shell_file_list="$(mktemp)"
trap 'rm -f -- "$shell_file_list"' EXIT

printf '%s\0' start.sh >"$shell_file_list"
find scripts -type f -name '*.sh' -print0 >>"$shell_file_list"
mapfile -d '' -t shell_files <"$shell_file_list"

for shell_file in "${shell_files[@]}"; do
	bash -n "$shell_file"
done

shellcheck "${shell_files[@]}"
shfmt -d "${shell_files[@]}"
