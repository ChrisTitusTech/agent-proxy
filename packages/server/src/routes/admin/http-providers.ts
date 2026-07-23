import type { FastifyInstance } from 'fastify';
import { eq, like } from 'drizzle-orm';
import type { HttpProviderConfig, EndpointType } from '@agent-proxy/shared';
import { inferEndpointTypeFromName } from '@agent-proxy/shared';
import { getDatabase } from '../../db/client.js';
import { settings, providerHealth } from '../../db/schema.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { QueueManager } from '../../services/queue.js';
import { HttpProvider } from '../../providers/http-provider.js';
import {
  clampHttpTimeoutMs,
  parseOutboundUrl,
  safeOutboundFetch,
  stripTrailingSlashes,
  validateHttpTimeoutMs,
} from '../../utils/outbound-http.js';


const HTTP_PROVIDER_PREFIX = 'http_provider:';
const PROVIDER_CONFIG_PREFIX = 'provider_config:';


const BUILTIN_PROVIDER_NAMES = ['claude', 'codex', 'agy', 'grok'];


const PROVIDER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;


function validateBaseUrl(url: string): string | null {
  try {
    parseOutboundUrl(url);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `Invalid URL: "${url}".`;
  }
}

function validateProviderName(name: string): string | null {
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    return `Provider name "${name}" is invalid. Use lowercase letters, numbers, and hyphens only (length 2-30).`;
  }
  if (name.length < 2 || name.length > 30) {
    return `Provider name must be between 2 and 30 characters.`;
  }
  return null;
}


async function loadHttpProviderFromDb(name: string): Promise<HttpProviderConfig | null> {
  const db = getDatabase();
  const key = `${HTTP_PROVIDER_PREFIX}${name}`;
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].value) as HttpProviderConfig;
  } catch {
    return null;
  }
}

