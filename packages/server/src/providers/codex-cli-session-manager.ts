



const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export interface CliSession {
  threadId: string;
  model: string;
  lastUsedAt: number;
  ttlMs: number;
}

export class CodexCliSessionManager {
  private sessions = new Map<string, CliSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private defaultTtlMs: number;

  constructor(defaultTtlMs = DEFAULT_SESSION_TTL_MS) {
    this.defaultTtlMs = defaultTtlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }


  get(clientKey: string, model: string): CliSession | null {
    const session = this.sessions.get(clientKey);
    if (!session) return null;

    if (Date.now() - session.lastUsedAt > session.ttlMs) {
      this.sessions.delete(clientKey);
      return null;
    }

    if (session.model !== model) {
      this.sessions.delete(clientKey);
      return null;
    }

    session.lastUsedAt = Date.now();
    return session;
  }


  set(clientKey: string, threadId: string, model: string): void {
    this.sessions.set(clientKey, {
      threadId,
      model,
      lastUsedAt: Date.now(),
      ttlMs: this.defaultTtlMs,
    });
  }


  invalidate(clientKey: string): void {
    this.sessions.delete(clientKey);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsedAt > session.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
