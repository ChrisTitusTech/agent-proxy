import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ModelObject, ModelListResponse } from '@agent-proxy/shared';
import { getDatabase } from '../../db/client.js';
import { modelMappings } from '../../db/schema.js';

export function registerModelsRoute(app: FastifyInstance): void {

  app.get('/v1/models', async (_request, reply) => {
    const db = getDatabase();

    const mappings = await db
      .select()
      .from(modelMappings)
      .where(eq(modelMappings.enabled, true));


    const uniqueAliases = new Map<string, typeof mappings[0]>();
    for (const m of mappings) {
      if (!uniqueAliases.has(m.alias)) {
        uniqueAliases.set(m.alias, m);
      }
    }

    const models: ModelObject[] = Array.from(uniqueAliases.values()).map((m) => ({
      id: m.alias,
      object: 'model' as const,
      created: Math.floor(new Date(m.createdAt).getTime() / 1000),
      owned_by: `agent-proxy-${m.provider}`,
    }));

    const response: ModelListResponse = {
      object: 'list',
      data: models,
    };

    return reply.send(response);
  });


  app.get<{ Params: { id: string } }>('/v1/models/:id', async (request, reply) => {
    const db = getDatabase();
    const { id } = request.params;

    const results = await db
      .select()
      .from(modelMappings)
      .where(eq(modelMappings.alias, id))
      .limit(1);

    if (results.length === 0) {
      return reply.status(404).send({
        error: {
          message: `Model "${id}" not found.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      });
    }

    const m = results[0];
    const model: ModelObject = {
      id: m.alias,
      object: 'model',
      created: Math.floor(new Date(m.createdAt).getTime() / 1000),
      owned_by: `agent-proxy-${m.provider}`,
    };

    return reply.send(model);
  });
}
