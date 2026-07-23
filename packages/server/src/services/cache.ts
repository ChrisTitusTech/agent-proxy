import { createHash } from 'node:crypto';
import { eq, asc, lte, count } from 'drizzle-orm';
import type { CacheConfig, ChatMessage } from '@agent-proxy/shared';
import { getDatabase } from '../db/client.js';
import { responseCache } from '../db/schema.js';


export interface CachedResponse {
  responseBody: string;
  tokenCount: number | null;
  provider: string;
  modelAlias: string;
}

export class ResponseCache {
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
  }


  generateHash(modelAlias: string, messages: ChatMessage[]): string {
    const payload = modelAlias + JSON.stringify(messages);
    return createHash('sha256').update(payload).digest('hex');
  }


  async get(requestHash: string): Promise<CachedResponse | null> {
    if (!this.config.enabled) return null;

    try {
      const db = getDatabase();
      const rows = await db
        .select()
        .from(responseCache)
        .where(eq(responseCache.requestHash, requestHash))
        .limit(1);

      if (rows.length === 0) return null;

      const row = rows[0];


      const now = new Date().toISOString();
      if (row.expiresAt <= now) {

        await db.delete(responseCache).where(eq(responseCache.requestHash, requestHash));
        return null;
      }

      return {
        responseBody: row.responseBody,
        tokenCount: row.tokenCount,
        provider: row.provider,
        modelAlias: row.modelAlias,
      };
    } catch (err) {

      console.error('Cache get failed:', err);
      return null;
    }
  }


  async set(
    requestHash: string,
    modelAlias: string,
    provider: string,
    responseBody: string,
    tokenCount?: number,
  ): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const db = getDatabase();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.config.ttlSeconds * 1000);


      await db.transaction(async (tx) => {

        const countResult = await tx.select({ value: count() }).from(responseCache);
        const currentCount = (countResult[0]?.value ?? 0) as number;

        if (currentCount >= this.config.maxEntries) {

          const deleteCount = currentCount - this.config.maxEntries + 1;
          const oldest = await tx
            .select({ requestHash: responseCache.requestHash })
            .from(responseCache)
            .orderBy(asc(responseCache.createdAt))
            .limit(deleteCount);

          for (const row of oldest) {
            await tx.delete(responseCache).where(eq(responseCache.requestHash, row.requestHash));
          }
        }


        await tx
          .insert(responseCache)
          .values({
            requestHash,
            modelAlias,
            provider,
            responseBody,
            tokenCount: tokenCount ?? null,
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
          })
          .onConflictDoUpdate({
            target: responseCache.requestHash,
            set: {
              responseBody,
              tokenCount: tokenCount ?? null,
              createdAt: now.toISOString(),
              expiresAt: expiresAt.toISOString(),
            },
          });
      });
    } catch (err) {

      console.error('Cache set failed:', err);
    }
  }


  async cleanup(): Promise<number> {
    try {
      const db = getDatabase();
      const now = new Date().toISOString();


      const expiredCount = await db
        .select({ value: count() })
        .from(responseCache)
        .where(lte(responseCache.expiresAt, now));

      const deletedCount = expiredCount[0]?.value ?? 0;


      if (deletedCount > 0) {
        await db.delete(responseCache).where(lte(responseCache.expiresAt, now));
      }

      return deletedCount;
    } catch (err) {
      console.error('Cache cleanup failed:', err);
      return 0;
    }
  }


  async getStats(): Promise<{ count: number; oldestAt: string | null }> {
    try {
      const db = getDatabase();

      const countResult = await db.select({ value: count() }).from(responseCache);
      const totalCount = countResult[0]?.value ?? 0;

      let oldestAt: string | null = null;
      if (totalCount > 0) {
        const oldest = await db
          .select({ createdAt: responseCache.createdAt })
          .from(responseCache)
          .orderBy(asc(responseCache.createdAt))
          .limit(1);
        oldestAt = oldest[0]?.createdAt ?? null;
      }

      return { count: totalCount, oldestAt };
    } catch (err) {
      console.error('Cache getStats failed:', err);
      return { count: 0, oldestAt: null };
    }
  }
}
