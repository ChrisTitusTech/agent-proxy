import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ProviderConfigYaml } from '@agent-proxy/shared';
import { getDatabase } from '../../db/client.js';
import { providerHealth, settings } from '../../db/schema.js';

import type { HealthChecker } from '../../services/health-checker.js';
import type { QueueManager } from '../../services/queue.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import { readCodexCliDefaults } from '../../providers/codex-toml-defaults.js';
import { providerSchema } from '../../config/schema.js';

interface ProviderDeps {
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  queueManager: QueueManager;
  defaultConfigs: Record<string, ProviderConfigYaml>;
}


const PROVIDER_CONFIG_PREFIX = 'provider_config:';
const BUILTIN_PROVIDER_NAMES = new Set(['claude', 'codex', 'agy', 'grok']);
const BUILTIN_RUNTIME_MUTABLE_FIELDS = new Set([
  'enabled',
  'default_model',
  'max_concurrent',
  'max_queue_size',
  'max_queue_wait_ms',
  'timeout_ms',
  'cli_options',
]);

export function sanitizeRuntimeProviderConfig(
  name: string,
  partial: Partial<ProviderConfigYaml>,
  strict = false,
): Partial<ProviderConfigYaml> {
  if (!BUILTIN_PROVIDER_NAMES.has(name)) {
    return partial;
  }

  const sanitized: Partial<ProviderConfigYaml> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(partial)) {
    if (BUILTIN_RUNTIME_MUTABLE_FIELDS.has(key)) {
      (sanitized as Record<string, unknown>)[key] = value;
    } else {
      rejected.push(key);
    }
  }

  if (strict && rejected.length > 0) {
    throw new Error(
      `Built-in provider "${name}" only supports runtime updates for: ${Array.from(BUILTIN_RUNTIME_MUTABLE_FIELDS).join(', ')}.`,
    );
  }

  return sanitized;
}

export function validateRuntimeProviderConfig(
  name: string,
  value: unknown,
  strict = false,
): Partial<ProviderConfigYaml> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) {
      throw new Error(`Invalid provider configuration for "${name}": expected an object.`);
    }
    return {};
  }

  const sanitized = sanitizeRuntimeProviderConfig(
    name,
    value as Partial<ProviderConfigYaml>,
    strict,
  );
  const parsed = providerSchema.safeParse(sanitized);
  if (!parsed.success) {
    if (strict) {
      throw new Error(`Invalid provider configuration for "${name}": ${parsed.error.message}`);
    }
    return {};
  }
  return parsed.data as Partial<ProviderConfigYaml>;
}


async function loadProviderConfigFromDb(
  name: string,
): Promise<Partial<ProviderConfigYaml> | null> {
  const db = getDatabase();
  const key = `${PROVIDER_CONFIG_PREFIX}${name}`;
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (rows.length === 0) return null;
  try {
    return validateRuntimeProviderConfig(name, JSON.parse(rows[0].value));
  } catch {
    return null;
  }
}

export async function loadEffectiveProviderConfigs(
  defaultConfigs: Record<string, ProviderConfigYaml>,
): Promise<Record<string, ProviderConfigYaml>> {
  const effectiveConfigs: Record<string, ProviderConfigYaml> = {};

  for (const [name, defaultConfig] of Object.entries(defaultConfigs)) {
    const override = await loadProviderConfigFromDb(name);
    const sanitizedOverride = override ?? {};
    effectiveConfigs[name] = mergeProviderConfigPartials(
      defaultConfig,
      sanitizedOverride,
    ) as ProviderConfigYaml;
  }

  return effectiveConfigs;
}

export function mergeProviderConfigPartials(
  current: Partial<ProviderConfigYaml>,
  partial: Partial<ProviderConfigYaml>,
): Partial<ProviderConfigYaml> {
  return {
    ...current,
    ...partial,
    cli_options: partial.cli_options
      ? { ...current.cli_options, ...partial.cli_options }
      : current.cli_options,
  };
}


