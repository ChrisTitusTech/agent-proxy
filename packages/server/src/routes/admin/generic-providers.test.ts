import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderExecutionBackend } from '../../herdr/launcher.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { QueueManager } from '../../services/queue.js';
import { registerGenericProviderRoutes } from './generic-providers.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('generic provider admin validation', () => {
  it('checks executable readiness without starting a Herdr agent', async () => {
    const start = vi.fn();
    const executionBackend = {
      start,
      readiness: async () => ({ ready: true }),
      shutdown: async () => undefined,
    } satisfies ProviderExecutionBackend;
    const app = Fastify();
    apps.push(app);
    registerGenericProviderRoutes(app, {
      registry: {
        executionBackend,
        proxyPort: 8300,
      } as unknown as ProviderRegistry,
      healthChecker: {} as HealthChecker,
      queueManager: {} as QueueManager,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/generic-providers/test',
      payload: {
        name: 'fixture',
        cli_path: process.execPath,
        default_model: 'test',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      response: 'Executable is available for the logged-in user.',
    });
    expect(start).not.toHaveBeenCalled();
  });
});
