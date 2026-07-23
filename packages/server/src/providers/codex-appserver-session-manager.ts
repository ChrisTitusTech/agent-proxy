


const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export interface AppServerThread {
  threadId: string;
  model: string;
  lastUsedAt: number;
  ttlMs: number;
}

export class CodexAppServerSessionManager {
  private threads = new Map<string, AppServerThread>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private defaultTtlMs: number;

  constructor(defaultTtlMs = DEFAULT_SESSION_TTL_MS) {
    this.defaultTtlMs = defaultTtlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }



  get(clientKey: string, model: string): AppServerThread | null {
    const thread = this.threads.get(clientKey);
    if (!thread) return null;


    if (Date.now() - thread.lastUsedAt > thread.ttlMs) {
      this.threads.delete(clientKey);
      return null;
    }


    if (thread.model !== model) {
      this.threads.delete(clientKey);
      return null;
    }


    thread.lastUsedAt = Date.now();
    return thread;
  }


  set(clientKey: string, threadId: string, model: string): void {
    this.threads.set(clientKey, {
      threadId,
      model,
      lastUsedAt: Date.now(),
      ttlMs: this.defaultTtlMs,
    });
  }


  invalidate(clientKey: string): void {
    this.threads.delete(clientKey);
  }


  private cleanup(): void {
    const now = Date.now();
    for (const [key, thread] of this.threads) {
      if (now - thread.lastUsedAt > thread.ttlMs) {
        this.threads.delete(key);
      }
    }
  }


  get size(): number {
    return this.threads.size;
  }


  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.threads.clear();
  }
}
