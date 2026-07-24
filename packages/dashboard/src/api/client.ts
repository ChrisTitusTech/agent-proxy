import { getStoredAdminToken } from '../auth/token';

const BASE_URL = '/admin';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> };
  const adminToken = getStoredAdminToken();

  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (adminToken) {
    headers['x-admin-token'] = adminToken;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('Admin token required or invalid.');
    }
    const error = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(error.error?.message ?? `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}


export interface DashboardData {
  overview: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    successRate: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    streamCount: number;
  };
  today: {
    count: number;
    successCount: number;
    avgLatencyMs: number;
  };
  apiKeys: { total: number; active: number };
  modelMappings: { total: number; active: number };
  providers: Array<{
    name: string;
    kind: 'builtin' | 'http' | 'cli';
    status: string;
    lastCheckAt: string | null;
    consecutiveFailures: number;
    queue: { pending: number; size: number; concurrency: number } | null;
  }>;
  cache: { totalEntries: number; activeEntries: number };
  rateLimits: { global: { rpm: number; rpd: number }; perProvider: Record<string, { rpm: number }> };
  providerStats: Array<{
    provider: string;
    count: number;
    successCount: number;
    errorCount: number;
    successRate: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    totalTokens: number;
  }>;
  popularModels: Array<{
    modelAlias: string;
    provider: string;
    count: number;
    successCount: number;
    successRate: number;
    avgLatencyMs: number;
  }>;
  hourlyTrend: Array<{ hour: number; count: number; successCount: number; errorCount: number; tokens: number }>;
  hourlyByModel: Array<{ hour: number; modelAlias: string; count: number }>;
  recentRequests: Array<{
    id: string;
    modelAlias: string;
    provider: string;
    actualModel: string;
    reasoningEffort: string | null;
    status: string;
    latencyMs: number;
    totalTokens: number | null;
    isStream: boolean;
    errorMessage: string | null;
    createdAt: string;
  }>;
  recentErrors: Array<{
    id: string;
    modelAlias: string;
    provider: string;
    reasoningEffort: string | null;
    status: string;
    errorMessage: string | null;
    latencyMs: number;
    createdAt: string;
  }>;
  activeRequests: {
    count: number;
    requests: Array<{
      requestId: string;
      modelAlias: string;
      provider: string;
      actualModel: string;
      reasoningEffort?: string | null;
      isStream: boolean;
      startedAt: number;
      elapsedMs: number;
    }>;
  };
}

export function fetchDashboard(days?: number) {
  const qs = days ? `?days=${days}` : '';
  return request<DashboardData>(`/dashboard${qs}`);
}


export interface TrendData {
  hours: number;
  trend: Array<{ slot: string; count: number; successCount: number; errorCount: number; tokens: number }>;
  byModel: Array<{ slot: string; modelAlias: string; count: number }>;
}

export function fetchTrend(hours = 24) {
  return request<TrendData>(`/trend?hours=${hours}`);
}

// Logs
export function fetchLogs(params?: { limit?: number; offset?: number }) {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return request<{
    data: Array<{
      id: string;
      requestId: string;
      modelAlias: string;
      provider: string;
      actualModel: string;
      status: string;
      latencyMs: number;
      ttfbMs: number | null;
      isStream: boolean;
      totalTokens: number | null;
      errorMessage: string | null;
      createdAt: string;
    }>;
    pagination: { limit: number; offset: number; total: number };
  }>(`/logs${qs ? `?${qs}` : ''}`);
}


export function deleteLogsByAge(days: number) {
  return request<{ deleted: number; cutoffDate: string; days: number }>(`/logs?days=${days}`, {
    method: 'DELETE',
  });
}

// Model Mappings
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';


export interface ProviderOverrides {
  mode?: 'cli' | 'sdk' | 'app-server' | 'channel-worker';
  extra_args?: string[];
  timeout_ms?: number;
  working_dir?: string;
  cli_options?: {
    ephemeral?: boolean;
    enable_session_reuse?: boolean;
    session_ttl_ms?: number;
  };
  sdk_options?: Partial<ClaudeSdkOptions>;
  channel_options?: Partial<ClaudeChannelOptions>;
}

export interface ModelMapping {
  id: string;
  alias: string;
  provider: string;
  actualModel: string;
  displayName: string | null;
  reasoningEffort: ReasoningEffort | null;
  providerOverrides: ProviderOverrides | null;

  includeReasoning: boolean | null;

  extraBody: Record<string, unknown> | null;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchModelMappings() {
  return request<ModelMapping[]>('/model-mappings');
}

export function createModelMapping(data: {
  alias: string;
  provider: string;
  actual_model: string;
  display_name?: string;
  reasoning_effort?: ReasoningEffort | null;
  provider_overrides?: ProviderOverrides | null;
  include_reasoning?: boolean | null;
  extra_body?: Record<string, unknown> | null;
  priority?: number;
}) {
  return request<ModelMapping>('/model-mappings', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateModelMapping(id: string, data: Partial<{
  alias: string;
  provider: string;
  actual_model: string;
  display_name: string;
  reasoning_effort: ReasoningEffort | null;
  provider_overrides: ProviderOverrides | null;
  include_reasoning: boolean | null;
  extra_body: Record<string, unknown> | null;
  priority: number;
  enabled: boolean;
}>) {
  return request<ModelMapping>(`/model-mappings/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteModelMapping(id: string) {
  return request<void>(`/model-mappings/${id}`, { method: 'DELETE' });
}

// API Keys
export interface ApiKey {
  id: string;
  keyPrefix: string;
  name: string;
  enabled: boolean;
  rateLimitRpm: number | null;
  rateLimitRpd: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export function fetchApiKeys() {
  return request<ApiKey[]>('/api-keys');
}

export function createApiKey(data: { name: string; rate_limit_rpm?: number; rate_limit_rpd?: number }) {
  return request<{ id: string; key: string; key_prefix: string; name: string; message: string }>('/api-keys', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateApiKey(id: string, data: Partial<{ name: string; enabled: boolean; rate_limit_rpm: number | null; rate_limit_rpd: number | null }>) {
  return request<ApiKey>(`/api-keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function regenerateApiKey(id: string) {
  return request<{ id: string; key: string; key_prefix: string; name: string; message: string }>(`/api-keys/${id}/regenerate`, {
    method: 'POST',
  });
}

export function deleteApiKey(id: string) {
  return request<void>(`/api-keys/${id}`, { method: 'DELETE' });
}

// Providers
export interface ProviderInfo {
  name: string;
  status: string;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  queue: { pending: number; size: number; concurrency: number } | null;
}

export function fetchProviders() {
  return request<ProviderInfo[]>('/providers');
}

export interface ClaudeSdkOptions {
  max_turns?: number;
  permission_mode?: string;
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

export interface ProviderConfig {
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

export interface ProviderTestResult {
  success: boolean;
  response?: string;
  error?: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export function fetchProviderConfig(name: string) {
  return request<ProviderConfig>(`/providers/${name}/config`);
}



export interface CodexCliDefaults {
  configPath: string;
  exists: boolean;
  model: string | null;
  modelReasoningEffort: ReasoningEffort | null;
}

export function fetchCodexCliDefaults() {
  return request<CodexCliDefaults>('/providers/codex/cli-defaults');
}

export function updateProviderConfig(name: string, config: Partial<ProviderConfig>) {
  return request<ProviderConfig>(`/providers/${name}`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export function testProvider(name: string) {
  return request<ProviderTestResult>(`/providers/${name}/test`, {
    method: 'POST',
  });
}


export interface ChannelBridgeStatus {
  running: boolean;
  managed: boolean;
  pid?: number;
  port?: number;
  host?: string;
  uptimeMs?: number;
  healthy?: boolean;
  lastError?: string;
  command?: string;
}

export function fetchChannelBridgeStatus() {
  return request<ChannelBridgeStatus>('/providers/claude/channel-bridge/status');
}

export function startChannelBridge() {
  return request<ChannelBridgeStatus>('/providers/claude/channel-bridge/start', { method: 'POST' });
}

export function stopChannelBridge() {
  return request<ChannelBridgeStatus>('/providers/claude/channel-bridge/stop', { method: 'POST' });
}

export function restartChannelBridge() {
  return request<ChannelBridgeStatus>('/providers/claude/channel-bridge/restart', { method: 'POST' });
}

// Test Model
export interface TestModelResult {
  success: boolean;
  provider: string;
  model: string;
  response?: string;
  error?: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export function testModel(provider: string, actual_model: string, signal?: AbortSignal) {
  return request<TestModelResult>('/test-model', {
    method: 'POST',
    body: JSON.stringify({ provider, actual_model }),
    signal,
  });
}

// Rate Limits
export interface RateLimitsConfig {
  global: { rpm: number; rpd: number };
  perProvider: Record<string, { rpm: number }>;
}

export function fetchRateLimits() {
  return request<RateLimitsConfig>('/rate-limits');
}

export function updateRateLimits(config: RateLimitsConfig) {
  return request<{ success: boolean; config: RateLimitsConfig }>('/rate-limits', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

// Debug
export interface DebugConfig {
  global: boolean;
  models: Record<string, boolean>;
}

export interface DebugLog {
  id: string;
  requestId: string;
  modelAlias: string;
  provider: string;
  actualModel: string;
  reasoningEffort: string | null;
  isStream: boolean;
  cliArgs: string | null;
  requestMessages: string | null;
  rawStdout: string | null;
  rawStderr: string | null;
  httpRequest: string | null;
  httpResponse: string | null;
  httpStreamLines: string | null;
  rawResponseText: string | null;
  parsedContent: string | null;
  tokenUsage: string | null;
  status: string;
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export function fetchDebugConfig() {
  return request<DebugConfig>('/debug');
}

export function updateDebugConfig(data: { global?: boolean; model?: string; enabled?: boolean }) {
  return request<DebugConfig>('/debug', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function fetchDebugLogs(params?: { limit?: number; offset?: number; model?: string; search?: string; searchScope?: 'all' | 'request' | 'response' }) {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  if (params?.model) query.set('model', String(params.model));
  if (params?.search) query.set('search', String(params.search));
  if (params?.searchScope && params.searchScope !== 'all') query.set('searchScope', params.searchScope);
  const qs = query.toString();
  return request<{ data: DebugLog[]; pagination: { limit: number; offset: number; total: number } }>(
    `/debug-logs${qs ? `?${qs}` : ''}`,
  );
}

export function deleteDebugLog(id: string) {
  return request<{ success: boolean }>(`/debug-logs/${id}`, { method: 'DELETE' });
}

export function deleteDebugLogsBatch(ids: string[]) {
  return request<{ deleted: number }>('/debug-logs/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export function clearDebugLogs() {
  return request<{ deleted: number }>('/debug-logs', { method: 'DELETE' });
}

// Export/Import
export interface ExportData {
  version: number;
  exportedAt: string;
  modelMappings: Array<{
    alias: string;
    provider: string;
    actualModel: string;
    displayName: string | null;
    priority: number;
    enabled: boolean;
  }>;
  rateLimits: { global: { rpm: number; rpd: number }; perProvider: Record<string, { rpm: number }> };
  validation: {
    maxMessageCount: number;
    maxMessageLength: number;
    maxPromptLength: number;
    maxResponseLength: number;
    bodyLimitBytes: number;
  };
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

export interface ImportResult {
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

export function fetchExport() {
  return request<ExportData>('/export');
}

export function importConfig(data: ExportData) {
  return request<ImportResult>('/import', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Settings
export interface ValidationSettings {
  maxMessageCount: number;
  maxMessageLength: number;
  maxPromptLength: number;
  maxResponseLength: number;
  bodyLimitBytes: number;
}

export function fetchValidationSettings() {
  return request<ValidationSettings>('/settings/validation');
}

export function updateValidationSettings(data: Partial<ValidationSettings>) {
  return request<ValidationSettings>('/settings/validation', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}


export interface ServerInfo {
  serverPort: number;
  serverHost: string;
  dashboardPort: number;
  dashboardHost: string;
}

export function fetchServerInfo() {
  return request<ServerInfo>('/server-info');
}


export interface GenericCliProviderConfig {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
  working_dir?: string;

  prompt_mode: 'stdin' | 'arg';
  prompt_arg_template?: string;

  args_template: string[];

  output_mode: 'plain_text' | 'json_field';
  output_json_content_field?: string;

  streaming_enabled: boolean;
  stream_args_template?: string[];
  stream_content_field?: string;
  stream_done_indicator?: string;

  health_check_args?: string[];

  display_name: string;
  description?: string;
}

export interface GenericProviderInfo {
  name: string;
  config: GenericCliProviderConfig;
}

export function fetchGenericProviders() {
  return request<GenericProviderInfo[]>('/generic-providers');
}

export function createGenericProvider(data: { name: string } & GenericCliProviderConfig) {
  return request<GenericProviderInfo>('/generic-providers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateGenericProvider(name: string, data: Partial<GenericCliProviderConfig>) {
  return request<GenericProviderInfo>(`/generic-providers/${name}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteGenericProvider(name: string) {
  return request<{ success: boolean }>(`/generic-providers/${name}`, { method: 'DELETE' });
}


export function testGenericProvider(data: { name?: string } & GenericCliProviderConfig) {
  return request<ProviderTestResult>('/generic-providers/test', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}


export type EndpointType = 'chat' | 'images' | 'tts' | 'embeddings' | 'rerank';

export interface HttpProviderConfig {
  enabled: boolean;
  base_url: string;
  allow_private_network?: boolean;
  api_key?: string;
  custom_headers?: Record<string, string>;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;

  endpoint_type?: EndpointType;
  display_name: string;
  description?: string;
}

export interface HttpProviderInfo {
  name: string;
  config: HttpProviderConfig;
}

export function fetchHttpProviders() {
  return request<HttpProviderInfo[]>('/http-providers');
}

export function createHttpProvider(data: { name: string } & Partial<HttpProviderConfig>) {
  return request<HttpProviderInfo>('/http-providers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateHttpProvider(name: string, data: Partial<HttpProviderConfig>) {
  return request<HttpProviderInfo>(`/http-providers/${name}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteHttpProvider(name: string) {
  return request<{ success: boolean }>(`/http-providers/${name}`, { method: 'DELETE' });
}

export function testHttpProvider(data: { name?: string } & Partial<HttpProviderConfig>) {
  return request<ProviderTestResult>('/http-providers/test', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export interface EndpointDetectResult {
  detected: EndpointType | null;
  source: 'probe' | 'heuristic' | 'none';
  results: Array<{ type: EndpointType; ok: boolean; status: number | null; error?: string }>;
}


export function detectHttpProviderEndpoint(data: { name?: string } & Partial<HttpProviderConfig>) {
  return request<EndpointDetectResult>('/http-providers/detect', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}



function inferEndpointTypeFromName(...names: Array<string | null | undefined>): EndpointType | null {
  const s = names.filter(Boolean).join(' ').toLowerCase();
  if (!s) return null;
  if (/(rerank|reranker|cross-?encoder)/.test(s)) return 'rerank';
  if (/(embed|embedding|kure|bge-m3|gte-|e5-|text-embedding|nomic-embed|jina-embed)/.test(s)) return 'embeddings';
  if (/(\btts\b|text-to-speech|speech|xtts|piper|kokoro|\bvoice\b)/.test(s)) return 'tts';
  if (/(\bimage\b|images|imagen|dall-?e|sdxl|stable-?diffusion|\bflux\b|nano-banana)/.test(s)) return 'images';
  return null;
}


export function effectiveEndpointType(
  explicit: EndpointType | null | undefined,
  ...names: Array<string | null | undefined>
): EndpointType {
  if (explicit) return explicit;
  return inferEndpointTypeFromName(...names) ?? 'chat';
}
