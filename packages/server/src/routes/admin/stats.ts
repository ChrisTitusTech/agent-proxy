import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { requestLogs } from '../../db/schema.js';

export function registerStatsRoutes(app: FastifyInstance): void {

  app.get('/admin/stats', async (_request, reply) => {
    const db = getDatabase();

    const totalResult = await db.select({
      totalRequests: sql<number>`count(*)`,
      successCount: sql<number>`sum(case when status = 'success' then 1 else 0 end)`,
      errorCount: sql<number>`sum(case when status = 'error' then 1 else 0 end)`,
      avgLatencyMs: sql<number>`avg(latency_ms)`,
      totalPromptTokens: sql<number>`sum(prompt_tokens)`,
      totalCompletionTokens: sql<number>`sum(completion_tokens)`,
    }).from(requestLogs);

    const stats = totalResult[0] ?? {
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      avgLatencyMs: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    };


    const providerStats = await db.select({
      provider: requestLogs.provider,
      count: sql<number>`count(*)`,
      successCount: sql<number>`sum(case when status = 'success' then 1 else 0 end)`,
      avgLatencyMs: sql<number>`avg(latency_ms)`,
    }).from(requestLogs)
      .groupBy(requestLogs.provider);


    const modelStats = await db.select({
      modelAlias: requestLogs.modelAlias,
      provider: requestLogs.provider,
      count: sql<number>`count(*)`,
    }).from(requestLogs)
      .groupBy(requestLogs.modelAlias, requestLogs.provider);

    return reply.send({
      overview: {
        totalRequests: stats.totalRequests ?? 0,
        successRate: stats.totalRequests
          ? ((stats.successCount ?? 0) / stats.totalRequests * 100).toFixed(1)
          : '0.0',
        avgLatencyMs: Math.round(stats.avgLatencyMs ?? 0),
        totalTokens: (stats.totalPromptTokens ?? 0) + (stats.totalCompletionTokens ?? 0),
      },
      byProvider: providerStats,
      byModel: modelStats,
    });
  });


  app.get<{ Querystring: { hours?: string } }>(
    '/admin/trend',
    async (request, reply) => {
      const db = getDatabase();
      const hours = Math.min(parseInt(request.query.hours ?? '24', 10), 168);


      const trend = await db.select({
        slot: sql<string>`strftime('%Y-%m-%d %H', created_at)`,
        count: sql<number>`count(*)`,
        successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
        errorCount: sql<number>`coalesce(sum(case when status != 'success' then 1 else 0 end), 0)`,
        tokens: sql<number>`coalesce(sum(total_tokens), 0)`,
      }).from(requestLogs)
        .where(sql`created_at >= datetime('now', ${`-${hours} hours`})`)
        .groupBy(sql`strftime('%Y-%m-%d %H', created_at)`)
        .orderBy(sql`strftime('%Y-%m-%d %H', created_at) ASC`);


      const byModel = await db.select({
        slot: sql<string>`strftime('%Y-%m-%d %H', created_at)`,
        modelAlias: requestLogs.modelAlias,
        count: sql<number>`count(*)`,
      }).from(requestLogs)
        .where(sql`created_at >= datetime('now', ${`-${hours} hours`})`)
        .groupBy(sql`strftime('%Y-%m-%d %H', created_at)`, requestLogs.modelAlias)
        .orderBy(sql`strftime('%Y-%m-%d %H', created_at) ASC`);

      return reply.send({ hours, trend, byModel });
    },
  );


  app.get<{ Querystring: { limit?: string; offset?: string; provider?: string; status?: string } }>(
    '/admin/logs',
    async (request, reply) => {
      const db = getDatabase();
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
      const offset = parseInt(request.query.offset ?? '0', 10);


      const [countResult, logs] = await Promise.all([
        db.select({
          total: sql<number>`count(*)`,
        }).from(requestLogs),
        db.select({
          id: requestLogs.id,
          requestId: requestLogs.requestId,
          modelAlias: requestLogs.modelAlias,
          provider: requestLogs.provider,
          actualModel: requestLogs.actualModel,
          reasoningEffort: requestLogs.reasoningEffort,
          status: requestLogs.status,
          latencyMs: requestLogs.latencyMs,
          ttfbMs: requestLogs.ttfbMs,
          isStream: requestLogs.isStream,
          totalTokens: requestLogs.totalTokens,
          errorMessage: requestLogs.errorMessage,
          createdAt: requestLogs.createdAt,
        }).from(requestLogs)
          .orderBy(sql`created_at DESC`)
          .limit(limit)
          .offset(offset),
      ]);

      const total = countResult[0]?.total ?? 0;

      return reply.send({
        data: logs,
        pagination: { limit, offset, total },
      });
    },
  );


  app.delete<{ Querystring: { days?: string } }>(
    '/admin/logs',
    async (request, reply) => {
      const db = getDatabase();
      const days = parseInt(request.query.days ?? '30', 10);

      if (days < 1) {
        return reply.status(400).send({ error: { message: 'days must be at least 1' } });
      }

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const result = await db.delete(requestLogs)
        .where(sql`created_at < ${cutoff}`);

      return reply.send({
        deleted: result.rowsAffected,
        cutoffDate: cutoff,
        days,
      });
    },
  );
}
