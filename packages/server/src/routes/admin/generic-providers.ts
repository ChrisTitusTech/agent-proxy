import type { FastifyInstance } from 'fastify';
import { eq, like } from 'drizzle-orm';
import type { GenericCliProviderConfig } from '@agent-proxy/shared';
import { getDatabase } from '../../db/client.js';
import { settings, providerHealth } from '../../db/schema.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { QueueManager } from '../../services/queue.js';
import { GenericCliProvider } from '../../providers/generic-cli-provider.js';


const GENERIC_PROVIDER_PREFIX = 'generic_provider:';
const PROVIDER_CONFIG_PREFIX = 'provider_config:';


const BUILTIN_PROVIDER_NAMES = ['claude', 'codex', 'agy', 'grok'];


const PROVIDER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;


const SAFE_CLI_PATH = /^[a-zA-Z0-9_\-./\\:]+$/;

function validateProviderName(name: string): string | null {
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    return `Provider name "${name}" is invalid. Use lowercase letters, numbers, and hyphens only (length 2-30).`;
  }
  if (name.length < 2 || name.length > 30) {
    return `Provider name must be between 2 and 30 characters.`;
  }
  return null;
}

function validateCliPath(cliPath: string): string | null {
  if (!SAFE_CLI_PATH.test(cliPath)) {
    return `Unsafe cli_path: "${cliPath}". Only alphanumeric, -, _, ., /, \\, : allowed.`;
  }
  return null;
}


async function loadGenericProviderFromDb(
  name: string,
): Promise<GenericCliProviderConfig | null> {
  const db = getDatabase();
  const key = `${GENERIC_PROVIDER_PREFIX}${name}`;
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].value) as GenericCliProviderConfig;
  } catch {
    return null;
  }
}


