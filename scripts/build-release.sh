#!/usr/bin/env bash
# Build a versioned Linux release archive from a clean source checkout.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT_DIR="$PROJECT_DIR/dist/releases"
SKIP_BUILD=false

usage() {
	printf 'Usage: %s [--output DIR] [--skip-build]\n' "$0"
}

while (($# > 0)); do
	case "$1" in
	--output)
		OUTPUT_DIR=${2:?--output requires a directory}
		shift 2
		;;
	--skip-build)
		SKIP_BUILD=true
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

command -v npm >/dev/null || {
	printf 'npm is required to build a release.\n' >&2
	exit 1
}
command -v tar >/dev/null || {
	printf 'tar is required to build a release.\n' >&2
	exit 1
}

VERSION=$(node -e '
const { join } = require("node:path");
process.stdout.write(require(join(process.argv[1], "package.json")).version);
' "$PROJECT_DIR")
GIT_REVISION=$(git -C "$PROJECT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'source')
RELEASE_ID="${VERSION}-${GIT_REVISION}"
if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain=v1 2>/dev/null)" ]]; then
	WORKTREE_REVISION=$(
		cd "$PROJECT_DIR"
		{
			printf 'status\0'
			git status --porcelain=v1 -z --untracked-files=all
			printf 'entries\0'
			git ls-files --cached --others --exclude-standard -z |
				LC_ALL=C sort -z |
				while IFS= read -r -d '' path; do
					printf 'path\0%s\0' "$path"
					printf 'index\0'
					git ls-files --stage -z -- "$path"
					printf 'worktree\0'
					if [[ -L "$path" ]]; then
						mode=$(stat -c '%f' -- "$path") || {
							printf 'Cannot read symlink mode for release fingerprint: %s\n' "$path" >&2
							exit 1
						}
						printf 'symlink\0mode\0%s\0target\0' "$mode"
						readlink -z -- "$path"
					elif [[ -f "$path" ]]; then
						mode=$(stat -c '%f' -- "$path") || {
							printf 'Cannot read file mode for release fingerprint: %s\n' "$path" >&2
							exit 1
						}
						printf 'file\0mode\0%s\0sha256\0' "$mode"
						sha256sum -- "$path" | cut -d ' ' -f 1
					elif [[ -d "$path" ]] &&
						git ls-files --stage -- "$path" | grep -q '^160000 '; then
						printf 'gitlink\0head\0'
						git -C "$path" rev-parse HEAD 2>/dev/null || printf 'MISSING\n'
						printf 'status\0'
						git -C "$path" status --porcelain=v1 -z 2>/dev/null || true
					elif [[ -e "$path" ]]; then
						mode=$(stat -c '%f' -- "$path") || {
							printf 'Cannot read special-file mode for release fingerprint: %s\n' "$path" >&2
							exit 1
						}
						printf 'other\0mode\0%s\n' "$mode"
					else
						printf 'DELETED\n'
					fi
				done
		} |
			sha256sum |
			cut -c1-12
	)
	RELEASE_ID="${RELEASE_ID}-dirty-${WORKTREE_REVISION}"
fi
ARCHIVE="$OUTPUT_DIR/agent-proxy-${RELEASE_ID}-linux-$(uname -m).tar.gz"
STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

cd "$PROJECT_DIR"
if [[ "$SKIP_BUILD" == false ]]; then
	npm ci
	npm run build
fi

[[ -f packages/shared/dist/index.js && -f packages/server/dist/index.js ]] || {
	printf 'Compiled output is missing. Run without --skip-build first.\n' >&2
	exit 1
}

mkdir -p "$STAGE_DIR/agent-proxy/packages/shared" \
	"$STAGE_DIR/agent-proxy/packages/server" \
	"$STAGE_DIR/agent-proxy/packages/dashboard" \
	"$STAGE_DIR/agent-proxy/packaging/systemd"
cp package.json package-lock.json "$STAGE_DIR/agent-proxy/"
cp packages/shared/package.json "$STAGE_DIR/agent-proxy/packages/shared/"
cp packages/server/package.json "$STAGE_DIR/agent-proxy/packages/server/"
cp packages/dashboard/package.json "$STAGE_DIR/agent-proxy/packages/dashboard/"
cp -a packages/shared/dist "$STAGE_DIR/agent-proxy/packages/shared/"
cp -a packages/server/dist "$STAGE_DIR/agent-proxy/packages/server/"
cp packaging/systemd/agent-proxy.service \
	packaging/systemd/agent-proxy.env \
	packaging/systemd/config.example.yaml \
	"$STAGE_DIR/agent-proxy/packaging/systemd/"
printf '%s\n' "$RELEASE_ID" >"$STAGE_DIR/agent-proxy/VERSION"

(cd "$STAGE_DIR/agent-proxy" &&
	npm ci --omit=dev --workspace=packages/server --include-workspace-root=false)

# npm creates workspace and executable symlinks. Materialize their targets so
# the installer can reject link-bearing archives without rejecting our release.
while IFS= read -r -d '' link_path; do
	resolved_path=$(readlink -f -- "$link_path") || {
		printf 'Release dependency link cannot be resolved: %s\n' "$link_path" >&2
		exit 1
	}
	case "$resolved_path" in
	"$STAGE_DIR/agent-proxy"/*) ;;
	*)
		printf 'Release dependency link escapes the staging directory: %s\n' "$link_path" >&2
		exit 1
		;;
	esac
	materialized_path="${link_path}.materialized"
	[[ ! -e "$materialized_path" && ! -L "$materialized_path" ]] || {
		printf 'Cannot materialize release dependency link: %s\n' "$link_path" >&2
		exit 1
	}
	cp -aL -- "$link_path" "$materialized_path"
	rm "$link_path"
	mv "$materialized_path" "$link_path"
done < <(find "$STAGE_DIR/agent-proxy" -type l -print0)

mkdir -p "$OUTPUT_DIR"
tar --hard-dereference -C "$STAGE_DIR" -czf "$ARCHIVE" agent-proxy
printf '%s\n' "$ARCHIVE"
