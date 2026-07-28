#!/usr/bin/env bash
# Verify live Herdr pane serialization and cross-session isolation under load.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_DIR"
HERDR_BIN=${HERDR_BIN:-herdr}
WORKSPACE_LABEL="agent-proxy-load-test-$$"
RUNTIME_DIR="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}/agent-proxy-load-$$"

cleanup() {
	local workspace_id
	workspace_id=$(
		"$HERDR_BIN" workspace list |
			node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const item = JSON.parse(input).result.workspaces.find((entry) => entry.label === process.argv[1]);
  if (item) process.stdout.write(item.workspace_id);
});
' "$WORKSPACE_LABEL"
	) || true
	[[ -z "$workspace_id" ]] || "$HERDR_BIN" workspace close "$workspace_id" >/dev/null || true
	rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT

npm run build --workspace=packages/server >/dev/null
HERDR_BIN="$HERDR_BIN" \
	HERDR_RUNTIME_DIR="$RUNTIME_DIR" \
	HERDR_WORKSPACE_LABEL="$WORKSPACE_LABEL" \
	node --input-type=module - <<'NODE'
import { execFileSync } from 'node:child_process';
import { HerdrLauncher } from './packages/server/dist/herdr/launcher.js';

const command = (...args) => JSON.parse(execFileSync(
  process.env.HERDR_BIN,
  args,
  { encoding: 'utf8' },
)).result;
const createdWorkspace = command(
  'workspace', 'create',
  '--cwd', process.cwd(),
  '--label', process.env.HERDR_WORKSPACE_LABEL,
  '--no-focus',
);
const workspaceId = createdWorkspace.workspace.workspace_id;
const staleTab = command(
  'tab', 'create',
  '--workspace', workspaceId,
  '--cwd', process.cwd(),
  '--label', 'api-stale-0123456789abcdef',
  '--no-focus',
).tab;

const launcher = new HerdrLauncher({
  binary: process.env.HERDR_BIN,
  runtimeDirectory: process.env.HERDR_RUNTIME_DIR,
  workspaceLabel: process.env.HERDR_WORKSPACE_LABEL,
  commandTimeoutMs: 10_000,
  paneTtlMs: 60_000,
  maxPanes: 8,
});
const request = (clientKey, marker) => ({
  provider: 'load-test',
  model: 'echo',
  clientKey,
  command: process.execPath,
  args: ['-e', `setTimeout(() => console.log(${JSON.stringify(marker)}), 250)`],
  cwd: process.cwd(),
  env: process.env,
  timeoutMs: 5_000,
});
async function run(clientKey, marker) {
  const handle = await launcher.start(request(clientKey, marker));
  let output = '';
  handle.stdout.on('data', (chunk) => { output += chunk; });
  await handle.completion;
  if (output.trim() !== marker) throw new Error(`Unexpected output for ${marker}: ${output}`);
  return handle.paneId;
}

const serialStart = Date.now();
const [sameA, sameB] = await Promise.all([
  run('key:test|session:shared', 'same-a'),
  run('key:test|session:shared', 'same-b'),
]);
const tabsAfterStart = command('tab', 'list', '--workspace', workspaceId).tabs;
if (tabsAfterStart.some((tab) => tab.tab_id === staleTab.tab_id)) {
  throw new Error('A stale API tab from the previous runtime was not pruned.');
}
const serialElapsed = Date.now() - serialStart;
if (sameA !== sameB || serialElapsed < 450) {
  throw new Error(`Shared session was not serialized: ${JSON.stringify({ sameA, sameB, serialElapsed })}`);
}

const parallelStart = Date.now();
const [isolatedA, isolatedB] = await Promise.all([
  run('key:test|session:isolated-a', 'isolated-a'),
  run('key:test|session:isolated-b', 'isolated-b'),
]);
const parallelElapsed = Date.now() - parallelStart;
if (isolatedA === isolatedB || parallelElapsed >= serialElapsed) {
  throw new Error(`Distinct sessions were not isolated: ${JSON.stringify({ isolatedA, isolatedB, parallelElapsed })}`);
}

const shutdownRequest = request('key:test|session:shutdown', 'never');
shutdownRequest.args = ['-e', 'setTimeout(() => console.log("never"), 30000)'];
shutdownRequest.timeoutMs = 35_000;
const activeHandle = await launcher.start(shutdownRequest);
activeHandle.stdout.resume();
activeHandle.stderr.resume();
const queuedStart = launcher.start(shutdownRequest);
await launcher.shutdown();
const shutdownResults = await Promise.allSettled([
  activeHandle.completion,
  queuedStart,
]);
if (shutdownResults.some((result) => result.status !== 'rejected')) {
  throw new Error(`Shutdown did not reject active and queued starts: ${JSON.stringify(shutdownResults)}`);
}
const panesAfterShutdown = command('pane', 'list', '--workspace', workspaceId).panes;
if (panesAfterShutdown.some((pane) => pane.agent_status === 'working')) {
  throw new Error('Shutdown returned before terminal Herdr pane reporting completed.');
}
NODE

printf 'Live Herdr load and isolation passed.\n'
