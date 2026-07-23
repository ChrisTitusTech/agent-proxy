import type { FastifyInstance } from 'fastify';
import type { ProviderConfigYaml } from '@agent-proxy/shared';
import { channelBridgeManager, type BridgeLaunchOptions } from '../../channel-bridge/manager.js';
import { loadProviderConfigFromDb } from './providers.js';




interface ChannelBridgeDeps {
  defaultConfigs: Record<string, ProviderConfigYaml>;
}


async function resolveClaudeConfig(deps: ChannelBridgeDeps): Promise<ProviderConfigYaml> {
  const base = deps.defaultConfigs.claude;
  const override = (await loadProviderConfigFromDb('claude')) ?? {};
  return {
    ...base,
    ...override,
    channel_options: { ...base?.channel_options, ...override.channel_options },
  };
}

function buildLaunchOptions(config: ProviderConfigYaml): BridgeLaunchOptions {
  const ch = config.channel_options ?? {};
  return {
    port: ch.bridge_port ?? 8788,
    host: '127.0.0.1',
    apiKey: ch.api_key,
    cliPath: config.cli_path || 'claude',
    defaultModel: config.default_model,
    workingDir: config.working_dir,
    timeoutMs: ch.result_timeout_ms ?? config.timeout_ms,
    extraArgs: config.extra_args,
    maxConcurrent: config.max_concurrent,
    command: ch.bridge_command,
  };
}

export function registerChannelBridgeRoutes(app: FastifyInstance, deps: ChannelBridgeDeps): void {
  app.get('/admin/providers/claude/channel-bridge/status', async (_request, reply) => {
    return reply.send(await channelBridgeManager.status());
  });

  app.post('/admin/providers/claude/channel-bridge/start', async (_request, reply) => {
    try {
      const config = await resolveClaudeConfig(deps);
      const status = await channelBridgeManager.start(buildLaunchOptions(config));
      return reply.send(status);
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/admin/providers/claude/channel-bridge/stop', async (_request, reply) => {
    try {
      await channelBridgeManager.stop();
      return reply.send(await channelBridgeManager.status());
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/admin/providers/claude/channel-bridge/restart', async (_request, reply) => {
    try {
      const config = await resolveClaudeConfig(deps);
      const status = await channelBridgeManager.restart(buildLaunchOptions(config));
      return reply.send(status);
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}



export async function maybeAutoStartBridge(deps: ChannelBridgeDeps): Promise<void> {
  try {
    const config = await resolveClaudeConfig(deps);
    const ch = config.channel_options ?? {};
    if (config.mode === 'channel-worker' && ch.managed && ch.auto_start) {
      await channelBridgeManager.start(buildLaunchOptions(config));
      console.log('[channel-bridge] auto-started on boot');
    }
  } catch (err) {
    console.error(`[channel-bridge] auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
