import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppConfig, RateLimitConfig, ValidationConfig, ProviderConfigYaml, GenericCliProviderConfig } from '@agent-proxy/shared';
import { API_KEY_PREFIX, isReasoningEffort } from '@agent-proxy/shared';
import { GenericCliProvider } from '../../providers/generic-cli-provider.js';
import { getDatabase } from '../../db/client.js';
import { modelMappings, apiKeys, settings } from '../../db/schema.js';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { hashApiKey, getKeyPrefix } from '../../middleware/auth.js';
import { loadRateLimitsFromDb } from './rate-limits.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { QueueManager } from '../../services/queue.js';
import type { HealthChecker } from '../../services/health-checker.js';
import { sanitizeRuntimeProviderConfig } from './providers.js';

const RATE_LIMITS_KEY = 'rate_limits';
const VALIDATION_KEY = 'validation_config';
const GENERIC_PROVIDER_PREFIX = 'generic_provider:';
const EXPORT_VERSION = 2;

interface ExportImportDeps {
  rateLimiter: RateLimiter;
  defaultRateLimits: RateLimitConfig;
  getValidation: () => ValidationConfig;
  setValidation: (v: Partial<ValidationConfig>) => void;
  config: AppConfig;
  registry: ProviderRegistry;
  queueManager: QueueManager;
  healthChecker: HealthChecker;
}

interface ExportData {
  version: number;
  exportedAt: string;
  modelMappings: Array<{
    alias: string;
    provider: string;
    actualModel: string;
    displayName: string | null;
    reasoningEffort?: string | null;
    priority: number;
    enabled: boolean;
  }>;
  rateLimits: RateLimitConfig;
  validation: ValidationConfig;
  apiKeys: Array<{
    name: string;
    enabled: boolean;
    rateLimitRpm: number | null;
    rateLimitRpd: number | null;
  }>;
  providers: Record<string, {
    enabled: boolean;
    cli_path: string;
    default_model: string;
    max_concurrent: number;
    timeout_ms: number;
    extra_args: string[];
    working_dir?: string;
  }>;
  genericProviders?: Record<string, GenericCliProviderConfig>;
}

interface ImportResult {
  success: boolean;
  imported: {
    modelMappings: number;
    rateLimits: boolean;
    validation: boolean;
    apiKeys: { created: number; updated: number };
    providers: number;
  };
  skipped: string[];
}


function validateExportData(body: unknown): string | null {
  const data = body as Record<string, unknown>;


  if (data.modelMappings !== undefined) {
    if (!Array.isArray(data.modelMappings)) return 'modelMappings must be an array';
    for (const m of data.modelMappings) {
      if (!m || typeof m !== 'object') return 'modelMappings items must be objects';
      const mapping = m as Record<string, unknown>;
      if (typeof mapping.alias !== 'string' || !mapping.alias) return 'modelMappings.alias is required';
      if (typeof mapping.provider !== 'string' || !mapping.provider) return 'modelMappings.provider is required';
      if (typeof mapping.actualModel !== 'string' || !mapping.actualModel) return 'modelMappings.actualModel is required';
    }
  }


  if (data.rateLimits !== undefined) {
    if (!data.rateLimits || typeof data.rateLimits !== 'object') return 'rateLimits must be an object';
    const rl = data.rateLimits as Record<string, unknown>;
    if (!rl.global || typeof rl.global !== 'object') return 'rateLimits.global is required';
    const global = rl.global as Record<string, unknown>;
    if (typeof global.rpm !== 'number' || typeof global.rpd !== 'number') return 'rateLimits.global.rpm and rpd must be numbers';
  }


  if (data.validation !== undefined) {
    if (!data.validation || typeof data.validation !== 'object') return 'validation must be an object';
  }


  if (data.apiKeys !== undefined) {
    if (!Array.isArray(data.apiKeys)) return 'apiKeys must be an array';
    for (const k of data.apiKeys) {
      if (!k || typeof k !== 'object') return 'apiKeys items must be objects';
      const key = k as Record<string, unknown>;
      if (typeof key.name !== 'string' || !key.name) return 'apiKeys.name is required';
    }
  }


  if (data.providers !== undefined) {
    if (!data.providers || typeof data.providers !== 'object') return 'providers must be an object';
  }

  return null;
}

