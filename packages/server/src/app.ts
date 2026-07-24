import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from '@agent-proxy/shared';
import { initDatabase } from './db/client.js';
import { createProviderRegistry } from './providers/provider-registry.js';
import { ModelRouter } from './services/router.js';
import { QueueManager } from './services/queue.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { HealthChecker } from './services/health-checker.js';
import { authMiddleware, adminAuthMiddleware } from './middleware/auth.js';
import { RequestRateLimiter } from './middleware/request-rate-limiter.js';
import { registerChatCompletionsRoute } from './routes/v1/chat-completions.js';
import { registerMessagesRoute } from './routes/v1/messages.js';
import { registerModelsRoute } from './routes/v1/models.js';
import { registerImageGenerationsRoute } from './routes/v1/images-generations.js';
import { registerEmbeddingsRoute } from './routes/v1/embeddings.js';
import { registerRerankRoute } from './routes/v1/rerank.js';
import { registerAudioSpeechRoute } from './routes/v1/audio-speech.js';
import { registerResponsesRoute } from './routes/v1/responses.js';
import { ResponsesStore } from './routes/v1/responses-store.js';
import { registerModelMappingsRoutes } from './routes/admin/model-mappings.js';
import { registerApiKeysRoutes } from './routes/admin/api-keys.js';
import { registerStatsRoutes } from './routes/admin/stats.js';
import { registerProvidersRoutes, loadEffectiveProviderConfigs } from './routes/admin/providers.js';
import { registerChannelBridgeRoutes, maybeAutoStartBridge } from './routes/admin/channel-bridge.js';
import { channelBridgeManager } from './channel-bridge/manager.js';
import { registerTestModelRoute } from './routes/admin/test-model.js';
import { registerRateLimitsRoutes, loadRateLimitsFromDb } from './routes/admin/rate-limits.js';
import { registerDashboardRoute } from './routes/admin/dashboard.js';
import { ActiveRequestTracker } from './services/active-requests.js';
import { ResponseCache } from './services/cache.js';
import { DebugService } from './services/debug.js';
import { registerDebugRoutes } from './routes/admin/debug.js';
import { registerSettingsRoutes, loadValidationFromDb } from './routes/admin/settings.js';
import { registerExportImportRoutes } from './routes/admin/export-import.js';
import { registerGenericProviderRoutes } from './routes/admin/generic-providers.js';
import { registerHttpProviderRoutes } from './routes/admin/http-providers.js';
import { loadGenericProviders } from './providers/generic-provider-loader.js';
import { loadHttpProviders } from './providers/http-provider-loader.js';
import { seedDatabase } from './db/seed.js';
import type { ValidationConfig } from '@agent-proxy/shared';

export type AgentProxyApp = FastifyInstance & {
  stopProviderProcesses: () => Promise<void>;
};

export interface CreateAppOptions {
  databaseInitialized?: boolean;
}

