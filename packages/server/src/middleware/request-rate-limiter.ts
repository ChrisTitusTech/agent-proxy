interface WindowEntry {
  count: number;
  resetAt: number;
}

export interface RequestRateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class RequestRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxTrackedClients = 10_000,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('limit must be a positive integer');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be positive');
    }
    if (!Number.isSafeInteger(maxTrackedClients) || maxTrackedClients < 1) {
      throw new RangeError('maxTrackedClients must be a positive integer');
    }
  }

  consume(clientId: string, now = Date.now()): RequestRateLimitResult {
    const existing = this.entries.get(clientId);
    if (!existing || now >= existing.resetAt) {
      this.prune(now);
      this.entries.set(clientId, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }

    if (existing.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1_000)),
      };
    }

    existing.count += 1;
    return { allowed: true };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }

    while (this.entries.size >= this.maxTrackedClients) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
