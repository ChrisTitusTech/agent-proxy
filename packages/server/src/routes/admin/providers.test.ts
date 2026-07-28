import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { ProviderConfigYaml } from '@agent-proxy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseProvider } from '../../providers/base-provider.js';
import { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import { QueueManager } from '../../services/queue.js';
import { closeDatabase, getDatabase, initDatabase } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import {
  loadEffectiveProviderConfigs,
  mergeProviderConfigPartials,
  registerProvidersRoutes,
  validateRuntimeProviderConfig,
} from './providers.js';

let testDirectory: string;

beforeEach(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), 'agent-proxy-provider-config-'));
  await initDatabase(join(testDirectory, 'agent-proxy.db'));
});

afterEach(() => {
  closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
});

describe('loadEffectiveProviderConfigs', () => {
  it('applies persisted enablement and nested runtime options', async () => {
    const defaultConfig: ProviderConfigYaml = {
      enabled: false,
      cli_path: 'codex',
      default_model: 'gpt-5.6-sol',
      max_concurrent: 1,
      timeout_ms: 30_000,
      extra_args: [],
      cli_options: {
        ephemeral: true,
        enable_session_reuse: false,
      },
    };
    await getDatabase().insert(settings).values({
      key: 'provider_config:codex',
      value: JSON.stringify({
        enabled: true,
        cli_options: { enable_session_reuse: true },
      }),
    });

    const configs = await loadEffectiveProviderConfigs({ codex: defaultConfig });

    expect(configs.codex.enabled).toBe(true);
    expect(configs.codex.cli_options).toEqual({
      ephemeral: true,
      enable_session_reuse: true,
    });
  });

  it('applies queue limit updates without a restart', async () => {
    const app = Fastify();
    const providerConfig: ProviderConfigYaml = {
      enabled: true,
      cli_path: 'codex',
      default_model: 'gpt-5.6-sol',
      max_concurrent: 1,
      max_queue_size: 2,
      max_queue_wait_ms: 100,
      timeout_ms: 30_000,
      extra_args: [],
    };
    const provider = {
      name: 'codex',
      getConfig: () => ({ ...providerConfig }),
      updateConfig: (partial: Partial<ProviderConfigYaml>) => {
        Object.assign(providerConfig, partial);
      },
    } as unknown as BaseProvider;
    const registry = new ProviderRegistry();
    registry.register(provider);
    const queueManager = new QueueManager();
    queueManager.addQueue('codex', 1, 2, 100);
    registerProvidersRoutes(app, {
      registry,
      queueManager,
      healthChecker: {
        checkProvider: async () => 'healthy',
      } as unknown as HealthChecker,
      defaultConfigs: { codex: providerConfig },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/admin/providers/codex',
      payload: {
        max_queue_size: 7,
        max_queue_wait_ms: 250,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queueManager.getStatus('codex')).toMatchObject({
      maxQueueSize: 7,
      maxQueueWaitMs: 250,
    });
    await app.close();
  });

  it('tests built-in readiness without starting provider execution', async () => {
    const app = Fastify();
    const execute = vi.fn();
    const provider = {
      name: 'codex',
      getConfig: () => ({
        enabled: true,
        cli_path: process.execPath,
        default_model: 'gpt-test',
        max_concurrent: 1,
        timeout_ms: 30_000,
        extra_args: [],
      }),
      checkHealth: vi.fn().mockResolvedValue('healthy'),
      execute,
    } as unknown as BaseProvider;
    const registry = new ProviderRegistry();
    registry.register(provider);
    registerProvidersRoutes(app, {
      registry,
      queueManager: new QueueManager(),
      healthChecker: {} as HealthChecker,
      defaultConfigs: {},
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/providers/codex/test',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      response: 'Executable is available for the logged-in user.',
    });
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it('discards invalid persisted overrides and rejects invalid writes', async () => {
    const defaultConfig: ProviderConfigYaml = {
      enabled: false,
      cli_path: 'codex',
      default_model: 'gpt-5.6-sol',
      max_concurrent: 1,
      timeout_ms: 30_000,
      extra_args: [],
    };
    await getDatabase().insert(settings).values({
      key: 'provider_config:codex',
      value: JSON.stringify({ enabled: 'yes', max_concurrent: -1 }),
    });

    const configs = await loadEffectiveProviderConfigs({ codex: defaultConfig });

    expect(configs.codex).toEqual(defaultConfig);
    expect(() => validateRuntimeProviderConfig(
      'codex',
      { enabled: 'yes' },
      true,
    )).toThrow(/Invalid provider configuration/);
  });

  it('rejects unknown nested fields and preserves nested siblings', () => {
    expect(() => validateRuntimeProviderConfig(
      'codex',
      { cli_options: { ephemeral: false, unknown_option: true } },
      true,
    )).toThrow(/Invalid provider configuration/);

    expect(mergeProviderConfigPartials(
      { cli_options: { ephemeral: true, session_ttl_ms: 30_000 } },
      { cli_options: { enable_session_reuse: true } },
    )).toEqual({
      cli_options: {
        ephemeral: true,
        enable_session_reuse: true,
        session_ttl_ms: 30_000,
      },
    });
  });
});
