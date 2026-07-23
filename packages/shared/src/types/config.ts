import type { ReasoningEffort } from './provider.js';

export interface ServerConfig {
  port: number;
  host: string;
  cors: {
    origins: string[];
  };
}

export interface DashboardConfig {
  port: number;
  host: string;
}

export interface DatabaseConfig {
  path: string;
}

export interface AuthConfig {
  enabled: boolean;
  adminToken: string;
  initialKeys: Array<{
    name: string;
    key: string;
  }>;
}


export interface ClaudeSdkOptions {
  max_turns?: number;
  permission_mode?: string;        // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  allowed_tools?: string[];
  disallowed_tools?: string[];
  max_budget_usd?: number;
  session_ttl_ms?: number;
  enable_session_reuse?: boolean;
  persist_session?: boolean;
}




export interface ClaudeChannelOptions {
  endpoint_url?: string;
  api_key?: string;
  poll_interval_ms?: number;
  result_timeout_ms?: number;
  response_schema?: Record<string, unknown>;
  isolation?: 'external' | 'one-job-per-worker' | 'shared-session';

  managed?: boolean;
  auto_start?: boolean;
  bridge_port?: number;
  bridge_command?: string;
}


export interface CodexAppServerOptions {
  transport?: 'stdio' | 'websocket';
  websocket_url?: string;
  session_ttl_ms?: number;
  enable_session_reuse?: boolean;
  max_turns?: number;
  auto_restart?: boolean;
  max_restart_count?: number;
}


export interface CodexCliOptions {
  ephemeral?: boolean;
  enable_session_reuse?: boolean;
  session_ttl_ms?: number;
}

export interface ProviderConfigYaml {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
  working_dir?: string;
  mode?: 'cli' | 'sdk' | 'app-server' | 'channel-worker';
  sdk_options?: ClaudeSdkOptions;
  channel_options?: ClaudeChannelOptions;
  app_server_options?: CodexAppServerOptions;
  cli_options?: CodexCliOptions;
}

export interface RateLimitConfig {
  global: {
    rpm: number;
    rpd: number;
  };
  perProvider: Record<string, { rpm: number }>;
}

export interface CacheConfig {
  enabled: boolean;
  ttlSeconds: number;
  maxEntries: number;
}

export interface ModelMappingSeed {
  alias: string;
  provider: string;
  actual_model: string;
  reasoning_effort?: ReasoningEffort;
  provider_overrides?: ProviderOverrides;
}



export interface ProviderOverrides {
  mode?: ProviderConfigYaml['mode'];
  extra_args?: string[];
  timeout_ms?: number;
  working_dir?: string;
  cli_options?: Partial<CodexCliOptions>;
  sdk_options?: Partial<ClaudeSdkOptions>;
  channel_options?: Partial<ClaudeChannelOptions>;
}



export const CODEX_OVERRIDE_ALLOWED_KEYS = [
  'extra_args',
  'timeout_ms',
  'working_dir',
  'cli_options.ephemeral',
  'cli_options.enable_session_reuse',
  'cli_options.session_ttl_ms',
] as const;
export type CodexOverrideKey = typeof CODEX_OVERRIDE_ALLOWED_KEYS[number];

export const CLAUDE_OVERRIDE_ALLOWED_KEYS = [
  'mode',
  'extra_args',
  'timeout_ms',
  'working_dir',
  'sdk_options.max_turns',
  'sdk_options.permission_mode',
  'sdk_options.allowed_tools',
  'sdk_options.disallowed_tools',
  'sdk_options.max_budget_usd',
  'sdk_options.session_ttl_ms',
  'sdk_options.enable_session_reuse',
  'sdk_options.persist_session',
  'channel_options.endpoint_url',
  'channel_options.api_key',
  'channel_options.poll_interval_ms',
  'channel_options.result_timeout_ms',
  'channel_options.response_schema',
  'channel_options.isolation',
] as const;
export type ClaudeOverrideKey = typeof CLAUDE_OVERRIDE_ALLOWED_KEYS[number];

export interface ValidationConfig {
  maxMessageCount: number;
  maxMessageLength: number;
  maxPromptLength: number;
  maxResponseLength: number;
  bodyLimitBytes: number;
}

export interface AppConfig {
  server: ServerConfig;
  dashboard: DashboardConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
  providers: Record<string, ProviderConfigYaml>;
  rateLimits: RateLimitConfig;
  cache: CacheConfig;
  validation: ValidationConfig;
  modelMappings: ModelMappingSeed[];
}
