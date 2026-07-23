import { like } from 'drizzle-orm';
import type { GenericCliProviderConfig } from '@agent-proxy/shared';
import { getDatabase } from '../db/client.js';
import { settings } from '../db/schema.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { QueueManager } from '../services/queue.js';
import { GenericCliProvider } from './generic-cli-provider.js';


const GENERIC_PROVIDER_PREFIX = 'generic_provider:';

interface LoaderLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

interface LoadResult {
  loaded: string[];
  failed: Array<{ name: string; error: string }>;
}


export async function loadGenericProviders(
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
      .where(like(settings.key, `${GENERIC_PROVIDER_PREFIX}%`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn(`[generic-provider-loader] Database query failed: ${message}`);
    return result;
  }

  for (const row of rows) {
    const name = row.key.replace(GENERIC_PROVIDER_PREFIX, '');


    let config: GenericCliProviderConfig;
    try {
      config = JSON.parse(row.value) as GenericCliProviderConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`[generic-provider-loader] Failed to parse "${name}" configuration: ${message}`);
      result.failed.push({ name, error: `Config parse error: ${message}` });
      continue;
    }


    if (config.enabled === false) {
      logger?.info(`[generic-provider-loader] "${name}" is disabled; skipping`);
      continue;
    }


    if (registry.has(name)) {
      logger?.warn(`[generic-provider-loader] "${name}" is already registered; skipping`);
      continue;
    }

    try {

      const provider = new GenericCliProvider(name, config);
      registry.register(provider);


      queueManager.addQueue(name, config.max_concurrent);

      logger?.info(`[generic-provider-loader] Loaded "${name}" (cli_path: ${config.cli_path})`);
      result.loaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`[generic-provider-loader] Failed to register "${name}": ${message}`);
      result.failed.push({ name, error: message });
    }
  }

  if (result.loaded.length > 0) {
    logger?.info(
      `[generic-provider-loader] Loaded ${result.loaded.length} generic providers: ${result.loaded.join(', ')}`,
    );
  }

  if (result.failed.length > 0) {
    logger?.warn(
      `[generic-provider-loader] ${result.failed.length} providers failed: ${result.failed.map((f) => f.name).join(', ')}`,
    );
  }

  return result;
}
