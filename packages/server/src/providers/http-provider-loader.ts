import { like } from 'drizzle-orm';
import type { HttpProviderConfig } from '@agent-proxy/shared';
import { getDatabase } from '../db/client.js';
import { settings } from '../db/schema.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { QueueManager } from '../services/queue.js';
import { HttpProvider } from './http-provider.js';


const HTTP_PROVIDER_PREFIX = 'http_provider:';

interface LoaderLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

interface LoadResult {
  loaded: string[];
  failed: Array<{ name: string; error: string }>;
}


export async function loadHttpProviders(
  registry: ProviderRegistry,
  queueManager: QueueManager,
  logger?: LoaderLogger,
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };

  let rows: Array<{ key: string; value: string }>;
  try {
    const db = getDatabase();
    rows = await db
      .select()
      .from(settings)
      .where(like(settings.key, `${HTTP_PROVIDER_PREFIX}%`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn(`[http-provider-loader] Database query failed: ${message}`);
    return result;
  }

  for (const row of rows) {
    const name = row.key.replace(HTTP_PROVIDER_PREFIX, '');

    let config: HttpProviderConfig;
    try {
      config = JSON.parse(row.value) as HttpProviderConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`[http-provider-loader] Failed to parse "${name}" configuration: ${message}`);
      result.failed.push({ name, error: `Config parse error: ${message}` });
      continue;
    }

    if (config.enabled === false) {
      logger?.info(`[http-provider-loader] "${name}" is disabled; skipping`);
      continue;
    }

    if (registry.has(name)) {
      logger?.warn(`[http-provider-loader] "${name}" is already registered; skipping`);
      continue;
    }

    try {
      const provider = new HttpProvider(name, config);
      registry.register(provider);
      queueManager.addQueue(name, config.max_concurrent);

      logger?.info(`[http-provider-loader] Loaded "${name}" (base_url: ${config.base_url})`);
      result.loaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`[http-provider-loader] Failed to register "${name}": ${message}`);
      result.failed.push({ name, error: message });
    }
  }

  if (result.loaded.length > 0) {
    logger?.info(
      `[http-provider-loader] Loaded ${result.loaded.length} HTTP providers: ${result.loaded.join(', ')}`,
    );
  }

  if (result.failed.length > 0) {
    logger?.warn(
      `[http-provider-loader] ${result.failed.length} providers failed: ${result.failed.map((f) => f.name).join(', ')}`,
    );
  }

  return result;
}
