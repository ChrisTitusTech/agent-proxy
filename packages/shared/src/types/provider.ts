

import type { ChatMessage, ChatCompletionTool, ToolChoice, ChatMessageToolCall } from './api.js';


export const BUILTIN_PROVIDERS = ['claude', 'codex', 'agy', 'grok'] as const;
export type BuiltinProviderName = typeof BUILTIN_PROVIDERS[number];

export type ProviderName = string;



export type EndpointType = 'chat' | 'images' | 'tts' | 'embeddings' | 'rerank';

export interface CliProviderConfig {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
  [key: string]: unknown;
}


export interface StreamParser {
  parse(line: string): StreamChunk | null;
  parseEvents?(line: string): ProviderEvent[];
}

export interface ProviderConfig {
  name: ProviderName;
  enabled: boolean;
  cliPath: string;
  defaultModel: string;
  maxConcurrent: number;
  timeoutMs: number;
  extraArgs: string[];
}

export interface DebugCaptureInfo {
  cliArgs: string[];
  stdout?: string;
  stderr?: string;
  streamLines?: string[];


  httpRequest?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  httpResponse?: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
  };
  httpStreamLines?: string[];


  rawResponseText?: string;
}

// Reasoning levels are translated to the native flags supported by each CLI.
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
  'low', 'medium', 'high', 'xhigh', 'max',
] as const;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string'
    && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export interface ExecuteOptions {
  messages: ChatMessage[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDebug?: (info: DebugCaptureInfo) => void;
  clientKey?: string;

  reasoningEffort?: ReasoningEffort;

  providerOverrides?: import('./config.js').ProviderOverrides;


  extraBody?: Record<string, unknown>;

  tools?: ChatCompletionTool[];
  toolChoice?: ToolChoice;
  // Image generation passthrough (OpenAI Images API)
  responseFormat?: 'url' | 'b64_json';
  n?: number;
  size?: string;
}


export interface ExecuteMeta {
  threadId?: string;
  threadReused?: boolean;
}


export interface EmbeddingOptions {
  model: string;
  input: string | string[];
  encodingFormat?: 'float' | 'base64';
  dimensions?: number;
  signal?: AbortSignal;
  providerOverrides?: import('./config.js').ProviderOverrides;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface EmbeddingResult {
  embeddings: number[][];
  model: string;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
}



export interface RerankOptions {
  model: string;
  query: string;
  documents: string[];
  topN?: number;
  returnDocuments?: boolean;
  signal?: AbortSignal;
  providerOverrides?: import('./config.js').ProviderOverrides;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface RerankResultItem {
  index: number;
  relevanceScore: number;
  document?: string;
}

export interface RerankResult {
  results: RerankResultItem[];
  model: string;
  usage: {
    totalTokens: number;
  };
}


export interface TtsOptions {
  model: string;
  input: string;
  voice: string;
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  signal?: AbortSignal;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface TtsResult {
  audio: Buffer;
  contentType: string;
}


export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ExecuteResult {
  content: string;
  reasoning?: string;
  toolCalls?: ChatMessageToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  meta?: ExecuteMeta;
}



export interface ProviderTextDeltaEvent {
  type: 'text_delta';
  text: string;
}

export interface ProviderToolUseEvent {
  type: 'tool_use';
  toolCallId: string;
  toolName: string;
  input: string;
  isPartial?: boolean;
  index?: number;
}

export interface ProviderThinkingEvent {
  type: 'thinking';
  text: string;
}

export interface ProviderUsageEvent {
  type: 'usage';
  usage: TokenUsage;
}

export interface ProviderErrorEvent {
  type: 'error';
  error: string;
  code?: string;
}

export interface ProviderDoneEvent {
  type: 'done';
  finishReason?: 'stop' | 'length' | 'tool_use' | 'error';
}



export interface ProviderThreadStartedEvent {
  type: 'thread_started';
  threadId: string;
}

export type ProviderEvent =
  | ProviderTextDeltaEvent
  | ProviderToolUseEvent
  | ProviderThinkingEvent
  | ProviderUsageEvent
  | ProviderErrorEvent
  | ProviderDoneEvent
  | ProviderThreadStartedEvent;

export interface StreamChunk {
  type: 'delta' | 'done' | 'error';
  content?: string;
  error?: string;
  usage?: TokenUsage;
}



export function streamChunkToEvents(chunk: StreamChunk): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  switch (chunk.type) {
    case 'delta':
      if (chunk.content) events.push({ type: 'text_delta', text: chunk.content });
      break;
    case 'error':
      events.push({ type: 'error', error: chunk.error ?? 'Unknown error' });
      break;
    case 'done':
      if (chunk.usage) events.push({ type: 'usage', usage: chunk.usage });
      events.push({ type: 'done' });
      break;
  }
  return events;
}

export function eventToStreamChunk(event: ProviderEvent): StreamChunk | null {
  switch (event.type) {
    case 'text_delta':     return { type: 'delta', content: event.text };
    case 'thinking':       return { type: 'delta', content: event.text };
    case 'error':          return { type: 'error', error: event.error };
    case 'done':           return { type: 'done' };
    case 'tool_use':       return null;
    case 'usage':          return null;
    case 'thread_started': return null;
    default:               return null;
  }
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';



export interface GenericCliProviderConfig extends CliProviderConfig {

  prompt_mode: 'stdin' | 'arg';
  prompt_arg_template?: string;


  args_template: string[];   // e.g. ["-m", "{model}", "--format", "json"]


  output_mode: 'plain_text' | 'json_field';
  output_json_content_field?: string;


  streaming_enabled: boolean;
  stream_args_template?: string[];
  stream_content_field?: string;   // ndjson content field
  stream_done_indicator?: string;  // e.g. "[DONE]"


  health_check_args?: string[];   // default: ["--version"]


  display_name: string;
  description?: string;
}


export interface HttpProviderConfig {
  enabled: boolean;
  base_url: string;           // e.g. "http://localhost:8080"
  allow_private_network?: boolean; // Required for localhost, LAN, and link-local targets.
  api_key?: string;           // Authorization: Bearer {api_key}
  custom_headers?: Record<string, string>;
  default_model: string;
  default_max_tokens?: number;
  max_concurrent: number;
  timeout_ms: number;



  endpoint_type?: EndpointType;


  display_name: string;
  description?: string;
}

export interface ProviderHealthInfo {
  provider: ProviderName;
  status: HealthStatus;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  errorMessage: string | null;
}
