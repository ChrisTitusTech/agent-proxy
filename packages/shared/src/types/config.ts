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

export interface HerdrConfig {
  binary: string;
  runtimeDirectory: string;
  workspaceLabel: string;
  commandTimeoutMs: number;
  paneTtlMs: number;
  maxPanes: number;
}

export interface AuthConfig {
  enabled: boolean;
  adminToken: string;
  initialKeys: Array<{
    name: string;
    key: string;
  }>;
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
  max_queue_size?: number;
  max_queue_wait_ms?: number;
  timeout_ms: number;
  extra_args: string[];
  working_dir?: string;
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

export interface ResponsesConfig {
  retentionTtlMs: number;
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
  extra_args?: string[];
  timeout_ms?: number;
  working_dir?: string;
  cli_options?: Partial<CodexCliOptions>;
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
  'extra_args',
  'timeout_ms',
  'working_dir',
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
  herdr: HerdrConfig;
  auth: AuthConfig;
  providers: Record<string, ProviderConfigYaml>;
  rateLimits: RateLimitConfig;
  cache: CacheConfig;
  responses: ResponsesConfig;
  validation: ValidationConfig;
  modelMappings: ModelMappingSeed[];
}
