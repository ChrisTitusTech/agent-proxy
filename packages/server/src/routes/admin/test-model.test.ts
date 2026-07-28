import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseProvider } from '../../providers/base-provider.js';
import { ProviderRegistry } from '../../providers/provider-registry.js';
import { registerTestModelRoute } from './test-model.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin model test', () => {
  it('checks built-in readiness without starting provider execution', async () => {
    const app = Fastify();
    apps.push(app);
    const execute = vi.fn();
    const registry = new ProviderRegistry();
    registry.register({
      name: 'codex',
      checkHealth: vi.fn().mockResolvedValue('healthy'),
      execute,
    } as unknown as BaseProvider);
    registerTestModelRoute(app, registry);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/test-model',
      payload: {
        provider: 'codex',
        actual_model: 'gpt-test',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      response: 'Executable is available for the logged-in user.',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
