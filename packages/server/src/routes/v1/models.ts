import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { ModelObject, ModelListResponse } from '@agent-proxy/shared';
import { getDatabase } from '../../db/client.js';
import { modelMappings } from '../../db/schema.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';

export interface ModelsDeps {
  registry: Pick<ProviderRegistry, 'has' | 'getProviderConfig'>;
}

function providerIsEnabled(registry: ModelsDeps['registry'], provider: string): boolean {
  return registry.has(provider) && registry.getProviderConfig(provider)?.enabled !== false;
}

export function registerModelsRoute(app: FastifyInstance, deps: ModelsDeps): void {

  app.get('/v1/models', async (_request, reply) => {
    const db = getDatabase();

    const mappings = await db
      .select()
      .from(modelMappings)
      .where(eq(modelMappings.enabled, true));

    const availableMappings = mappings.filter(
      (mapping) => providerIsEnabled(deps.registry, mapping.provider),
    );

    const uniqueAliases = new Map<string, typeof mappings[0]>();
    for (const m of availableMappings) {
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
      .where(and(
        eq(modelMappings.alias, id),
        eq(modelMappings.enabled, true),
      ));

    const m = results.find(
      (mapping) => providerIsEnabled(deps.registry, mapping.provider),
    );
    if (!m) {
      return reply.status(404).send({
        error: {
          message: `Model "${id}" not found.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      });
    }

    const model: ModelObject = {
      id: m.alias,
      object: 'model',
      created: Math.floor(new Date(m.createdAt).getTime() / 1000),
      owned_by: `agent-proxy-${m.provider}`,
    };

    return reply.send(model);
  });
}
