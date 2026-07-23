import { describe, expect, it, vi } from 'vitest';
import type { BaseProvider } from './base-provider.js';
import { ProviderRegistry } from './provider-registry.js';

function provider(name: string, shutdown: () => Promise<void>): BaseProvider {
  return { name, shutdown } as unknown as BaseProvider;
}

describe('ProviderRegistry shutdown', () => {
  it('waits for every provider and reports failures with provider identity', async () => {
    const registry = new ProviderRegistry();
    let finishSuccessfulShutdown: () => void = () => {};
    const deferredShutdown = new Promise<void>((resolve) => {
      finishSuccessfulShutdown = resolve;
    });
    const successfulShutdown = vi.fn(() => deferredShutdown);
    const failedShutdown = vi.fn().mockRejectedValue(new Error('stop failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      registry.register(provider('healthy', successfulShutdown));
      registry.register(provider('broken', failedShutdown));

      let completed = false;
      const shutdown = registry.shutdownAll().then(() => {
        completed = true;
      });
      await Promise.resolve();

      expect(successfulShutdown).toHaveBeenCalledOnce();
      expect(failedShutdown).toHaveBeenCalledOnce();
      expect(completed).toBe(false);

      finishSuccessfulShutdown();
      await expect(shutdown).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        '[broken] provider shutdown failed:',
        expect.objectContaining({ message: 'stop failed' }),
      );
    } finally {
      error.mockRestore();
    }
  });
});
