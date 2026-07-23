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

VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
GIT_REVISION=$(git -C "$PROJECT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'source')
RELEASE_ID="${VERSION}-${GIT_REVISION}"
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

mkdir -p "$OUTPUT_DIR"
tar -C "$STAGE_DIR" -czf "$ARCHIVE" agent-proxy
printf '%s\n' "$ARCHIVE"
