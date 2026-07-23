



export class KeyedMutex {

  private tails = new Map<string, Promise<void>>();



  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);

    await prev;

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
