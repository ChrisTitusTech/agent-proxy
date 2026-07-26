import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase, initDatabase } from '../../db/client.js';
import { modelMappings } from '../../db/schema.js';
import { registerModelsRoute } from './models.js';

let app: FastifyInstance;
let testDirectory: string;

beforeEach(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), 'agent-proxy-models-'));
  await initDatabase(join(testDirectory, 'agent-proxy.db'));
  await getDatabase().insert(modelMappings).values([
    {
      id: 'mapping-codex',
      alias: 'gpt-5.6-sol',
      provider: 'codex',
      actualModel: 'gpt-5.6-sol',
      enabled: true,
      priority: 0,
    },
    {
      id: 'mapping-grok',
      alias: 'grok-build',
      provider: 'grok',
      actualModel: 'grok-4.5',
      enabled: true,
      priority: 0,
    },
  ]);

  app = Fastify();
  registerModelsRoute(app, {
    registry: {
      has: (provider) => provider === 'codex',
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
});

describe('models route', () => {
  it('lists only aliases backed by enabled providers', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/models' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((model: { id: string }) => model.id)).toEqual([
      'gpt-5.6-sol',
    ]);
  });

  it('returns model details only when an enabled provider can serve the alias', async () => {
    const available = await app.inject({ method: 'GET', url: '/v1/models/gpt-5.6-sol' });
    const unavailable = await app.inject({ method: 'GET', url: '/v1/models/grok-build' });

    expect(available.statusCode).toBe(200);
    expect(available.json()).toMatchObject({ id: 'gpt-5.6-sol' });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json().error.code).toBe('model_not_found');
  });
});
