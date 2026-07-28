



export class KeyedMutex {

  private tails = new Map<string, Promise<void>>();



  async acquire(
    key: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);

    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error('Mutex wait cancelled.'));
        return;
      }
      if (options.signal) {
        abortListener = () => reject(new Error('Mutex wait cancelled.'));
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
      if (options.timeoutMs !== undefined) {
        waitTimer = setTimeout(
          () => reject(new Error('Mutex wait timed out.')),
          Math.max(0, options.timeoutMs),
        );
        waitTimer.unref();
      }
    });

    try {
      await Promise.race([prev, interrupted]);
    } catch (error) {
      releaseGate();
      if (this.tails.get(key) === tail) this.tails.delete(key);
      throw error;
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
      if (abortListener) options.signal?.removeEventListener('abort', abortListener);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();

      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    };
  }


  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
