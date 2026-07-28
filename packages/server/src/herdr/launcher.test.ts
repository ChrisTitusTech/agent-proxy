import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HerdrLauncher,
  type ProviderExecutionHandle,
  type ProviderExecutionRequest,
} from './launcher.js';
import { HERDR_WORKER_PROTOCOL } from './protocol.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) => rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'agent-proxy-herdr-'));
  temporaryDirectories.push(directory);
  const statePath = resolve(directory, 'state.json');
  const binaryPath = resolve(directory, 'herdr-fixture');
  await writeFile(binaryPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
if (process.argv[2] !== 'status') process.exit(70);
process.stdout.write(JSON.stringify({ server: state }));
`, 'utf8');
  await chmod(binaryPath, 0o700);

  const launcher = new HerdrLauncher({
    binary: binaryPath,
    runtimeDirectory: resolve(directory, 'runtime'),
    workspaceLabel: 'test',
    commandTimeoutMs: 2_000,
    paneTtlMs: 30_000,
    maxPanes: 2,
  });
  return {
    launcher,
    setState: (state: object) => writeFile(statePath, JSON.stringify(state), 'utf8'),
  };
}

describe('Herdr launcher readiness', () => {
  it('fails closed before pane creation when Herdr is unavailable', async () => {
    const { launcher, setState } = await fixture();
    await setState({ running: false, compatible: true });

    await expect(launcher.start({
      provider: 'codex',
      model: 'test',
      executionIdentity: 'sandbox-read-only',
      clientKey: 'request:test',
      command: 'codex',
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 2_000,
    })).rejects.toThrow(/provider execution was not started/);
  });

  it('reports protocol incompatibility and recovers on the next readiness check', async () => {
    const { launcher, setState } = await fixture();
    await setState({
      running: true,
      compatible: false,
      version: '0.7.5',
      protocol: 16,
    });

    await expect(launcher.readiness()).resolves.toEqual({
      ready: false,
      version: '0.7.5',
      protocol: 16,
      message: 'Herdr client and server protocols are incompatible.',
    });

    await setState({
      running: true,
      compatible: true,
      version: '0.7.5',
      protocol: 17,
    });
    await expect(launcher.readiness()).resolves.toEqual({
      ready: true,
      version: '0.7.5',
      protocol: 17,
    });
  });
});

interface LauncherInternals {
  ensurePane: (
    sessionKey: string,
    request: ProviderExecutionRequest,
  ) => Promise<{ paneId: string; tabId: string; lastUsedAt: number }>;
  reportPane: (
    paneId: string,
    sessionKey: string,
    request: ProviderExecutionRequest,
    state: 'working' | 'idle',
    terminalState?: 'completed' | 'failed' | 'timed_out' | 'cancelled',
    deadline?: number,
  ) => Promise<void>;
  command: (
    args: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<unknown>;
  panes: Map<string, { paneId: string; tabId: string; lastUsedAt: number }>;
  reservedPaneIds: Set<string>;
  prunePanes: (currentKey: string) => Promise<void>;
  pruneStaleTabs: (workspaceId: string) => Promise<boolean>;
  ensureWorkspace: (cwd: string) => Promise<string>;
  sessionKey: (request: ProviderExecutionRequest) => string;
  releaseStartingSessionKey: (key: string) => void;
  sessionKeys: Map<string, { key: string; lastUsedAt: number }>;
  startWorker: (
    paneId: string,
    sessionKey: string,
    request: ProviderExecutionRequest,
  ) => Promise<ProviderExecutionHandle>;
  containCancelledPane: (paneId: string) => Promise<void>;
  quarantinedSessionKeys: Set<string>;
}

function request(clientKey = 'client'): ProviderExecutionRequest {
  return {
    provider: 'codex',
    model: 'gpt-test',
    executionIdentity: 'sandbox-read-only',
    requestId: 'request-test',
    clientKey,
    command: 'codex',
    args: [],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 2_000,
  };
}

function launcherWithCommandFixture(maxPanes = 1) {
  const launcher = new HerdrLauncher({
    binary: 'herdr',
    runtimeDirectory: resolve(tmpdir(), 'agent-proxy-herdr-test'),
    workspaceLabel: 'test',
    commandTimeoutMs: 2_000,
    paneTtlMs: 100,
    maxPanes,
  });
  const internals = launcher as unknown as LauncherInternals;
  const tabs: Array<{ tab_id: string; workspace_id: string; label: string }> = [];
  const panes: Array<{ pane_id: string; tab_id: string }> = [];
  const commands: string[][] = [];
  let sequence = 0;
  internals.command = async (args: string[]) => {
    commands.push(args);
    if (args[0] === 'workspace' && args[1] === 'list') {
      return { type: 'workspace_list', workspaces: [{ workspace_id: 'workspace', label: 'test' }] };
    }
    if (args[0] === 'tab' && args[1] === 'list') {
      return { type: 'tab_list', tabs: [...tabs] };
    }
    if (args[0] === 'pane' && args[1] === 'list') {
      return { type: 'pane_list', panes: [...panes] };
    }
    if (args[0] === 'tab' && args[1] === 'create') {
      sequence++;
      const label = args[args.indexOf('--label') + 1];
      const tab = { tab_id: `tab-${sequence}`, workspace_id: 'workspace', label };
      const pane = { pane_id: `pane-${sequence}`, tab_id: tab.tab_id };
      tabs.push(tab);
      panes.push(pane);
      return { type: 'tab_created', tab, root_pane: pane };
    }
    if (args[0] === 'tab' && args[1] === 'close') {
      const tabId = args[2];
      const tabIndex = tabs.findIndex((tab) => tab.tab_id === tabId);
      if (tabIndex >= 0) tabs.splice(tabIndex, 1);
      const paneIndex = panes.findIndex((pane) => pane.tab_id === tabId);
      if (paneIndex >= 0) panes.splice(paneIndex, 1);
      return { type: 'tab_closed' };
    }
    return { type: 'ok' };
  };
  return { internals, commands, tabs };
}

describe('Herdr pane lifecycle', () => {
  it('uses execution identity when selecting a reusable pane', () => {
    const { internals } = launcherWithCommandFixture();
    const permissive = internals.sessionKey({
      ...request('shared-client'),
      executionIdentity: 'sandbox-workspace-write',
    });
    const restricted = internals.sessionKey({
      ...request('shared-client'),
      executionIdentity: 'sandbox-read-only',
    });

    expect(restricted).not.toBe(permissive);
  });

  it('does not prune session keys while requests using them are starting', () => {
    const { internals } = launcherWithCommandFixture(1);
    const firstRequest = request('first');
    const firstKey = internals.sessionKey(firstRequest);

    internals.sessionKey(request('second'));
    internals.sessionKey(request('third'));

    expect(internals.sessionKey(firstRequest)).toBe(firstKey);
  });

  it('does not prune another request pane while its worker is still starting', async () => {
    const { internals, commands } = launcherWithCommandFixture(1);

    const first = await internals.ensurePane('session-a', request('a'));
    const second = await internals.ensurePane('session-b', request('b'));

    expect(first.paneId).not.toBe(second.paneId);
    expect(internals.reservedPaneIds).toEqual(new Set([first.paneId, second.paneId]));
    expect(commands.filter((args) => args[0] === 'tab' && args[1] === 'close')).toHaveLength(0);
  });

  it('closes and recreates a pane whose configured TTL expired', async () => {
    const { internals, commands } = launcherWithCommandFixture();
    const first = await internals.ensurePane('session-a', request());
    internals.reservedPaneIds.delete(first.paneId);
    internals.panes.get('session-a')!.lastUsedAt = Date.now() - 1_000;

    const second = await internals.ensurePane('session-a', request());

    expect(second.paneId).not.toBe(first.paneId);
    expect(commands).toContainEqual(['tab', 'close', first.tabId]);
  });

  it('reports an opaque session identifier in pane metadata', async () => {
    const { internals, commands } = launcherWithCommandFixture();

    await internals.reportPane(
      'pane-1',
      'a1b2c3d4e5f60708',
      request(),
      'working',
    );

    const metadata = commands.find(
      (args) => args[0] === 'pane' && args[1] === 'report-metadata',
    );
    expect(metadata).toContain('session=a1b2c3d4e5f60708');
    expect(metadata?.join(' ')).not.toContain('client');
  });

  it('closes a pane when terminal state reporting exhausts its retries', async () => {
    const { internals, commands } = launcherWithCommandFixture();
    internals.panes.set('session-a', {
      paneId: 'pane-1',
      tabId: 'tab-1',
      lastUsedAt: Date.now(),
    });
    const fixtureCommand = internals.command;
    internals.command = async (args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'report-agent') {
        commands.push(args);
        throw new Error('Herdr unavailable');
      }
      return fixtureCommand(args);
    };

    await internals.reportPane(
      'pane-1',
      'session-a',
      request(),
      'idle',
      'completed',
    );

    expect(commands.filter(
      (args) => args[0] === 'pane' && args[1] === 'report-agent',
    )).toHaveLength(3);
    expect(commands).toContainEqual(['tab', 'close', 'tab-1']);
    expect(internals.panes.has('session-a')).toBe(false);
  });

  it('quarantines a pane when terminal reporting and close both fail', async () => {
    const { internals } = launcherWithCommandFixture();
    internals.panes.set('session-a', {
      paneId: 'pane-1',
      tabId: 'tab-1',
      lastUsedAt: Date.now(),
    });
    internals.command = async (args: string[]) => {
      if (
        (args[0] === 'pane' && args[1] === 'report-agent')
        || (args[0] === 'tab' && args[1] === 'close')
      ) {
        throw new Error('Herdr unavailable');
      }
      return { type: 'ok' };
    };

    await expect(internals.reportPane(
      'pane-1',
      'session-a',
      request(),
      'idle',
      'completed',
    )).rejects.toThrow('Herdr unavailable');

    expect(internals.quarantinedSessionKeys).toContain('session-a');
    await expect(internals.ensurePane(
      'session-a',
      request(),
    )).rejects.toThrow(/could not be confirmed stopped/);
  });

  it('retains pane tracking when a prune close fails', async () => {
    const { internals } = launcherWithCommandFixture();
    internals.panes.set('session-a', {
      paneId: 'pane-1',
      tabId: 'tab-1',
      lastUsedAt: Date.now() - 1_000,
    });
    internals.command = async (args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'close') {
        throw new Error('temporary close failure');
      }
      return { type: 'ok' };
    };

    await internals.prunePanes('');

    expect(internals.panes.has('session-a')).toBe(true);
  });

  it('quarantines a session when forced cancellation cannot close its pane', async () => {
    const { internals } = launcherWithCommandFixture();
    internals.panes.set('session-a', {
      paneId: 'pane-1',
      tabId: 'tab-1',
      lastUsedAt: Date.now(),
    });
    internals.command = async (args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'close') {
        throw new Error('pane close failed');
      }
      return { type: 'ok' };
    };

    await internals.containCancelledPane('pane-1');

    expect(internals.quarantinedSessionKeys).toContain('session-a');
    await expect(internals.ensurePane(
      'session-a',
      request(),
    )).rejects.toThrow(/could not be confirmed stopped/);
  });

  it('continues stale-tab cleanup when one tab cannot be closed', async () => {
    const { internals, commands, tabs } = launcherWithCommandFixture();
    tabs.push({
      tab_id: 'stale-tab',
      workspace_id: 'workspace',
      label: 'api-codex-a1b2c3d4e5f60708',
    });
    tabs.push({
      tab_id: 'stale-tab-2',
      workspace_id: 'workspace',
      label: 'api-codex-a1b2c3d4e5f60709',
    });
    const fixtureCommand = internals.command;
    internals.command = async (args: string[]) => {
      if (
        args[0] === 'tab'
        && args[1] === 'close'
        && args[2] === 'stale-tab'
      ) {
        commands.push(args);
        throw new Error('stale tab is unreachable');
      }
      return fixtureCommand(args);
    };

    await expect(internals.pruneStaleTabs('workspace')).resolves.toBe(false);
    expect(commands).toContainEqual(['tab', 'close', 'stale-tab']);
    expect(commands).toContainEqual(['tab', 'close', 'stale-tab-2']);
  });

  it('retries stale-tab cleanup after a close failure', async () => {
    const { internals, commands, tabs } = launcherWithCommandFixture();
    tabs.push({
      tab_id: 'stale-tab',
      workspace_id: 'workspace',
      label: 'api-codex-a1b2c3d4e5f60708',
    });
    const fixtureCommand = internals.command;
    let closeAttempts = 0;
    internals.command = async (args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'close') {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error('temporary close failure');
      }
      return fixtureCommand(args);
    };

    await internals.ensureWorkspace(process.cwd());
    await internals.ensureWorkspace(process.cwd());

    expect(commands.filter(
      (args) => args[0] === 'tab' && args[1] === 'close',
    )).toHaveLength(1);
    expect(closeAttempts).toBe(2);
  });

  it('prunes session keys after their startup reservations end', () => {
    const { internals } = launcherWithCommandFixture(1);
    const keys = Array.from({ length: 4 }, (_, index) => (
      internals.sessionKey(request(`client-${index}`))
    ));

    expect(internals.sessionKeys.size).toBe(4);
    for (const key of keys) internals.releaseStartingSessionKey(key);

    expect(internals.sessionKeys.size).toBe(2);
  });

  it('does not launch a worker after startup consumes its request deadline', async () => {
    const { internals, commands } = launcherWithCommandFixture();
    internals.panes.set('session-a', {
      paneId: 'pane-1',
      tabId: 'tab-1',
      lastUsedAt: Date.now(),
    });
    internals.reportPane = async (
      _paneId,
      _sessionKey,
      _request,
      state,
    ) => {
      if (state === 'working') {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    };

    await expect(internals.startWorker(
      'pane-1',
      'session-a',
      { ...request(), timeoutMs: 5 },
    )).rejects.toThrow(/timed out/);
    expect(commands.some(
      (args) => args[0] === 'pane' && args[1] === 'run',
    )).toBe(false);
  });

  it('interrupts a pending pane command at the request deadline', async () => {
    const { internals } = launcherWithCommandFixture();
    internals.panes.set('session-a', {
      paneId: 'pane-1',
      tabId: 'tab-1',
      lastUsedAt: Date.now(),
    });
    internals.reportPane = async () => undefined;
    internals.command = async () => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('command deadline reached')), 200);
    });
    const startedAt = Date.now();

    await expect(internals.startWorker(
      'pane-1',
      'session-a',
      { ...request(), timeoutMs: 20 },
    )).rejects.toThrow(/timed out/);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('returns a handle when the worker exits before pane run resolves', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'agent-proxy-worker-exit-'));
    temporaryDirectories.push(directory);
    const workerPath = resolve(directory, 'early-exit-worker.mjs');
    await writeFile(workerPath, `
import { createConnection } from 'node:net';
const socket = createConnection(process.argv[2]);
let buffered = '';
socket.setEncoding('utf8');
socket.once('connect', () => {
  socket.write(JSON.stringify({
    type: 'ready',
    protocol: ${HERDR_WORKER_PROTOCOL},
    pid: process.pid,
  }) + '\\n');
});
socket.on('data', (chunk) => {
  buffered += chunk;
  if (!buffered.includes('\\n')) return;
  socket.write(JSON.stringify({ type: 'exit', code: 0 }) + '\\n');
  socket.end();
});
`, 'utf8');
    const { internals } = launcherWithCommandFixture();
    internals.panes.set('session-a', {
      paneId: 'pane-1',
      tabId: 'tab-1',
      lastUsedAt: Date.now(),
    });
    internals.reportPane = async () => undefined;
    const fixtureCommand = internals.command;
    internals.command = async (args: string[]) => {
      if (args[0] !== 'pane' || args[1] !== 'run') {
        return fixtureCommand(args);
      }
      await new Promise<void>((resolveExit, rejectExit) => {
        // pane run args contain the worker executable at 3 and socket path at 5.
        const worker = spawn(args[3], [workerPath, args[5]], {
          stdio: 'ignore',
        });
        worker.once('error', rejectExit);
        worker.once('exit', (code) => {
          if (code === 0) resolveExit();
          else rejectExit(new Error(`fixture worker exited ${code}`));
        });
      });
      return { type: 'ok' };
    };

    const handle = await internals.startWorker(
      'pane-1',
      'session-a',
      { ...request(), timeoutMs: 1_000 },
    );

    await expect(handle.completion).resolves.toMatchObject({
      exitCode: 0,
      terminalState: 'completed',
    });
  });
});
