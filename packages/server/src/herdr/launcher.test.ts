import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HerdrLauncher,
  type ProviderExecutionRequest,
} from './launcher.js';

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
  ) => Promise<void>;
  command: (args: string[]) => Promise<unknown>;
  panes: Map<string, { paneId: string; tabId: string; lastUsedAt: number }>;
  reservedPaneIds: Set<string>;
}

function request(clientKey = 'client'): ProviderExecutionRequest {
  return {
    provider: 'codex',
    model: 'gpt-test',
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
});
