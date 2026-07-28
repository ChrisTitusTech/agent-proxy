import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueManager } from './queue.js';

describe('QueueManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects work that exceeds its queue wait limit', async () => {
    vi.useFakeTimers();
    const manager = new QueueManager();
    manager.addQueue('codex', 1, 2, 10);
    let release!: () => void;
    const blocker = manager.enqueue(
      'codex',
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const result = manager.enqueue(
      'codex',
      async () => 'late',
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: 'provider_queue_wait_timeout',
    });

    await vi.advanceTimersByTimeAsync(11);
    await rejection;

    release();
    await blocker;
  });
});