async function saveHttpProviderToDb(name: string, config: HttpProviderConfig): Promise<void> {
  const db = getDatabase();
  const key = `${HTTP_PROVIDER_PREFIX}${name}`;
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

interface HttpProviderDeps {
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  queueManager: QueueManager;
}





interface ProbeOutcome {
  type: EndpointType;
  ok: boolean;
  status: number | null;
  error?: string;
}

async function probeEndpoint(
  type: EndpointType,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  allowPrivateNetwork: boolean,
  isOk: (json: unknown) => boolean,
): Promise<ProbeOutcome> {
  try {
    const res = await safeOutboundFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(clampHttpTimeoutMs(timeoutMs, 10_000)),
    }, allowPrivateNetwork);
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { type, ok: res.ok && isOk(json), status: res.status };
  } catch (err) {
    return { type, ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function detectEndpointType(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  customHeaders: Record<string, string> | undefined,
  timeoutMs: number,
  allowPrivateNetwork: boolean,
): Promise<{ detected: EndpointType | null; source: 'probe' | 'heuristic' | 'none'; results: ProbeOutcome[] }> {
  const base = stripTrailingSlashes(baseUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(customHeaders ?? {}),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const m = model || 'detect-probe';


  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {});

  const results = await Promise.all([
    probeEndpoint('embeddings', `${base}/embeddings`, { model: m, input: 'ping' }, headers, timeoutMs, allowPrivateNetwork, (j) => {
      const data = obj(j).data;
      if (Array.isArray(data) && data.length > 0 && (obj(data[0]).embedding !== undefined)) return true;

      return Array.isArray(j) && Array.isArray((j as unknown[])[0]);
    }),

    probeEndpoint('rerank', `${base}/rerank`, { model: m, query: 'ping', documents: ['a', 'b'], texts: ['a', 'b'], top_n: 2 }, headers, timeoutMs, allowPrivateNetwork, (j) => {
      if (Array.isArray(obj(j).results) || Array.isArray(obj(j).data)) return true;

      return Array.isArray(j) && obj((j as unknown[])[0]).score !== undefined;
    }),
    probeEndpoint('chat', `${base}/chat/completions`, { model: m, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }, headers, timeoutMs, allowPrivateNetwork, (j) => {
      return Array.isArray(obj(j).choices);
    }),
  ]);


  const priority: EndpointType[] = ['rerank', 'embeddings', 'chat'];
  for (const p of priority) {
    const hit = results.find((r) => r.type === p && r.ok);
    if (hit) return { detected: p, source: 'probe', results };
  }


  const heuristic = inferEndpointTypeFromName(model);
  if (heuristic) return { detected: heuristic, source: 'heuristic', results };

  return { detected: null, source: 'none', results };
}

export function registerHttpProviderRoutes(
  app: FastifyInstance,
  deps: HttpProviderDeps,
): void {

  app.get('/admin/http-providers', async (_request, reply) => {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(settings)
      .where(like(settings.key, `${HTTP_PROVIDER_PREFIX}%`));

    const providers = rows.map((row) => {
      const name = row.key.replace(HTTP_PROVIDER_PREFIX, '');
      try {
        const config = JSON.parse(row.value) as HttpProviderConfig;
        return { name, config };
      } catch {
        return null;
      }
    }).filter(Boolean);

    return reply.send(providers);
  });


  app.get<{ Params: { name: string } }>(
    '/admin/http-providers/:name',
    async (request, reply) => {
      const { name } = request.params;
      const config = await loadHttpProviderFromDb(name);

      if (!config) {
        return reply.status(404).send({
          error: { message: `HTTP provider "${name}" not found.` },
        });
      }

      return reply.send({ name, config });
    },
  );


  app.post<{ Body: { name: string } & Partial<HttpProviderConfig> }>(
    '/admin/http-providers',
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


      if (!configData.base_url) {
        return reply.status(400).send({ error: { message: 'base_url is required.' } });
      }
      const urlError = validateBaseUrl(configData.base_url);
      if (urlError) {
        return reply.status(400).send({ error: { message: urlError } });
      }
      if (configData.timeout_ms !== undefined) {
        const timeoutError = validateHttpTimeoutMs(configData.timeout_ms);
        if (timeoutError) {
          return reply.status(400).send({ error: { message: timeoutError } });
        }
      }

      const config: HttpProviderConfig = {
        enabled: configData.enabled ?? true,
        base_url: configData.base_url,
        allow_private_network: configData.allow_private_network === true,
        default_model: configData.default_model ?? '',
        max_concurrent: configData.max_concurrent ?? 5,
        timeout_ms: configData.timeout_ms ?? 300000,
        display_name: configData.display_name ?? name,
        ...(configData.endpoint_type !== undefined && { endpoint_type: configData.endpoint_type }),
        ...(configData.api_key !== undefined && { api_key: configData.api_key }),
        ...(configData.custom_headers !== undefined && { custom_headers: configData.custom_headers }),
        ...(configData.description !== undefined && { description: configData.description }),
      };


      await saveHttpProviderToDb(name, config);


      const provider = new HttpProvider(name, config);
      deps.registry.register(provider);
      deps.queueManager.addQueue(name, config.max_concurrent);


      deps.healthChecker.checkProvider(name).catch(() => {});

      return reply.status(201).send({ name, config });
    },
  );


  app.put<{ Params: { name: string }; Body: Partial<HttpProviderConfig> }>(
    '/admin/http-providers/:name',
    async (request, reply) => {
      const { name } = request.params;
      const partial = request.body;

      const existing = await loadHttpProviderFromDb(name);
      if (!existing) {
        return reply.status(404).send({
          error: { message: `HTTP provider "${name}" not found.` },
        });
      }


      if (partial.base_url !== undefined) {
        const urlError = validateBaseUrl(partial.base_url);
        if (urlError) {
          return reply.status(400).send({ error: { message: urlError } });
        }
      }
      if (partial.timeout_ms !== undefined) {
        const timeoutError = validateHttpTimeoutMs(partial.timeout_ms);
        if (timeoutError) {
          return reply.status(400).send({ error: { message: timeoutError } });
        }
      }

      const updated: HttpProviderConfig = { ...existing, ...partial };
      await saveHttpProviderToDb(name, updated);


      const structuralFields: Array<keyof HttpProviderConfig> = [
        'base_url', 'allow_private_network', 'api_key', 'custom_headers',
      ];
      const hasStructuralChange = structuralFields.some(
        (field) => partial[field] !== undefined,
      );

      if (hasStructuralChange && deps.registry.has(name)) {
        deps.registry.unregister(name);
        const newProvider = new HttpProvider(name, updated);
        deps.registry.register(newProvider);
      } else if (deps.registry.has(name)) {

        const provider = deps.registry.get(name);
        if (provider instanceof HttpProvider) {
          provider.updateHttpConfig(partial);
        }
      }

      if (partial.max_concurrent !== undefined) {
        deps.queueManager.updateConcurrency(name, partial.max_concurrent);
      }

      return reply.send({ name, config: updated });
    },
  );


  app.delete<{ Params: { name: string } }>(
    '/admin/http-providers/:name',
    async (request, reply) => {
      const { name } = request.params;

      if (BUILTIN_PROVIDER_NAMES.includes(name)) {
        return reply.status(403).send({
          error: { message: `Cannot delete built-in provider: "${name}".` },
        });
      }

      const existing = await loadHttpProviderFromDb(name);
      if (!existing) {
        return reply.status(404).send({
          error: { message: `HTTP provider "${name}" not found.` },
        });
      }

      const db = getDatabase();

      await db.delete(settings).where(eq(settings.key, `${HTTP_PROVIDER_PREFIX}${name}`));
      await db.delete(settings).where(eq(settings.key, `${PROVIDER_CONFIG_PREFIX}${name}`));
      await db.delete(providerHealth).where(eq(providerHealth.provider, name));

      if (deps.registry.has(name)) {
        deps.registry.unregister(name);
      }
      deps.queueManager.removeQueue(name);

      return reply.send({ success: true });
    },
  );


  app.post<{ Body: { name?: string } & Partial<HttpProviderConfig> }>(
    '/admin/http-providers/test',
    async (request, reply) => {
      const { name, ...configData } = request.body;
      const providerName = name || '__http_test__';

      if (!configData.base_url) {
        return reply.status(400).send({ error: { message: 'base_url is required.' } });
      }
      const urlError = validateBaseUrl(configData.base_url);
      if (urlError) {
        return reply.status(400).send({ error: { message: urlError } });
      }
      if (configData.timeout_ms !== undefined) {
        const timeoutError = validateHttpTimeoutMs(configData.timeout_ms);
        if (timeoutError) {
          return reply.status(400).send({ error: { message: timeoutError } });
        }
      }

      const config: HttpProviderConfig = {
        enabled: true,
        base_url: configData.base_url,
        allow_private_network: configData.allow_private_network === true,
        default_model: configData.default_model ?? '',
        max_concurrent: 10,
        timeout_ms: configData.timeout_ms ?? 300000,
        display_name: configData.display_name ?? providerName,
        ...(configData.api_key !== undefined && { api_key: configData.api_key }),
        ...(configData.custom_headers !== undefined && { custom_headers: configData.custom_headers }),
      };

      const testProvider = new HttpProvider(providerName, config);
      const model = config.default_model || '';
      const endpointType: EndpointType = configData.endpoint_type ?? 'chat';
      const startTime = Date.now();

      try {

        let response: string;
        let usage: unknown;

        if (endpointType === 'embeddings') {
          const r = await testProvider.executeEmbedding({ model, input: 'ping' });
          const dims = r.embeddings[0]?.length ?? 0;
          response = `✓ embedding: ${dims}d × ${r.embeddings.length}`;
          usage = r.usage;
        } else if (endpointType === 'rerank') {
          const r = await testProvider.executeRerank({ model, query: 'ping', documents: ['alpha document', 'beta document'] });
          const top = r.results[0];
          response = `✓ rerank: ${r.results.length} results` + (top ? `, top #${top.index} (${top.relevanceScore.toFixed(3)})` : '');
          usage = r.usage;
        } else if (endpointType === 'tts') {
          const r = await testProvider.executeTts({ model, input: 'ping', voice: 'alloy' });
          response = `✓ tts: ${r.audio.length} bytes (${r.contentType})`;
        } else if (endpointType === 'images') {

          return reply.send({
            success: false,
            error: 'Image-generation test is not supported by this button yet. Use Auto-detect to verify the endpoint.',
            latencyMs: Date.now() - startTime,
          });
        } else {
          const r = await testProvider.execute({
            messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
            model,
            stream: false,

            maxTokens: 64,
          });
          response = r.content.substring(0, 200);
          usage = r.usage;
        }

        return reply.send({
          success: true,
          response,
          latencyMs: Date.now() - startTime,
          usage,
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


  app.post<{ Body: { name?: string } & Partial<HttpProviderConfig> }>(
    '/admin/http-providers/detect',
    async (request, reply) => {
      const configData = request.body;

      if (!configData.base_url) {
        return reply.status(400).send({ error: { message: 'base_url is required.' } });
      }
      const urlError = validateBaseUrl(configData.base_url);
      if (urlError) {
        return reply.status(400).send({ error: { message: urlError } });
      }
      if (configData.timeout_ms !== undefined) {
        const timeoutError = validateHttpTimeoutMs(configData.timeout_ms);
        if (timeoutError) {
          return reply.status(400).send({ error: { message: timeoutError } });
        }
      }


      const perProbeTimeout = Math.min(clampHttpTimeoutMs(configData.timeout_ms, 10_000), 10_000);
      const detection = await detectEndpointType(
        configData.base_url,
        configData.default_model ?? '',
        configData.api_key,
        configData.custom_headers,
        perProbeTimeout,
        configData.allow_private_network === true,
      );

      return reply.send(detection);
    },
  );
}
