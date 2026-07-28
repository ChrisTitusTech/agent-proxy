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

  it('removes queued work immediately when its request is cancelled', async () => {
    const manager = new QueueManager();
    manager.addQueue('codex', 1, 2, 30_000);
    let release!: () => void;
    const blocker = manager.enqueue(
      'codex',
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const controller = new AbortController();
    const queued = manager.enqueue(
      'codex',
      async () => 'late',
      { signal: controller.signal },
    );

    expect(manager.getStatus('codex')?.size).toBe(1);
    controller.abort();
    await expect(queued).rejects.toMatchObject({
      code: 'request_cancelled',
    });
    expect(manager.getStatus('codex')?.size).toBe(0);

    release();
    await blocker;
  });

  it('allows active work while a zero-capacity queue rejects waiting work', async () => {
    const manager = new QueueManager();
    manager.addQueue('codex', 1, 0, 30_000);
    let release!: () => void;
    const active = manager.enqueue(
      'codex',
      () => new Promise<string>((resolve) => {
        release = () => resolve('active');
      }),
    );

    await vi.waitFor(() => {
      expect(manager.getStatus('codex')?.pending).toBe(1);
    });
    await expect(manager.enqueue(
      'codex',
      async () => 'queued',
    )).rejects.toMatchObject({
      code: 'provider_queue_full',
    });

    release();
    await expect(active).resolves.toBe('active');
  });
});
