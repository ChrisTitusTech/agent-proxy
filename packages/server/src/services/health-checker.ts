import { eq, desc } from 'drizzle-orm';
import type { HealthStatus } from '@agent-proxy/shared';
import { getDatabase } from '../db/client.js';
import { providerHealth, requestLogs } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';


const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const RECENT_CHECK_COUNT = 3;
const ERROR_THRESHOLD = 2;

const MAX_CONSECUTIVE_FAILURES = 3;

export class HealthChecker {
  private registry: ProviderRegistry;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private lastCheckAt = new Map<string, number>();
  private static readonly MIN_CHECK_INTERVAL_MS = 5_000;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }


  start(intervalMs: number = 60_000): void {
    this.checkAll();
    this.intervalId = setInterval(() => this.checkAll(), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async checkAll(): Promise<void> {
    const providers = this.registry.getAll()
      .filter((p) => p.getConfig().enabled !== false);
    await Promise.allSettled(
      providers.map((p) => this.checkProvider(p.name)),
    );
  }

  async checkProvider(name: string): Promise<HealthStatus> {
    const provider = this.registry.get(name);
    if (!provider) return 'unknown';


    const now = Date.now();
    const lastCheck = this.lastCheckAt.get(name) ?? 0;
    if (now - lastCheck < HealthChecker.MIN_CHECK_INTERVAL_MS) {
      return this.getHealth(name);
    }
    this.lastCheckAt.set(name, now);


    const cliStatus = await provider.checkHealth();


    if (cliStatus === 'unhealthy') {
      await this.updateHealth(name, cliStatus);
      return cliStatus;
    }





    await this.updateHealth(name, 'healthy');
    return 'healthy';
  }


  async onRequestFailure(name: string): Promise<void> {
    const recentHealthy = await this.checkRecentRequests(name);
    if (!recentHealthy) {
      await this.updateHealth(name, 'unhealthy');
    }
  }




  private async checkRecentRequests(provider: string): Promise<boolean> {
    try {
      const db = getDatabase();


      const recentLogs = await db
        .select({
          status: requestLogs.status,
          createdAt: requestLogs.createdAt,
        })
        .from(requestLogs)
        .where(eq(requestLogs.provider, provider))
        .orderBy(desc(requestLogs.createdAt))
        .limit(RECENT_CHECK_COUNT);


      if (recentLogs.length === 0) {
        return true;
      }


      const lastSuccess = recentLogs.find((log) => log.status === 'success');
      const now = Date.now();

      if (lastSuccess) {
        const lastSuccessTime = new Date(lastSuccess.createdAt).getTime();
        const elapsed = now - lastSuccessTime;


        if (elapsed < STALE_THRESHOLD_MS) {
          return true;
        }
      }


      const errorCount = recentLogs.filter(
        (log) => log.status === 'error' || log.status === 'timeout',
      ).length;


      return errorCount < ERROR_THRESHOLD;
    } catch {

      return true;
    }
  }

  async getHealth(name: string): Promise<HealthStatus> {
    const db = getDatabase();
    const results = await db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.provider, name))
      .limit(1);

    return (results[0]?.status as HealthStatus) ?? 'unknown';
  }

  async isHealthy(name: string): Promise<boolean> {
    const status = await this.getHealth(name);

    return status !== 'unhealthy';
  }

  private async updateHealth(name: string, status: HealthStatus): Promise<void> {
    const db = getDatabase();
    const now = new Date().toISOString();

    const existing = await db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.provider, name))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(providerHealth).values({
        provider: name,
        status,
        lastCheckAt: now,
        lastSuccessAt: status === 'healthy' ? now : null,
        consecutiveFailures: status === 'healthy' ? 0 : 1,
      });
    } else {
      const prev = existing[0];
      const failures = status === 'healthy' ? 0 : (prev.consecutiveFailures + 1);
      const effectiveStatus = failures >= MAX_CONSECUTIVE_FAILURES ? 'unhealthy' : status;

      await db
        .update(providerHealth)
        .set({
          status: effectiveStatus,
          lastCheckAt: now,
          lastSuccessAt: status === 'healthy' ? now : prev.lastSuccessAt,
          consecutiveFailures: failures,
          errorMessage: status === 'unhealthy' ? `Health check failed` : null,
        })
        .where(eq(providerHealth.provider, name));
    }
  }
}
