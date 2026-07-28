import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HerdrLauncher } from './launcher.js';

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
