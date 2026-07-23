import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from './config/loader.js';
import { runPreflightChecks } from './config/preflight.js';
import { createApp } from './app.js';
import { closeDatabase, initDatabase } from './db/client.js';
import { killAllChildProcesses } from './providers/base-provider.js';
import { shutdownServer } from './services/shutdown.js';
import { loadEffectiveProviderConfigs } from './routes/admin/providers.js';


const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');


dotenvConfig({ path: resolve(PROJECT_ROOT, '.env') });

function shutdownTimeoutMs(): number {
  const raw = process.env.SHUTDOWN_TIMEOUT_MS ?? '30000';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error('SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 120000.');
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? resolve(PROJECT_ROOT, 'config.yaml');
  let config = loadConfig(configPath);
  await initDatabase(config.database.path);
  config = {
    ...config,
    providers: await loadEffectiveProviderConfigs(config.providers),
  };
  const preflight = runPreflightChecks(config, { configPath });
  const drainTimeoutMs = shutdownTimeoutMs();

  if (argv.includes('--check')) {
    const enabledProviders = Object.keys(preflight.executables);
    console.log(
      `Preflight passed. State directory: ${preflight.stateDirectory}. Enabled providers: ${enabledProviders.join(', ') || 'none'}.`,
    );
    closeDatabase();
    return;
  }

  const app = await createApp(config, { databaseInitialized: true });

  try {
    await app.listen({
      port: config.server.port,
      host: config.server.host,
    });
  } catch (error) {
    await app.close().catch(() => undefined);
    await killAllChildProcesses(1_000);
    closeDatabase();
    throw error;
  }

  console.log(`agent-proxy started
API: http://${config.server.host}:${config.server.port}
Health: http://${config.server.host}:${config.server.port}/health
Admin API: http://${config.server.host}:${config.server.port}/admin`);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.error(`Received ${signal} again; forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`Received ${signal}; stopping new requests.`);

    try {
      const result = await shutdownServer({
        stopAccepting: () => app.close(),
        stopProviders: () => app.stopProviderProcesses(),
        terminateChildren: () => killAllChildProcesses(),
        closeState: () => closeDatabase(),
        drainTimeoutMs,
      });
      if (!result.drained) {
        console.warn('Request drain timeout expired; provider processes were terminated.');
      }
      process.exit(0);
    } catch (error) {
      console.error('Graceful shutdown failed:', error);
      await killAllChildProcesses(1_000);
      closeDatabase();
      process.exit(1);
    }
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

function isEntrypoint(argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    closeDatabase();
    process.exitCode = 1;
  });
}
