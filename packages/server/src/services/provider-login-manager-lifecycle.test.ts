import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { ProviderConfigYaml } from '@agent-proxy/shared';
import { ProviderLoginManager } from './provider-login-manager.js';

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn(() => true);
  return child;
}

function configs(): Record<string, ProviderConfigYaml> {
  return {
    codex: {
      enabled: true,
      cli_path: 'codex',
      default_model: 'gpt-test',
      max_concurrent: 1,
      timeout_ms: 1_000,
      extra_args: [],
    },
  };
}

describe('provider login lifecycle', () => {
  it('probes the initial checking status and shares the active probe', async () => {
    const probeChild = fakeChild();
    const spawnProcess = vi.fn(() => probeChild);
    const manager = new ProviderLoginManager(configs(), {
      spawnProcess,
      terminateProcess: vi.fn(async () => undefined),
    });

    const first = manager.getStatus('codex');
    const concurrent = manager.getStatus('codex');
    expect(spawnProcess).toHaveBeenCalledOnce();

    probeChild.emit('close', 0);
    await expect(first).resolves.toMatchObject({ state: 'authenticated' });
    await expect(concurrent).resolves.toMatchObject({ state: 'authenticated' });
  });

  it('does not treat a successful not-logged-in status command as authenticated', async () => {
    const probeChild = fakeChild();
    const manager = new ProviderLoginManager(configs(), {
      spawnProcess: vi.fn(() => probeChild),
      terminateProcess: vi.fn(async () => undefined),
    });

    const probe = manager.getStatus('codex');
    probeChild.stdout?.emit('data', Buffer.from('Not logged in\n'));
    probeChild.emit('close', 0);

    await expect(probe).resolves.toMatchObject({
      state: 'unauthenticated',
      authenticated: false,
    });
  });

  it('does not let a completed probe overwrite a newly started login', async () => {
    const probeChild = fakeChild();
    const loginChild = fakeChild();
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(probeChild)
      .mockReturnValueOnce(loginChild);
    const manager = new ProviderLoginManager(configs(), {
      spawnProcess,
      terminateProcess: vi.fn(async () => undefined),
    });

    const probe = manager.getStatus('codex', true);
    const waiting = manager.start('codex');
    probeChild.emit('close', 0);

    expect(waiting.state).toBe('waiting');
    await expect(probe).resolves.toMatchObject({
      state: 'waiting',
      message: 'Waiting for login instructions.',
    });
    await manager.stopAll();
  });

  it('does not let a stale probe overwrite a completed login', async () => {
    const probeChild = fakeChild();
    const loginChild = fakeChild();
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(probeChild)
      .mockReturnValueOnce(loginChild);
    const manager = new ProviderLoginManager(configs(), {
      spawnProcess,
      terminateProcess: vi.fn(async () => undefined),
    });

    const probe = manager.getStatus('codex', true);
    manager.start('codex');
    loginChild.emit('close', 0);
    probeChild.emit('close', 1);

    await expect(probe).resolves.toMatchObject({ state: 'authenticated' });
    await expect(manager.getStatus('codex')).resolves.toMatchObject({
      state: 'authenticated',
    });
  });

  it('waits for every active login process to terminate during shutdown', async () => {
    const loginChild = fakeChild();
    let releaseTermination: (() => void) | undefined;
    const termination = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminateProcess = vi.fn(() => termination);
    const manager = new ProviderLoginManager(configs(), {
      spawnProcess: vi.fn(() => loginChild),
      terminateProcess,
    });
    manager.start('codex');

    let stopped = false;
    const stopping = manager.stopAll().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    expect(terminateProcess).toHaveBeenCalledWith(loginChild);
    releaseTermination?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});
