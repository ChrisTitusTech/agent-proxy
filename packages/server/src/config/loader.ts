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
  DEFAULT_RESPONSES_RETENTION_TTL_MS,
  DEFAULT_RESPONSES_MAX_ENTRIES,
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
  const isCodex = provider === 'codex';
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
    max_queue_size: 32,
    max_queue_wait_ms: 30_000,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    extra_args: [],
  };
}


const BUILTIN_DEFAULTS: Record<string, {
  cliPath: string;
  defaultModel: string;
  maxConcurrent?: number;
}> = {
  claude: { cliPath: 'claude', defaultModel: 'claude-sonnet-5' },
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


  const parsed = rawConfigSchema.safeParse(stripLegacyProviderModeKeys(rawConfig));
  if (!parsed.success) {
    throw new Error(
      `Config validation failed (${resolvedPath}):\n${z.prettifyError(parsed.error)}`,
    );
  }

  const {
    server,
    dashboard,
    database,
    herdr,
    auth,
    providers,
    rate_limits: rateLimits,
    cache,
    responses,
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
    herdr: {
      binary: herdr?.binary ?? 'herdr',
      runtimeDirectory: resolve(
        herdr?.runtime_directory
          ?? (process.env.XDG_RUNTIME_DIR
            ? resolve(process.env.XDG_RUNTIME_DIR, 'agent-proxy')
            : resolve(
              process.env.XDG_STATE_HOME
                ?? (process.env.HOME
                  ? resolve(process.env.HOME, '.local', 'state')
                  : resolve(dirname(resolvedPath), 'state')),
              'agent-proxy',
              'runtime',
            )),
      ),
      workspaceLabel: herdr?.workspace_label ?? 'agent-proxy',
      commandTimeoutMs: herdr?.command_timeout_ms ?? 10_000,
      paneTtlMs: herdr?.pane_ttl_ms ?? 30 * 60 * 1000,
      maxPanes: herdr?.max_panes ?? 32,
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
    responses: {
      retentionTtlMs: responses?.retention_ttl_ms ?? DEFAULT_RESPONSES_RETENTION_TTL_MS,
      maxEntries: responses?.max_entries ?? DEFAULT_RESPONSES_MAX_ENTRIES,
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
      { alias: 'claude-sonnet-5', provider: 'claude', actual_model: 'claude-sonnet-5' },
      { alias: 'claude-haiku', provider: 'claude', actual_model: 'claude-haiku-4-5-20251001' },
      { alias: 'gpt-5.6-sol', provider: 'codex', actual_model: 'gpt-5.6-sol' },
      { alias: 'antigravity', provider: 'agy', actual_model: 'antigravity' },
      { alias: 'grok-build', provider: 'grok', actual_model: 'grok-4.5' },
    ],
  };
}

function stripLegacyProviderModeKeys(rawConfig: unknown): unknown {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return rawConfig;
  }
  const root = rawConfig as Record<string, unknown>;
  const providers = root.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return rawConfig;
  }
  const removed: string[] = [];
  for (const [provider, value] of Object.entries(providers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const providerConfig = value as Record<string, unknown>;
    for (const key of ['mode', 'sdk_options', 'channel_options', 'app_server_options']) {
      if (!(key in providerConfig)) continue;
      delete providerConfig[key];
      removed.push(`providers.${provider}.${key}`);
    }
  }
  if (removed.length > 0) {
    console.warn(
      `[config] Ignoring removed provider execution settings: ${removed.join(', ')}. `
      + 'All built-in CLI providers now run through the current-user Herdr service; '
      + 'remove these legacy keys from config.yaml.',
    );
  }
  return rawConfig;
}

function mergeProviderConfig(
  raw: RawProviderConfig | undefined,
  cliPath: string,
  defaultModel: string,
  maxConcurrent?: number,
): ProviderConfigYaml {
  const defaults = defaultProviderConfig(cliPath, defaultModel, maxConcurrent);
  if (!raw) return defaults;


  return {
    enabled: raw.enabled ?? defaults.enabled,
    cli_path: raw.cli_path ?? defaults.cli_path,
    default_model: raw.default_model ?? defaults.default_model,
    max_concurrent: raw.max_concurrent ?? defaults.max_concurrent,
    max_queue_size: raw.max_queue_size ?? defaults.max_queue_size,
    max_queue_wait_ms: raw.max_queue_wait_ms ?? defaults.max_queue_wait_ms,
    timeout_ms: raw.timeout_ms ?? defaults.timeout_ms,
    extra_args: raw.extra_args ?? defaults.extra_args,
    working_dir: raw.working_dir ?? undefined,
    cli_options: raw.cli_options,
  };
}
