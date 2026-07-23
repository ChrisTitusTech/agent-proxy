import { eq, like } from 'drizzle-orm';
import type { RateLimitConfig } from '@agent-proxy/shared';
import { getDatabase } from '../db/client.js';
import { settings } from '../db/schema.js';

const RATE_LIMIT_PREFIX = 'rate_limit:';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}


export class RateLimiter {
  private minuteCounters = new Map<string, RateLimitEntry>();
  private dayCounters = new Map<string, RateLimitEntry>();
  private config: RateLimitConfig;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: RateLimitConfig) {
    this.config = config;

    this.loadFromDb().catch((err) => {

      console.warn('[rate-limiter] loadFromDb failed:', err);
    });
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  updateConfig(config: RateLimitConfig) {
    this.config = config;
  }

  async destroy() {
    clearInterval(this.cleanupTimer);

    await this.flushToDb();
  }




  checkAndIncrement(
    apiKeyId: string,
    provider: string,
    keyLimits?: { rpm?: number | null; rpd?: number | null },
  ): { allowed: boolean; retryAfterSeconds?: number } {
    const gk = this.checkGlobalAndKey(apiKeyId, keyLimits);
    if (!gk.allowed) return gk;

    const prov = this.checkProvider(provider);
    if (!prov.allowed) {

      this.rollbackGlobalAndKey(apiKeyId, keyLimits);
      return prov;
    }

    return { allowed: true };
  }



  checkGlobalAndKey(
    apiKeyId: string,
    keyLimits?: { rpm?: number | null; rpd?: number | null },
  ): { allowed: boolean; retryAfterSeconds?: number } {
    const now = Date.now();


    const globalRpm = this.tryIncrement('global:rpm', this.config.global.rpm, now, 60_000, this.minuteCounters);
    if (!globalRpm.allowed) return globalRpm;


    const globalRpd = this.tryIncrement('global:rpd', this.config.global.rpd, now, 86_400_000, this.dayCounters);
    if (!globalRpd.allowed) {
      this.rollback('global:rpm', this.minuteCounters);
      return globalRpd;
    }


    if (keyLimits?.rpm) {
      const keyRpm = this.tryIncrement(`key:${apiKeyId}:rpm`, keyLimits.rpm, now, 60_000, this.minuteCounters);
      if (!keyRpm.allowed) {
        this.rollback('global:rpm', this.minuteCounters);
        this.rollback('global:rpd', this.dayCounters);
        return keyRpm;
      }
    }


    if (keyLimits?.rpd) {
      const keyRpd = this.tryIncrement(`key:${apiKeyId}:rpd`, keyLimits.rpd, now, 86_400_000, this.dayCounters);
      if (!keyRpd.allowed) {
        this.rollback('global:rpm', this.minuteCounters);
        this.rollback('global:rpd', this.dayCounters);
        if (keyLimits.rpm) this.rollback(`key:${apiKeyId}:rpm`, this.minuteCounters);
        return keyRpd;
      }
    }

    return { allowed: true };
  }



  checkProvider(provider: string): { allowed: boolean; retryAfterSeconds?: number } {
    const providerLimit = this.config.perProvider[provider]?.rpm;
    if (!providerLimit) return { allowed: true };
    const now = Date.now();
    return this.tryIncrement(`provider:${provider}:rpm`, providerLimit, now, 60_000, this.minuteCounters);
  }


  private rollbackGlobalAndKey(
    apiKeyId: string,
    keyLimits?: { rpm?: number | null; rpd?: number | null },
  ): void {
    this.rollback('global:rpm', this.minuteCounters);
    this.rollback('global:rpd', this.dayCounters);
    if (keyLimits?.rpm) this.rollback(`key:${apiKeyId}:rpm`, this.minuteCounters);
    if (keyLimits?.rpd) this.rollback(`key:${apiKeyId}:rpd`, this.dayCounters);
  }


  private tryIncrement(
    key: string,
    limit: number,
    now: number,
    windowMs: number,
    counters: Map<string, RateLimitEntry>,
  ): { allowed: boolean; retryAfterSeconds?: number } {
    const entry = counters.get(key);

    if (!entry || now >= entry.resetAt) {
      counters.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }

    if (entry.count >= limit) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfterSeconds };
    }

    entry.count++;
    return { allowed: true };
  }


  private rollback(key: string, counters: Map<string, RateLimitEntry>): void {
    const entry = counters.get(key);
    if (entry && entry.count > 0) {
      entry.count--;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.minuteCounters) {
      if (now >= entry.resetAt) this.minuteCounters.delete(key);
    }
    for (const [key, entry] of this.dayCounters) {
      if (now >= entry.resetAt) this.dayCounters.delete(key);
    }

    this.flushToDb().catch((err) => {

      console.warn('[rate-limiter] flushToDb failed:', err);
    });
  }


  private async loadFromDb(): Promise<void> {
    try {
      const db = getDatabase();
      const rows = await db
        .select()
        .from(settings)
        .where(like(settings.key, `${RATE_LIMIT_PREFIX}%`));

      const now = Date.now();
      for (const row of rows) {
        const counterKey = row.key.slice(RATE_LIMIT_PREFIX.length);
        try {
          const data = JSON.parse(row.value) as RateLimitEntry;

          if (data.resetAt > now) {


            const remainingMs = data.resetAt - now;
            if (remainingMs > 120_000) {
              this.dayCounters.set(counterKey, data);
            } else {
              this.minuteCounters.set(counterKey, data);
            }
          }
        } catch {

        }
      }
    } catch {

    }
  }


  private async flushToDb(): Promise<void> {
    try {
      const db = getDatabase();
      const now = Date.now();
      const nowIso = new Date().toISOString();


      const entries = new Map<string, RateLimitEntry>();
      for (const [key, entry] of this.minuteCounters) {
        if (now < entry.resetAt) entries.set(key, entry);
      }
      for (const [key, entry] of this.dayCounters) {
        if (now < entry.resetAt) entries.set(key, entry);
      }


      const existingRows = await db
        .select({ key: settings.key })
        .from(settings)
        .where(like(settings.key, `${RATE_LIMIT_PREFIX}%`));

      const existingKeys = new Set(existingRows.map((r) => r.key));


      for (const [key, entry] of entries) {
        const dbKey = `${RATE_LIMIT_PREFIX}${key}`;
        const value = JSON.stringify(entry);

        if (existingKeys.has(dbKey)) {
          await db
            .update(settings)
            .set({ value, updatedAt: nowIso })
            .where(eq(settings.key, dbKey));
          existingKeys.delete(dbKey);
        } else {
          await db.insert(settings).values({
            key: dbKey,
            value,
            updatedAt: nowIso,
          });
        }
      }


      for (const staleKey of existingKeys) {
        await db.delete(settings).where(eq(settings.key, staleKey));
      }
    } catch {

    }
  }
}
