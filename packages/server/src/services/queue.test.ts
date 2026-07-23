import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueManager } from './queue.js';

describe('QueueManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects work that exceeds its per-task timeout', async () => {
    vi.useFakeTimers();
    const manager = new QueueManager();
    manager.addQueue('codex', 1);

    const result = manager.enqueue(
      'codex',
      () => new Promise<string>((resolve) => {
        setTimeout(() => resolve('late'), 100);
      }),
      10,
    );
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(11);

    await assertion;
  });
});
