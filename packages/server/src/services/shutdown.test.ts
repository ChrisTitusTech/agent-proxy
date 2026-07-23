import { describe, expect, it, vi } from 'vitest';
import { shutdownServer } from './shutdown.js';

describe('shutdownServer', () => {
  it('drains before stopping providers and closing state', async () => {
    const calls: string[] = [];
    const result = await shutdownServer({
      stopAccepting: async () => { calls.push('drain'); },
      stopProviders: async () => { calls.push('providers'); },
      terminateChildren: async () => { calls.push('children'); },
      closeState: () => { calls.push('state'); },
      drainTimeoutMs: 100,
    });

    expect(result).toEqual({ drained: true });
    expect(calls).toEqual(['drain', 'providers', 'children', 'state']);
  });

  it('forces provider cleanup after the bounded drain timeout', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let finishClose: (() => void) | undefined;
    const closePromise = new Promise<void>((resolve) => { finishClose = resolve; });
    const shutdown = shutdownServer({
      stopAccepting: () => closePromise,
      stopProviders: async () => {
        calls.push('providers');
        finishClose?.();
      },
      terminateChildren: async () => { calls.push('children'); },
      closeState: () => { calls.push('state'); },
      drainTimeoutMs: 50,
      forceTimeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(shutdown).resolves.toEqual({ drained: false });
    expect(calls).toEqual(['providers', 'children', 'state']);
    vi.useRealTimers();
  });
});
