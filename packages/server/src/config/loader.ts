import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AppConfig, ProviderConfigYaml, ProviderOverrides, ReasoningEffort } from '@agent-proxy/shared';
import { rawConfigSchema, type RawProviderConfig } from './schema.js';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_HOST,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_RATE_LIMIT_RPM,
  DEFAULT_RATE_LIMIT_RPD,
  DEFAULT_MAX_MESSAGE_COUNT,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_PROMPT_LENGTH,
  DEFAULT_MAX_RESPONSE_LENGTH,
  DEFAULT_BODY_LIMIT_BYTES,
  isReasoningEffort,
} from '@agent-proxy/shared';



function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return isReasoningEffort(normalized) ? normalized : undefined;
}




function normalizeProviderOverrides(value: unknown, provider?: string): ProviderOverrides | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: ProviderOverrides = {};
  const isClaude = provider === 'claude';
  const isCodex = provider === 'codex';
  if (isClaude && typeof raw.mode === 'string' && ['cli', 'sdk', 'channel-worker'].includes(raw.mode)) {
    out.mode = raw.mode as ProviderOverrides['mode'];
  }
  if (Array.isArray(raw.extra_args)) {
    out.extra_args = raw.extra_args.filter((a): a is string => typeof a === 'string');
  }
  if (typeof raw.timeout_ms === 'number' && raw.timeout_ms > 0) {
    out.timeout_ms = raw.timeout_ms;
  }
  if (typeof raw.working_dir === 'string' && raw.working_dir.trim()) {
    out.working_dir = raw.working_dir;
  }
  if (isCodex && raw.cli_options && typeof raw.cli_options === 'object' && !Array.isArray(raw.cli_options)) {
    const rawCli = raw.cli_options as Record<string, unknown>;
    const cli: NonNullable<ProviderOverrides['cli_options']> = {};
    if (typeof rawCli.ephemeral === 'boolean') cli.ephemeral = rawCli.ephemeral;
    if (typeof rawCli.enable_session_reuse === 'boolean') cli.enable_session_reuse = rawCli.enable_session_reuse;
    if (typeof rawCli.session_ttl_ms === 'number' && rawCli.session_ttl_ms > 0) cli.session_ttl_ms = rawCli.session_ttl_ms;
    if (Object.keys(cli).length > 0) out.cli_options = cli;
  }
  if (isClaude && raw.sdk_options && typeof raw.sdk_options === 'object' && !Array.isArray(raw.sdk_options)) {
    const rawSdk = raw.sdk_options as Record<string, unknown>;
    const sdk: NonNullable<ProviderOverrides['sdk_options']> = {};
    if (typeof rawSdk.max_turns === 'number' && rawSdk.max_turns > 0) sdk.max_turns = rawSdk.max_turns;
    if (typeof rawSdk.permission_mode === 'string') sdk.permission_mode = rawSdk.permission_mode;
    if (Array.isArray(rawSdk.allowed_tools)) sdk.allowed_tools = rawSdk.allowed_tools.filter((a): a is string => typeof a === 'string');
    if (Array.isArray(rawSdk.disallowed_tools)) sdk.disallowed_tools = rawSdk.disallowed_tools.filter((a): a is string => typeof a === 'string');
    if (typeof rawSdk.max_budget_usd === 'number' && rawSdk.max_budget_usd > 0) sdk.max_budget_usd = rawSdk.max_budget_usd;
    if (typeof rawSdk.session_ttl_ms === 'number' && rawSdk.session_ttl_ms > 0) sdk.session_ttl_ms = rawSdk.session_ttl_ms;
    if (typeof rawSdk.enable_session_reuse === 'boolean') sdk.enable_session_reuse = rawSdk.enable_session_reuse;
    if (typeof rawSdk.persist_session === 'boolean') sdk.persist_session = rawSdk.persist_session;
    if (Object.keys(sdk).length > 0) out.sdk_options = sdk;
  }
  if (isClaude && raw.channel_options && typeof raw.channel_options === 'object' && !Array.isArray(raw.channel_options)) {
    const rawChannel = raw.channel_options as Record<string, unknown>;
    const channel: NonNullable<ProviderOverrides['channel_options']> = {};
    if (typeof rawChannel.endpoint_url === 'string' && rawChannel.endpoint_url.trim()) channel.endpoint_url = rawChannel.endpoint_url;
    if (typeof rawChannel.api_key === 'string' && rawChannel.api_key.trim()) channel.api_key = rawChannel.api_key;
    if (typeof rawChannel.poll_interval_ms === 'number' && rawChannel.poll_interval_ms > 0) channel.poll_interval_ms = rawChannel.poll_interval_ms;
    if (typeof rawChannel.result_timeout_ms === 'number' && rawChannel.result_timeout_ms > 0) channel.result_timeout_ms = rawChannel.result_timeout_ms;
    if (rawChannel.response_schema && typeof rawChannel.response_schema === 'object' && !Array.isArray(rawChannel.response_schema)) {
      channel.response_schema = rawChannel.response_schema as Record<string, unknown>;
    }
    if (typeof rawChannel.isolation === 'string' && ['external', 'one-job-per-worker', 'shared-session'].includes(rawChannel.isolation)) {
      channel.isolation = rawChannel.isolation as NonNullable<ProviderOverrides['channel_options']>['isolation'];
    }
    if (Object.keys(channel).length > 0) out.channel_options = channel;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}


function substituteEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_, varName) => {
    return process.env[varName] ?? '';
  });
}

function envPort(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function defaultProviderConfig(
  cliPath: string,
  defaultModel: string,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: cliPath,
    default_model: defaultModel,
    max_concurrent: maxConcurrent,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    extra_args: [],
  };
}


const BUILTIN_DEFAULTS: Record<string, {
  cliPath: string;
  defaultModel: string;
  maxConcurrent?: number;
}> = {
  claude: { cliPath: 'claude', defaultModel: 'claude-sonnet-4-6' },
  codex: { cliPath: 'codex', defaultModel: '' },
  agy: { cliPath: 'agy', defaultModel: 'antigravity' },
  grok: { cliPath: 'grok', defaultModel: 'grok-4.5', maxConcurrent: 1 },
};

export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath = configPath ?? resolve(process.cwd(), 'config.yaml');

  let rawConfig: unknown = {};

  if (existsSync(resolvedPath)) {
    const content = readFileSync(resolvedPath, 'utf-8');
    const substituted = substituteEnvVars(content);
    rawConfig = parseYaml(substituted) ?? {};
  }


  const parsed = rawConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(
      `Config validation failed (${resolvedPath}):\n${z.prettifyError(parsed.error)}`,
    );
  }

  const {
    server,
    dashboard,
    database,
    auth,
    providers,
    rate_limits: rateLimits,
    cache,
    validation,
    model_mappings: modelMappings,
  } = parsed.data;

  const globalLimits = rateLimits?.global;
  const perProvider = rateLimits?.per_provider;

  const initialKeys = auth?.initial_keys ?? [];


  const providerConfigs: Record<string, ProviderConfigYaml> = {};
  for (const [name, defaults] of Object.entries(BUILTIN_DEFAULTS)) {
    providerConfigs[name] = mergeProviderConfig(
      providers?.[name], defaults.cliPath, defaults.defaultModel, defaults.maxConcurrent,
    );
  }


  if (providers) {
    for (const [name, raw] of Object.entries(providers)) {
      if (name in BUILTIN_DEFAULTS) continue;
      providerConfigs[name] = mergeProviderConfig(raw, name, '');
    }
  }


  const perProviderConfig: Record<string, { rpm: number }> = {};
  for (const name of Object.keys(providerConfigs)) {
    perProviderConfig[name] = { rpm: perProvider?.[name]?.rpm ?? 20 };
  }

  return {
    server: {
      port: envPort('AGENT_PROXY_PORT') ?? server?.port ?? DEFAULT_SERVER_PORT,
      host: process.env.AGENT_PROXY_HOST ?? server?.host ?? DEFAULT_HOST,
      cors: {
        origins: server?.cors?.origins ?? [`http://localhost:${DEFAULT_DASHBOARD_PORT}`],
      },
    },
    dashboard: {
      port: dashboard?.port ?? DEFAULT_DASHBOARD_PORT,
      host: dashboard?.host ?? DEFAULT_HOST,
    },
    database: {

      path: resolve(
        dirname(resolvedPath),
        process.env.AGENT_PROXY_DATABASE_PATH ?? database?.path ?? './data/agent-proxy.db',
      ),
    },
    auth: {
      enabled: auth?.enabled ?? true,
      adminToken: auth?.admin_token ?? process.env.ADMIN_TOKEN ?? '',
      initialKeys: initialKeys.map((k) => ({
        name: k.name ?? 'default',
        key: k.key ?? process.env.PROXY_API_KEY ?? '',
      })),
    },
    providers: providerConfigs,
    rateLimits: {
      global: {
        rpm: globalLimits?.rpm ?? DEFAULT_RATE_LIMIT_RPM,
        rpd: globalLimits?.rpd ?? DEFAULT_RATE_LIMIT_RPD,
      },
      perProvider: perProviderConfig,
    },
    cache: {
      enabled: cache?.enabled ?? true,
      ttlSeconds: cache?.ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS,
      maxEntries: cache?.max_entries ?? DEFAULT_CACHE_MAX_ENTRIES,
    },
    validation: {
      maxMessageCount: validation?.max_message_count ?? DEFAULT_MAX_MESSAGE_COUNT,
      maxMessageLength: validation?.max_message_length ?? DEFAULT_MAX_MESSAGE_LENGTH,
      maxPromptLength: validation?.max_prompt_length ?? DEFAULT_MAX_PROMPT_LENGTH,
      maxResponseLength: validation?.max_response_length ?? DEFAULT_MAX_RESPONSE_LENGTH,
      bodyLimitBytes: validation?.body_limit_bytes ?? DEFAULT_BODY_LIMIT_BYTES,
    },
    modelMappings: modelMappings?.map((m) => ({
      alias: m.alias,
      provider: m.provider,
      actual_model: m.actual_model ?? '',
      reasoning_effort: normalizeReasoningEffort(m.reasoning_effort),
      provider_overrides: normalizeProviderOverrides(m.provider_overrides, m.provider),
    })) ?? [
      { alias: 'claude-sonnet', provider: 'claude', actual_model: 'claude-sonnet-4-6' },
      { alias: 'claude-haiku', provider: 'claude', actual_model: 'claude-haiku-4-5-20251001' },
      { alias: 'gpt-5.5', provider: 'codex', actual_model: 'gpt-5.5' },
      { alias: 'gpt-5.4-mini', provider: 'codex', actual_model: 'gpt-5.4-mini' },
      { alias: 'antigravity', provider: 'agy', actual_model: 'antigravity' },
      { alias: 'grok-build', provider: 'grok', actual_model: 'grok-4.5' },
    ],
  };
}

function mergeProviderConfig(
  raw: RawProviderConfig | undefined,
  cliPath: string,
  defaultModel: string,
  maxConcurrent?: number,
): ProviderConfigYaml {
  const defaults = defaultProviderConfig(cliPath, defaultModel, maxConcurrent);
  if (!raw) return defaults;


  const appServerOptions = raw.app_server_options
    ? { ...raw.app_server_options, transport: raw.app_server_options.transport ?? 'stdio' as const }
    : undefined;

  return {
    enabled: raw.enabled ?? defaults.enabled,
    cli_path: raw.cli_path ?? defaults.cli_path,
    default_model: raw.default_model ?? defaults.default_model,
    max_concurrent: raw.max_concurrent ?? defaults.max_concurrent,
    timeout_ms: raw.timeout_ms ?? defaults.timeout_ms,
    extra_args: raw.extra_args ?? defaults.extra_args,
    working_dir: raw.working_dir ?? undefined,
    mode: raw.mode ?? undefined,
    sdk_options: raw.sdk_options,
    channel_options: raw.channel_options,
    app_server_options: appServerOptions,
    cli_options: raw.cli_options,
  };
}
