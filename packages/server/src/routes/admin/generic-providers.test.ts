import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderExecutionBackend } from '../../herdr/launcher.js';
import { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import { QueueManager } from '../../services/queue.js';
import { closeDatabase, initDatabase } from '../../db/client.js';
import { registerGenericProviderRoutes } from './generic-providers.js';

const apps: ReturnType<typeof Fastify>[] = [];
let testDirectory: string;

beforeEach(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), 'agent-proxy-generic-provider-'));
  await initDatabase(join(testDirectory, 'agent-proxy.db'));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
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

  it('preserves queue limits when creating and updating a provider', async () => {
    const app = Fastify();
    apps.push(app);
    const registry = new ProviderRegistry();
    const queueManager = new QueueManager();
    registerGenericProviderRoutes(app, {
      registry,
      queueManager,
      healthChecker: {
        checkProvider: async () => 'healthy',
      } as unknown as HealthChecker,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/admin/generic-providers',
      payload: {
        name: 'fixture-provider',
        cli_path: process.execPath,
        default_model: 'test',
        max_concurrent: 1,
        max_queue_size: 3,
        max_queue_wait_ms: 125,
        args_template: [],
        prompt_mode: 'stdin',
        output_mode: 'plain_text',
        streaming_enabled: false,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(queueManager.getStatus('fixture-provider')).toMatchObject({
      maxQueueSize: 3,
      maxQueueWaitMs: 125,
    });

    const updated = await app.inject({
      method: 'PUT',
      url: '/admin/generic-providers/fixture-provider',
      payload: {
        max_queue_size: 5,
        max_queue_wait_ms: 250,
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(queueManager.getStatus('fixture-provider')).toMatchObject({
      maxQueueSize: 5,
      maxQueueWaitMs: 250,
    });
  });
});
