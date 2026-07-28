#!/usr/bin/env bash
# Run one structured worker through the logged-in user's live Herdr server.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_DIR"
HERDR_BIN=${HERDR_BIN:-herdr}
WORKSPACE_LABEL="agent-proxy-live-test-$$"
RUNTIME_DIR="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}/agent-proxy-test-$$"

cleanup() {
	local workspace_id
	workspace_id=$(
		"$HERDR_BIN" workspace list |
			node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const label = process.argv[1];
  const item = JSON.parse(input).result.workspaces.find((entry) => entry.label === label);
  if (item) process.stdout.write(item.workspace_id);
});
' "$WORKSPACE_LABEL"
	) || true
	[[ -z "$workspace_id" ]] || "$HERDR_BIN" workspace close "$workspace_id" >/dev/null || true
	rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT

"$HERDR_BIN" status --json |
	node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const status = JSON.parse(input);
  if (!status.server?.running || !status.server?.compatible) process.exit(1);
});
'

npm run build --workspace=packages/server >/dev/null
HERDR_BIN="$HERDR_BIN" \
	HERDR_RUNTIME_DIR="$RUNTIME_DIR" \
	HERDR_WORKSPACE_LABEL="$WORKSPACE_LABEL" \
	node --input-type=module - <<'NODE'
import { execFileSync } from 'node:child_process';
import { HerdrLauncher } from './packages/server/dist/herdr/launcher.js';

const launcher = new HerdrLauncher({
  binary: process.env.HERDR_BIN,
  runtimeDirectory: process.env.HERDR_RUNTIME_DIR,
  workspaceLabel: process.env.HERDR_WORKSPACE_LABEL,
  commandTimeoutMs: 10_000,
  paneTtlMs: 60_000,
  maxPanes: 4,
});
const handle = await launcher.start({
  provider: 'launcher-test',
  model: 'structured-echo',
  clientKey: 'key:test|session:launcher',
  command: process.execPath,
  args: ['-e', 'process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log(s);console.error("stderr-ok")})'],
  cwd: process.cwd(),
  env: process.env,
  stdin: 'stdout-ok',
  timeoutMs: 10_000,
});
let stdout = '';
let stderr = '';
handle.stdout.on('data', (chunk) => { stdout += chunk; });
handle.stderr.on('data', (chunk) => { stderr += chunk; });
const result = await handle.completion;
if (stdout.trim() !== 'stdout-ok' || stderr.trim() !== 'stderr-ok' || result.exitCode !== 0) {
  throw new Error(`Structured Herdr execution failed: ${JSON.stringify({ stdout, stderr, result })}`);
}
const expectedWorkspacePaneCount = 2;
const listed = JSON.parse(execFileSync(
  process.env.HERDR_BIN,
  ['workspace', 'list'],
  { encoding: 'utf8' },
));
const workspace = listed.result.workspaces.find(
  (entry) => entry.label === process.env.HERDR_WORKSPACE_LABEL,
);
if (!workspace || workspace.pane_count < expectedWorkspacePaneCount) {
  throw new Error(`Expected live Herdr workspace with ${expectedWorkspacePaneCount} panes.`);
}
await launcher.shutdown();
NODE

printf 'Live Herdr launcher passed.\n'