async function saveProviderConfigToDb(
  name: string,
  config: Partial<ProviderConfigYaml>,
): Promise<void> {
  const db = getDatabase();
  const key = `${PROVIDER_CONFIG_PREFIX}${name}`;
  const now = new Date().toISOString();
  const value = JSON.stringify(config);

  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(settings).values({ key, value, updatedAt: now });
  } else {
    await db
      .update(settings)
      .set({ value, updatedAt: now })
      .where(eq(settings.key, key));
  }
}

export function registerProvidersRoutes(app: FastifyInstance, deps: ProviderDeps): void {

  app.get('/admin/providers', async (_request, reply) => {
    const db = getDatabase();
    const healthData = await db.select().from(providerHealth);
    const healthMap = new Map(healthData.map((h) => [h.provider, h]));

    const providers = deps.registry.getAll().map((p) => {
      const health = healthMap.get(p.name);
      const queueStatus = deps.queueManager.getStatus(p.name);

      return {
        name: p.name,
        status: health?.status ?? 'unknown',
        lastCheckAt: health?.lastCheckAt,
        lastSuccessAt: health?.lastSuccessAt,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
        queue: queueStatus,
      };
    });

    return reply.send(providers);
  });


  app.get<{ Params: { name: string } }>('/admin/providers/:name/config', async (request, reply) => {
    const { name } = request.params;
    const config = deps.registry.getProviderConfig(name);

    if (!config) {
      return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
    }

    return reply.send(config);
  });



  app.get('/admin/providers/codex/cli-defaults', async (_request, reply) => {
    return reply.send(readCodexCliDefaults());
  });


  app.put<{ Params: { name: string }; Body: Partial<ProviderConfigYaml> }>(
    '/admin/providers/:name',
    async (request, reply) => {
      const { name } = request.params;

      if (!deps.registry.has(name)) {
        return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
      }

      let partial: Partial<ProviderConfigYaml>;
      try {
        partial = validateRuntimeProviderConfig(name, request.body, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: { message } });
      }


      const updated = deps.registry.updateProviderConfig(name, partial);
      if (!updated) {
        return reply.status(500).send({ error: { message: `Failed to update provider "${name}" config.` } });
      }


      if (partial.max_concurrent !== undefined) {
        deps.queueManager.updateConcurrency(name, partial.max_concurrent);
      }
      if (
        partial.max_queue_size !== undefined
        || partial.max_queue_wait_ms !== undefined
      ) {
        const current = deps.registry.getProviderConfig(name);
        deps.queueManager.updateLimits(
          name,
          current?.max_queue_size ?? 32,
          current?.max_queue_wait_ms ?? 30_000,
        );
      }


      const existingOverride = await loadProviderConfigFromDb(name);
      const merged = mergeProviderConfigPartials(existingOverride ?? {}, partial);
      await saveProviderConfigToDb(name, merged);


      const newConfig = deps.registry.getProviderConfig(name);
      return reply.send(newConfig);
    },
  );


  app.post<{ Params: { name: string } }>('/admin/providers/:name/test', async (request, reply) => {
    const { name } = request.params;
    const provider = deps.registry.get(name);

    if (!provider) {
      return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
    }

    const config = deps.registry.getProviderConfig(name);
    const model = config?.default_model ?? '';

    if (!model) {
      return reply.status(400).send({
        success: false,
        error: 'No default_model configured for this provider.',
      });
    }

    const startTime = Date.now();


    try {
      const status = await provider.checkHealth();

      const latencyMs = Date.now() - startTime;

      return reply.send({
        success: status === 'healthy',
        ...(status === 'healthy'
          ? { response: 'Executable is available for the logged-in user.' }
          : { error: 'Executable is unavailable for the logged-in user.' }),
        latencyMs,
      });
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      return reply.send({
        success: false,
        error: message,
        latencyMs,
      });
    }
  });


  app.post<{ Params: { name: string } }>('/admin/providers/:name/health-check', async (request, reply) => {
    const { name } = request.params;
    if (!deps.registry.has(name)) {
      return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
    }

    const status = await deps.healthChecker.checkProvider(name);
    return reply.send({ provider: name, status });
  });
}
