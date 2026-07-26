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
