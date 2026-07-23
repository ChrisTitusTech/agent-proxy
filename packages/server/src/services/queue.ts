import PQueue from 'p-queue';


export interface QueueStatus {
  pending: number;
  size: number;
  concurrency: number;
}

export class QueueManager {
  private queues = new Map<string, PQueue>();

  addQueue(provider: string, concurrency: number): void {
    this.queues.set(provider, new PQueue({ concurrency }));
  }

  async enqueue<T>(
    provider: string,
    fn: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const queue = this.queues.get(provider);
    if (!queue) {

      return fn();
    }

    return queue.add(fn, {
      timeout: timeoutMs,
    }) as Promise<T>;
  }

  getStatus(provider: string): QueueStatus | null {
    const queue = this.queues.get(provider);
    if (!queue) return null;

    return {
      pending: queue.pending,
      size: queue.size,
      concurrency: queue.concurrency,
    };
  }


  removeQueue(provider: string): boolean {
    return this.queues.delete(provider);
  }


  updateConcurrency(provider: string, concurrency: number): boolean {
    const queue = this.queues.get(provider);
    if (!queue) return false;
    queue.concurrency = concurrency;
    return true;
  }

  getAllStatus(): Record<string, QueueStatus> {
    const result: Record<string, QueueStatus> = {};
    for (const [name, queue] of this.queues) {
      result[name] = {
        pending: queue.pending,
        size: queue.size,
        concurrency: queue.concurrency,
      };
    }
    return result;
  }
}
