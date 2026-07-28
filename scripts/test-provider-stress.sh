#!/usr/bin/env bash
# Exercise provider backpressure, failure classification, and worker transport.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_DIR"

npm exec --no -- vitest run \
	packages/server/src/services/queue.test.ts \
	packages/server/src/utils/provider-error.test.ts \
	packages/server/src/herdr/worker.test.ts \
	packages/server/src/providers/codex-cli-session-manager.test.ts \
	packages/server/src/providers/agy-provider.test.ts \
	packages/server/src/providers/grok-provider.test.ts

printf 'Provider reliability stress gate passed.\n'