async function saveGenericProviderToDb(
  name: string,
  config: GenericCliProviderConfig,
): Promise<void> {
  const db = getDatabase();
  const key = `${GENERIC_PROVIDER_PREFIX}${name}`;
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

interface GenericProviderDeps {
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  queueManager: QueueManager;
}

export function registerGenericProviderRoutes(
  app: FastifyInstance,
  deps: GenericProviderDeps,
): void {

  app.get('/admin/generic-providers', async (_request, reply) => {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(settings)
      .where(like(settings.key, `${GENERIC_PROVIDER_PREFIX}%`));

    const providers = rows.map((row) => {
      const name = row.key.replace(GENERIC_PROVIDER_PREFIX, '');
      try {
        const config = JSON.parse(row.value) as GenericCliProviderConfig;
        return { name, config };
      } catch {
        return null;
      }
    }).filter(Boolean);

    return reply.send(providers);
  });


  app.get<{ Params: { name: string } }>(
    '/admin/generic-providers/:name',
    async (request, reply) => {
      const { name } = request.params;
      const config = await loadGenericProviderFromDb(name);

      if (!config) {
        return reply.status(404).send({
          error: { message: `Generic provider "${name}" not found.` },
        });
      }

      return reply.send({ name, config });
    },
  );


  app.post<{ Body: { name: string } & GenericCliProviderConfig }>(
    '/admin/generic-providers',
    async (request, reply) => {
      const { name, ...configData } = request.body;


      if (!name) {
        return reply.status(400).send({ error: { message: 'Provider name is required.' } });
      }
      const nameError = validateProviderName(name);
      if (nameError) {
        return reply.status(400).send({ error: { message: nameError } });
      }


      if (BUILTIN_PROVIDER_NAMES.includes(name)) {
        return reply.status(409).send({
          error: { message: `Cannot use built-in provider name: "${name}".` },
        });
      }


      if (deps.registry.has(name)) {
        return reply.status(409).send({
          error: { message: `Provider "${name}" is already registered.` },
        });
      }


      if (!configData.cli_path) {
        return reply.status(400).send({ error: { message: 'cli_path is required.' } });
      }
      const cliPathError = validateCliPath(configData.cli_path);
      if (cliPathError) {
        return reply.status(400).send({ error: { message: cliPathError } });
      }


      const config: GenericCliProviderConfig = {
        enabled: configData.enabled ?? true,
        cli_path: configData.cli_path,
        default_model: configData.default_model ?? '',
        max_concurrent: configData.max_concurrent ?? 2,
        timeout_ms: configData.timeout_ms ?? 120000,
        extra_args: configData.extra_args ?? [],
        prompt_mode: configData.prompt_mode ?? 'stdin',
        args_template: configData.args_template ?? [],
        output_mode: configData.output_mode ?? 'plain_text',
        streaming_enabled: configData.streaming_enabled ?? false,
        display_name: configData.display_name ?? name,
        ...(configData.prompt_arg_template !== undefined && { prompt_arg_template: configData.prompt_arg_template }),
        ...(configData.output_json_content_field !== undefined && { output_json_content_field: configData.output_json_content_field }),
        ...(configData.stream_args_template !== undefined && { stream_args_template: configData.stream_args_template }),
        ...(configData.stream_content_field !== undefined && { stream_content_field: configData.stream_content_field }),
        ...(configData.stream_done_indicator !== undefined && { stream_done_indicator: configData.stream_done_indicator }),
        ...(configData.health_check_args !== undefined && { health_check_args: configData.health_check_args }),
        ...(configData.description !== undefined && { description: configData.description }),
        ...(configData.working_dir !== undefined && { working_dir: configData.working_dir }),
      };


      await saveGenericProviderToDb(name, config);


      const provider = new GenericCliProvider(name, config);
      deps.registry.register(provider);
      deps.queueManager.addQueue(name, config.max_concurrent);


      deps.healthChecker.checkProvider(name).catch(() => {});

      return reply.status(201).send({ name, config });
    },
  );


  app.put<{ Params: { name: string }; Body: Partial<GenericCliProviderConfig> }>(
    '/admin/generic-providers/:name',
    async (request, reply) => {
      const { name } = request.params;
      const partial = request.body;


      const existing = await loadGenericProviderFromDb(name);
      if (!existing) {
        return reply.status(404).send({
          error: { message: `Generic provider "${name}" not found.` },
        });
      }


      if (partial.cli_path !== undefined) {
        const cliPathError = validateCliPath(partial.cli_path);
        if (cliPathError) {
          return reply.status(400).send({ error: { message: cliPathError } });
        }
      }


      const updated: GenericCliProviderConfig = { ...existing, ...partial };


      await saveGenericProviderToDb(name, updated);


      const structuralFields: Array<keyof GenericCliProviderConfig> = [
        'args_template',
        'prompt_mode',
        'prompt_arg_template',
        'output_mode',
        'output_json_content_field',
        'streaming_enabled',
        'stream_args_template',
        'stream_content_field',
        'stream_done_indicator',
        'health_check_args',
        'cli_path',
      ];
      const hasStructuralChange = structuralFields.some(
        (field) => partial[field] !== undefined,
      );

      if (hasStructuralChange && deps.registry.has(name)) {

        deps.registry.unregister(name);
        const newProvider = new GenericCliProvider(name, updated);
        deps.registry.register(newProvider);
      } else if (deps.registry.has(name)) {

        deps.registry.updateProviderConfig(name, partial);
      }


      if (partial.max_concurrent !== undefined) {
        deps.queueManager.updateConcurrency(name, partial.max_concurrent);
      }

      return reply.send({ name, config: updated });
    },
  );


  app.delete<{ Params: { name: string } }>(
    '/admin/generic-providers/:name',
    async (request, reply) => {
      const { name } = request.params;


      if (BUILTIN_PROVIDER_NAMES.includes(name)) {
        return reply.status(403).send({
          error: { message: `Cannot delete built-in provider: "${name}".` },
        });
      }


      const existing = await loadGenericProviderFromDb(name);
      if (!existing) {
        return reply.status(404).send({
          error: { message: `Generic provider "${name}" not found.` },
        });
      }

      const db = getDatabase();


      await db
        .delete(settings)
        .where(eq(settings.key, `${GENERIC_PROVIDER_PREFIX}${name}`));


      await db
        .delete(settings)
        .where(eq(settings.key, `${PROVIDER_CONFIG_PREFIX}${name}`));


      await db
        .delete(providerHealth)
        .where(eq(providerHealth.provider, name));


      if (deps.registry.has(name)) {
        deps.registry.unregister(name);
      }
      deps.queueManager.removeQueue(name);

      return reply.send({ success: true });
    },
  );


  app.post<{ Body: { name?: string } & GenericCliProviderConfig }>(
    '/admin/generic-providers/test',
    async (request, reply) => {
      const { name, ...configData } = request.body;
      const providerName = name || '__test__';

      if (!configData.cli_path) {
        return reply.status(400).send({ error: { message: 'cli_path is required.' } });
      }
      const cliPathError = validateCliPath(configData.cli_path);
      if (cliPathError) {
        return reply.status(400).send({ error: { message: cliPathError } });
      }

      const config: GenericCliProviderConfig = {
        enabled: true,
        cli_path: configData.cli_path,
        default_model: configData.default_model ?? '',
        max_concurrent: configData.max_concurrent ?? 10,
        timeout_ms: configData.timeout_ms ?? 300000,
        extra_args: configData.extra_args ?? [],
        prompt_mode: configData.prompt_mode ?? 'stdin',
        args_template: configData.args_template ?? [],
        output_mode: configData.output_mode ?? 'plain_text',
        streaming_enabled: configData.streaming_enabled ?? false,
        display_name: configData.display_name ?? providerName,
        ...(configData.prompt_arg_template !== undefined && { prompt_arg_template: configData.prompt_arg_template }),
        ...(configData.output_json_content_field !== undefined && { output_json_content_field: configData.output_json_content_field }),
        ...(configData.stream_args_template !== undefined && { stream_args_template: configData.stream_args_template }),
        ...(configData.stream_content_field !== undefined && { stream_content_field: configData.stream_content_field }),
        ...(configData.stream_done_indicator !== undefined && { stream_done_indicator: configData.stream_done_indicator }),
        ...(configData.health_check_args !== undefined && { health_check_args: configData.health_check_args }),
        ...(configData.working_dir !== undefined && { working_dir: configData.working_dir }),
      };


      const testProvider = new GenericCliProvider(providerName, config);
      const model = config.default_model || '';
      const startTime = Date.now();

      try {
        const result = await testProvider.execute({
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
          model,
          stream: false,
        });
        const latencyMs = Date.now() - startTime;

        return reply.send({
          success: true,
          response: result.content.substring(0, 200),
          latencyMs,
          usage: result.usage,
        });
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        return reply.send({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          latencyMs,
        });
      }
    },
  );
}
