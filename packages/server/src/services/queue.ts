import PQueue from 'p-queue';


export interface QueueStatus {
  pending: number;
  size: number;
  concurrency: number;
  maxQueueSize: number;
  maxQueueWaitMs: number;
}

class ProviderQueueFullError extends Error {
  readonly code = 'provider_queue_full';
}

class ProviderQueueWaitError extends Error {
  readonly code = 'provider_queue_wait_timeout';
}

class ProviderQueueCancelledError extends Error {
  readonly code = 'request_cancelled';
}

interface ManagedQueue {
  queue: PQueue;
  maxQueueSize: number;
  maxQueueWaitMs: number;
}

interface EnqueueOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class QueueManager {
  private queues = new Map<string, ManagedQueue>();

  addQueue(
    provider: string,
    concurrency: number,
    maxQueueSize = 32,
    maxQueueWaitMs = 30_000,
  ): void {
    this.queues.set(provider, {
      queue: new PQueue({ concurrency }),
      maxQueueSize,
      maxQueueWaitMs,
    });
  }

  async enqueue<T>(
    provider: string,
    fn: () => Promise<T>,
    options: EnqueueOptions = {},
  ): Promise<T> {
    const managed = this.queues.get(provider);
    if (!managed) {

      return fn();
    }

    const { queue, maxQueueSize, maxQueueWaitMs } = managed;
    if (queue.size >= maxQueueSize) {
      throw new ProviderQueueFullError(
        `${provider} queue is full (${maxQueueSize} waiting requests).`,
      );
    }
    const waitLimit = Math.min(
      maxQueueWaitMs,
      options.timeoutMs ?? maxQueueWaitMs,
    );
    const controller = new AbortController();
    let started = false;
    let requestCancelled = false;
    const onRequestAbort = () => {
      if (started) return;
      requestCancelled = true;
      controller.abort();
    };
    options.signal?.addEventListener('abort', onRequestAbort, { once: true });
    if (options.signal?.aborted) onRequestAbort();
    const waitTimer = setTimeout(() => {
      if (!started) controller.abort();
    }, waitLimit);
    try {
      return await queue.add(async () => {
        started = true;
        clearTimeout(waitTimer);
        return fn();
      }, { signal: controller.signal }) as T;
    } catch (error) {
      if (controller.signal.aborted && !started) {
        if (requestCancelled) {
          throw new ProviderQueueCancelledError(
            `${provider} queue wait cancelled with the request.`,
          );
        }
        throw new ProviderQueueWaitError(
          `${provider} queue wait timed out after ${waitLimit}ms.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(waitTimer);
      options.signal?.removeEventListener('abort', onRequestAbort);
    }
  }

  getStatus(provider: string): QueueStatus | null {
    const managed = this.queues.get(provider);
    if (!managed) return null;
    const { queue, maxQueueSize, maxQueueWaitMs } = managed;

    return {
      pending: queue.pending,
      size: queue.size,
      concurrency: queue.concurrency,
      maxQueueSize,
      maxQueueWaitMs,
    };
  }


  removeQueue(provider: string): boolean {
    return this.queues.delete(provider);
  }


  updateConcurrency(provider: string, concurrency: number): boolean {
    const managed = this.queues.get(provider);
    if (!managed) return false;
    const { queue } = managed;
    queue.concurrency = concurrency;
    return true;
  }

  updateLimits(
    provider: string,
    maxQueueSize: number,
    maxQueueWaitMs: number,
  ): boolean {
    const managed = this.queues.get(provider);
    if (!managed) return false;
    managed.maxQueueSize = maxQueueSize;
    managed.maxQueueWaitMs = maxQueueWaitMs;
    return true;
  }

  getAllStatus(): Record<string, QueueStatus> {
    const result: Record<string, QueueStatus> = {};
    for (const [name, managed] of this.queues) {
      const { queue } = managed;
      result[name] = {
        pending: queue.pending,
        size: queue.size,
        concurrency: queue.concurrency,
        maxQueueSize: managed.maxQueueSize,
        maxQueueWaitMs: managed.maxQueueWaitMs,
      };
    }
    return result;
  }
}