export function registerExportImportRoutes(
  app: FastifyInstance,
  deps: ExportImportDeps,
): void {

  app.get('/admin/export', async (_request, reply) => {
    const db = getDatabase();


    const mappings = await db.select({
      alias: modelMappings.alias,
      provider: modelMappings.provider,
      actualModel: modelMappings.actualModel,
      displayName: modelMappings.displayName,
      reasoningEffort: modelMappings.reasoningEffort,
      priority: modelMappings.priority,
      enabled: modelMappings.enabled,
    }).from(modelMappings);


    const rateLimits = await loadRateLimitsFromDb(deps.defaultRateLimits);


    const validation = deps.getValidation();


    const keys = await db.select({
      name: apiKeys.name,
      enabled: apiKeys.enabled,
      rateLimitRpm: apiKeys.rateLimitRpm,
      rateLimitRpd: apiKeys.rateLimitRpd,
    }).from(apiKeys);


    const providers: ExportData['providers'] = {};
    for (const provider of deps.registry.getAll()) {
      const config = deps.registry.getProviderConfig(provider.name);
      if (config) {
        providers[provider.name] = {
          enabled: config.enabled,
          cli_path: config.cli_path,
          default_model: config.default_model,
          max_concurrent: config.max_concurrent,
          timeout_ms: config.timeout_ms,
          extra_args: config.extra_args,
          working_dir: config.working_dir,
        };
      }
    }


    const genericProviders: Record<string, GenericCliProviderConfig> = {};
    const allSettings = await db.select().from(settings);
    for (const row of allSettings) {
      if (row.key.startsWith(GENERIC_PROVIDER_PREFIX)) {
        const name = row.key.replace(GENERIC_PROVIDER_PREFIX, '');
        try {
          genericProviders[name] = JSON.parse(row.value) as GenericCliProviderConfig;
        } catch { }
      }
    }

    const exportData: ExportData = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      modelMappings: mappings,
      rateLimits,
      validation,
      apiKeys: keys,
      providers,
      ...(Object.keys(genericProviders).length > 0 && { genericProviders }),
    };

    return reply.send(exportData);
  });


  app.post<{ Body: ExportData }>('/admin/import', async (request, reply) => {
    const body = request.body;


    if (!body.version || body.version > EXPORT_VERSION) {
      return reply.status(400).send({
        error: { message: `Unsupported export version: ${body.version}. Expected: ${EXPORT_VERSION} or lower.` },
      });
    }


    const validationError = validateExportData(body);
    if (validationError) {
      return reply.status(400).send({
        error: { message: `Invalid import data: ${validationError}` },
      });
    }

    const db = getDatabase();
    const skipped: string[] = [];
    let mappingsCount = 0;
    let rateLimitsImported = false;
    let validationImported = false;
    let keysCreated = 0;
    let keysUpdated = 0;


    if (body.modelMappings && Array.isArray(body.modelMappings)) {
      await db.delete(modelMappings);
      const now = new Date().toISOString();

      for (const mapping of body.modelMappings) {
        if (!mapping.alias || !mapping.provider || !mapping.actualModel) continue;

        const rawEffort = typeof mapping.reasoningEffort === 'string'
          ? mapping.reasoningEffort.trim().toLowerCase()
          : null;
        const effort = rawEffort && isReasoningEffort(rawEffort) ? rawEffort : null;
        await db.insert(modelMappings).values({
          id: nanoid(),
          alias: mapping.alias,
          provider: mapping.provider,
          actualModel: mapping.actualModel,
          displayName: mapping.displayName ?? null,
          reasoningEffort: effort,
          priority: mapping.priority ?? 0,
          enabled: mapping.enabled ?? true,
          createdAt: now,
          updatedAt: now,
        });
        mappingsCount++;
      }
    }


    if (body.rateLimits) {
      const value = JSON.stringify(body.rateLimits);
      const now = new Date().toISOString();
      const existing = await db.select().from(settings).where(eq(settings.key, RATE_LIMITS_KEY)).limit(1);

      if (existing.length === 0) {
        await db.insert(settings).values({ key: RATE_LIMITS_KEY, value, updatedAt: now });
      } else {
        await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, RATE_LIMITS_KEY));
      }


      deps.rateLimiter.updateConfig(body.rateLimits);
      rateLimitsImported = true;
    }


    if (body.validation) {
      const currentValidation = deps.getValidation();
      const normalizedValidation: ValidationConfig = {
        ...body.validation,

        bodyLimitBytes: currentValidation.bodyLimitBytes,
      };
      const value = JSON.stringify(normalizedValidation);
      const now = new Date().toISOString();
      const existing = await db.select().from(settings).where(eq(settings.key, VALIDATION_KEY)).limit(1);

      if (existing.length === 0) {
        await db.insert(settings).values({ key: VALIDATION_KEY, value, updatedAt: now });
      } else {
        await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, VALIDATION_KEY));
      }


      deps.setValidation(normalizedValidation);
      validationImported = true;
    }


    if (body.apiKeys && Array.isArray(body.apiKeys)) {
      for (const keyData of body.apiKeys) {
        if (!keyData.name) continue;

        const existing = await db.select().from(apiKeys).where(eq(apiKeys.name, keyData.name)).limit(1);

        if (existing.length === 0) {

          const rawKey = `${API_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
          await db.insert(apiKeys).values({
            id: nanoid(),
            keyHash: hashApiKey(rawKey),
            keyPrefix: getKeyPrefix(rawKey),
            name: keyData.name,
            enabled: keyData.enabled ?? true,
            rateLimitRpm: keyData.rateLimitRpm ?? null,
            rateLimitRpd: keyData.rateLimitRpd ?? null,
            createdAt: new Date().toISOString(),
          });
          keysCreated++;
        } else {

          const updates: Record<string, unknown> = {};
          if (keyData.enabled !== undefined) updates.enabled = keyData.enabled;
          if (keyData.rateLimitRpm !== undefined) updates.rateLimitRpm = keyData.rateLimitRpm;
          if (keyData.rateLimitRpd !== undefined) updates.rateLimitRpd = keyData.rateLimitRpd;

          if (Object.keys(updates).length > 0) {
            await db.update(apiKeys).set(updates).where(eq(apiKeys.id, existing[0].id));
          }
          keysUpdated++;
        }
      }
    }


    let providersImported = 0;
    if (body.providers && typeof body.providers === 'object') {
      const now = new Date().toISOString();
      for (const [name, providerConfig] of Object.entries(body.providers)) {

        if (!deps.registry.getProviderConfig(name)) {
          skipped.push(`provider "${name}" (not registered)`);
          continue;
        }

        const override: Partial<ProviderConfigYaml> = {};
        if (providerConfig.enabled !== undefined) override.enabled = providerConfig.enabled;
        if (providerConfig.default_model !== undefined) override.default_model = providerConfig.default_model;
        if (providerConfig.max_concurrent !== undefined) override.max_concurrent = providerConfig.max_concurrent;
        if (providerConfig.timeout_ms !== undefined) override.timeout_ms = providerConfig.timeout_ms;
        if (providerConfig.extra_args !== undefined) override.extra_args = providerConfig.extra_args;
        if (providerConfig.working_dir !== undefined) override.working_dir = providerConfig.working_dir;
        if (providerConfig.cli_path !== undefined) override.cli_path = providerConfig.cli_path;

        const sanitizedOverride = sanitizeRuntimeProviderConfig(name, override);
        if (Object.keys(sanitizedOverride).length === 0) continue;


        deps.registry.updateProviderConfig(name, sanitizedOverride);
        if (sanitizedOverride.max_concurrent) {
          deps.queueManager.updateConcurrency(name, sanitizedOverride.max_concurrent);
        }


        const dbKey = `provider_config:${name}`;
        const existing = await db.select().from(settings).where(eq(settings.key, dbKey)).limit(1);
        const existingOverride = existing.length > 0
          ? sanitizeRuntimeProviderConfig(name, JSON.parse(existing[0].value) as Partial<ProviderConfigYaml>)
          : {};
        const merged = { ...existingOverride, ...sanitizedOverride };

        if (existing.length === 0) {
          await db.insert(settings).values({ key: dbKey, value: JSON.stringify(merged), updatedAt: now });
        } else {
          await db.update(settings).set({ value: JSON.stringify(merged), updatedAt: now }).where(eq(settings.key, dbKey));
        }

        providersImported++;
      }
    }


    let genericProvidersImported = 0;
    if (body.genericProviders && typeof body.genericProviders === 'object') {
      const now = new Date().toISOString();
      const BUILTIN_NAMES = ['claude', 'codex', 'agy', 'grok'];

      for (const [name, genericConfig] of Object.entries(body.genericProviders)) {

        if (BUILTIN_NAMES.includes(name)) {
          skipped.push(`generic provider "${name}" (conflicts with built-in)`);
          continue;
        }
        if (!genericConfig.cli_path) {
          skipped.push(`generic provider "${name}" (missing cli_path)`);
          continue;
        }


        const dbKey = `${GENERIC_PROVIDER_PREFIX}${name}`;
        const value = JSON.stringify(genericConfig);
        const existing = await db.select().from(settings).where(eq(settings.key, dbKey)).limit(1);

        if (existing.length === 0) {
          await db.insert(settings).values({ key: dbKey, value, updatedAt: now });
        } else {
          await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, dbKey));
        }


        if (deps.registry.has(name)) {
          deps.registry.unregister(name);
        }
        if (genericConfig.enabled !== false) {
          const provider = new GenericCliProvider(name, genericConfig);
          deps.registry.register(provider);
          deps.queueManager.addQueue(name, genericConfig.max_concurrent);
          deps.healthChecker.checkProvider(name).catch(() => {});
        }

        genericProvidersImported++;
      }
    }

    const result: ImportResult = {
      success: true,
      imported: {
        modelMappings: mappingsCount,
        rateLimits: rateLimitsImported,
        validation: validationImported,
        apiKeys: { created: keysCreated, updated: keysUpdated },
        providers: providersImported + genericProvidersImported,
      },
      skipped,
    };

    return reply.send(result);
  });
}