export async function createApp(
  config: AppConfig,
  options: CreateAppOptions = {},
): Promise<AgentProxyApp> {

  if (!config.auth.adminToken) {
    throw new Error('ADMIN_TOKEN must be set. Set it in .env or config.yaml.');
  }


  if (!options.databaseInitialized) {
    await initDatabase(config.database.path);
  }

  config = {
    ...config,
    providers: await loadEffectiveProviderConfigs(config.providers),
  };

  await seedDatabase(config);


  const registry = createProviderRegistry(config.providers);


  const savedRateLimits = await loadRateLimitsFromDb(config.rateLimits);


  const savedValidation = await loadValidationFromDb();
  let currentValidation: ValidationConfig = savedValidation ?? { ...config.validation };


  const router = new ModelRouter(registry);
  const queueManager = new QueueManager();
  const rateLimiter = new RateLimiter(savedRateLimits);
  const healthChecker = new HealthChecker(registry);
  const activeRequests = new ActiveRequestTracker();
  const cache = new ResponseCache(config.cache);
  const debug = new DebugService();
  const apiAuthLimiter = new RequestRateLimiter(600);
  const adminAuthLimiter = new RequestRateLimiter(300);


  for (const [name, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.enabled) {
      queueManager.addQueue(name, providerConfig.max_concurrent);
    }
  }


  await loadGenericProviders(registry, queueManager, {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
  });


  await loadHttpProviders(registry, queueManager, {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
  });


  const app = Fastify({
    bodyLimit: config.validation.bodyLimitBytes,
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    },
  });


  const corsOrigins = config.server.cors.origins;
  const allowAll = corsOrigins.length === 1 && corsOrigins[0] === '*';
  await app.register(cors, {
    origin: allowAll ? true : corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],


  });


  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      providers: registry.getAll().map((p) => p.name),
    });
  });


  app.get('/admin/server-info', async (_request, reply) => {
    return reply.send({
      serverPort: config.server.port,
      serverHost: config.server.host,
      dashboardPort: config.dashboard.port,
      dashboardHost: config.dashboard.host,
    });
  });


  if (config.auth.enabled) {
    app.addHook('onRequest', async (request, reply) => {

      if (request.url === '/health' || request.url.startsWith('/admin')) return;
      const rateLimit = apiAuthLimiter.consume(request.ip);
      if (!rateLimit.allowed) {
        reply.header('Retry-After', rateLimit.retryAfterSeconds);
        return reply.status(429).send({
          error: {
            message: 'Too many authentication attempts. Try again later.',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        });
      }
      await authMiddleware(request, reply);
    });
  }


  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/admin')) return;
    const rateLimit = adminAuthLimiter.consume(request.ip);
    if (!rateLimit.allowed) {
      reply.header('Retry-After', rateLimit.retryAfterSeconds);
      return reply.status(429).send({
        error: {
          message: 'Too many admin authentication attempts. Try again later.',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      });
    }
    await adminAuthMiddleware(request, reply, config.auth.adminToken);
  });
  registerResponsesRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    validation: currentValidation,
    activeRequests,
    store: new ResponsesStore({
      ttlMs: config.responses.retentionTtlMs,
      maxEntries: config.responses.maxEntries,
    }),
    corsOrigins: config.server.cors.origins,
  });


  registerChatCompletionsRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    validation: currentValidation,
    activeRequests,
    cache,
    debug,
  });
  registerMessagesRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    validation: currentValidation,
    activeRequests,
    cache,
    debug,
  });
  registerModelsRoute(app);
  registerImageGenerationsRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });
  registerEmbeddingsRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });
  registerRerankRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });
  registerAudioSpeechRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });


  registerModelMappingsRoutes(app);
  registerApiKeysRoutes(app);
  registerStatsRoutes(app);
  registerProvidersRoutes(app, {
    registry,
    healthChecker,
    queueManager,
    defaultConfigs: config.providers,
  });
  registerChannelBridgeRoutes(app, { defaultConfigs: config.providers });

  registerTestModelRoute(app, registry);
  registerRateLimitsRoutes(app, rateLimiter, config.rateLimits);
  registerDebugRoutes(app, debug);
  registerSettingsRoutes(app, {
    getValidation: () => currentValidation,
    setValidation: (v) => {

      Object.assign(currentValidation, v);
    },
  });
  registerExportImportRoutes(app, {
    rateLimiter,
    defaultRateLimits: config.rateLimits,
    getValidation: () => currentValidation,
    setValidation: (v) => { Object.assign(currentValidation, v); },
    config,
    registry,
    queueManager,
    healthChecker,
  });
  registerGenericProviderRoutes(app, { registry, healthChecker, queueManager });
  registerHttpProviderRoutes(app, { registry, healthChecker, queueManager });
  registerDashboardRoute(app, { registry, queueManager, activeRequests });


  app.get('/admin/active-requests', async (_request, reply) => {
    return reply.send({
      count: activeRequests.count(),
      requests: activeRequests.getAll(),
    });
  });


  healthChecker.start(60_000);


  const cacheCleanupTimer = setInterval(async () => {
    const deleted = await cache.cleanup();
    if (deleted > 0) {
      app.log.info(`Cache cleanup: ${deleted} expired entries removed`);
    }
  }, 5 * 60 * 1000);


  let providerStopPromise: Promise<void> | null = null;
  const stopProviderProcesses = (): Promise<void> => {
    providerStopPromise ??= Promise.all([
      registry.shutdownAll(),
      channelBridgeManager.stop(),
    ]).then(() => undefined);
    return providerStopPromise;
  };
  const lifecycleApp = app as unknown as AgentProxyApp;
  lifecycleApp.stopProviderProcesses = stopProviderProcesses;

  app.addHook('onClose', async () => {
    healthChecker.stop();
    await rateLimiter.destroy();
    clearInterval(cacheCleanupTimer);
    await stopProviderProcesses();
  });

  await maybeAutoStartBridge({ defaultConfigs: config.providers });

  return lifecycleApp;
}
