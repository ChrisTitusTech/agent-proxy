import type {
  ExecuteOptions,
  ExecuteResult,
  EmbeddingOptions,
  EmbeddingResult,
  RerankOptions,
  RerankResult,
  TtsOptions,
  TtsResult,
  ProviderEvent,
  HealthStatus,
  ProviderConfigYaml,
  HttpProviderConfig,
  DebugCaptureInfo,
} from '@agent-proxy/shared';
import { BaseProvider } from './base-provider.js';
import {
  clampHttpTimeoutMs,
  safeOutboundFetch,
  stripTrailingSlashes,
} from '../utils/outbound-http.js';

function scheduleAbort(controller: AbortController, timeoutMs: number): () => void {
  const deadline = Date.now() + clampHttpTimeoutMs(timeoutMs);
  const intervalId = setInterval(() => {
    if (Date.now() >= deadline) {
      clearInterval(intervalId);
      controller.abort();
    }
  }, 1_000);
  intervalId.unref();
  return () => clearInterval(intervalId);
}

export class HttpProvider extends BaseProvider {
  readonly name: string;
  override readonly endpointTypes = ['chat', 'embeddings', 'tts', 'rerank'] as const;
  private httpConfig: HttpProviderConfig;

  constructor(providerName: string, httpConfig: HttpProviderConfig) {

    const baseConfig: ProviderConfigYaml = {
      enabled: httpConfig.enabled,
      cli_path: '',
      default_model: httpConfig.default_model,
      max_concurrent: httpConfig.max_concurrent,
      timeout_ms: httpConfig.timeout_ms,
      extra_args: [],
    };
    super(baseConfig);
    this.name = providerName;
    this.httpConfig = httpConfig;

    this.parser = { parse: () => null };
  }


  protected buildArgs(): string[] {
    return [];
  }

  updateConfig(partial: Partial<ProviderConfigYaml>): void {
    super.updateConfig(partial);

    if ('enabled' in partial) this.httpConfig.enabled = partial.enabled!;
    if ('default_model' in partial) this.httpConfig.default_model = partial.default_model!;
    if ('max_concurrent' in partial) this.httpConfig.max_concurrent = partial.max_concurrent!;
    if ('timeout_ms' in partial) this.httpConfig.timeout_ms = partial.timeout_ms!;
  }

  updateHttpConfig(partial: Partial<HttpProviderConfig>): void {
    Object.assign(this.httpConfig, partial);

    super.updateConfig({
      enabled: this.httpConfig.enabled,
      default_model: this.httpConfig.default_model,
      max_concurrent: this.httpConfig.max_concurrent,
      timeout_ms: this.httpConfig.timeout_ms,
    });
  }

  getHttpConfig(): HttpProviderConfig {
    return { ...this.httpConfig };
  }





  private buildUrl(path: string): string {
    const base = stripTrailingSlashes(this.httpConfig.base_url);
    return `${base}${path}`;
  }

  private get timeoutMs(): number {
    return clampHttpTimeoutMs(this.httpConfig.timeout_ms);
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    return safeOutboundFetch(url, init, this.httpConfig.allow_private_network === true);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.httpConfig.api_key) {
      headers['Authorization'] = `Bearer ${this.httpConfig.api_key}`;
    }
    if (this.httpConfig.custom_headers) {
      Object.assign(headers, this.httpConfig.custom_headers);
    }
    return headers;
  }


  private static readonly RESERVED_BODY_KEYS = new Set([
    'model', 'messages', 'stream', 'max_tokens', 'temperature', 'tools', 'tool_choice',
    'parallel_tool_calls',
  ]);

  private buildRequestBody(options: ExecuteOptions, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,


      messages: options.messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.name !== undefined) msg.name = m.name;
        if (m.tool_call_id !== undefined) msg.tool_call_id = m.tool_call_id;
        if (m.tool_calls !== undefined) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      stream,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
      if (options.parallelToolCalls !== undefined) {
        body.parallel_tool_calls = options.parallelToolCalls;
      }
    }

    const maxTokens = options.maxTokens ?? this.httpConfig.default_max_tokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;



    if (options.extraBody && typeof options.extraBody === 'object') {
      for (const [key, value] of Object.entries(options.extraBody)) {
        if (HttpProvider.RESERVED_BODY_KEYS.has(key)) continue;
        if (value === undefined) continue;
        body[key] = value;
      }
    }
    return body;
  }



  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const url = this.buildUrl('/chat/completions');
    const headers = this.buildHeaders();
    const body = this.buildRequestBody(options, false);

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutMs = this.timeoutMs;
    const cancelTimeout = scheduleAbort(controller, timeoutMs);


    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let responseBody: OpenAIChatCompletionResponse;
      try {
        responseBody = JSON.parse(rawText) as OpenAIChatCompletionResponse;
      } catch {

        debugInfo.rawResponseText = rawText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name}: Invalid JSON response: ${rawText.slice(0, 200)}`);
      }

      debugInfo.rawResponseText = rawText;
      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };

      if (!response.ok) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        const errMsg = (responseBody as Record<string, unknown>).error
          ? JSON.stringify((responseBody as Record<string, unknown>).error)
          : `HTTP ${response.status}`;
        throw new Error(`${this.name} HTTP error: ${errMsg}`);
      }

      options.onDebug?.(debugInfo as DebugCaptureInfo);

      const choice = responseBody.choices?.[0];
      const msg = choice?.message;


      const rawContent = msg?.content ?? '';
      const rawReasoning = msg?.reasoning_content ?? msg?.reasoning ?? '';
      const content = rawContent || rawReasoning || '';
      const reasoning = rawContent ? rawReasoning : '';
      const usage = responseBody.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };


      const toolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
        ? msg.tool_calls.map((tc) => ({
            id: tc.id ?? '',
            type: 'function' as const,
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
            ...(typeof tc.index === 'number' ? { index: tc.index } : {}),
          }))
        : undefined;

      return {
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        },
        finishReason: mapFinishReason(choice?.finish_reason),
      };
    } catch (error) {
      cancelTimeout();
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${timeoutMs}ms`);
      }

      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      cancelTimeout();
    }
  }



  async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const url = this.buildUrl('/chat/completions');
    const headers = this.buildHeaders();
    const body = this.buildRequestBody(options, true);

    const streamLines: string[] = [];
    const captureDebug = !!options.onDebug;

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutMs = this.timeoutMs;
    const cancelTimeout = scheduleAbort(controller, timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        debugInfo.rawResponseText = errorBody;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: errorBody,
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name} HTTP error: ${response.status} ${errorBody.slice(0, 200)}`);
      }

      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };

      if (!response.body) {
        throw new Error(`${this.name}: No response body for streaming request`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');

          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (captureDebug) streamLines.push(trimmed);

            const events = parseSSELineToEvents(trimmed);
            for (const event of events) {
              yield event;
              if (event.type === 'done') return;
            }
          }
        }


        if (buffer.trim()) {
          if (captureDebug) streamLines.push(buffer.trim());
          const events = parseSSELineToEvents(buffer.trim());
          for (const event of events) yield event;
        }
      } finally {



        await reader.cancel().catch(() => {});
      }
    } finally {
      cancelTimeout();
      if (captureDebug) {
        debugInfo.httpStreamLines = streamLines;
        debugInfo.rawResponseText = streamLines.join('\n');
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
    }
  }



  async executeEmbedding(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const url = this.buildUrl('/embeddings');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> = {
      model: options.model,
      input: options.input,
    };
    if (options.encodingFormat) body.encoding_format = options.encodingFormat;
    if (options.dimensions) body.dimensions = options.dimensions;

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutMs = this.timeoutMs;
    const cancelTimeout = scheduleAbort(controller, timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let responseBody: OpenAIEmbeddingResponse;
      try {
        responseBody = JSON.parse(rawText) as OpenAIEmbeddingResponse;
      } catch {
        debugInfo.rawResponseText = rawText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name}: Invalid JSON response: ${rawText.slice(0, 200)}`);
      }

      debugInfo.rawResponseText = rawText;
      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };

      if (!response.ok) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        const errMsg = (responseBody as Record<string, unknown>).error
          ? JSON.stringify((responseBody as Record<string, unknown>).error)
          : `HTTP ${response.status}`;
        throw new Error(`${this.name} HTTP error: ${errMsg}`);
      }

      options.onDebug?.(debugInfo as DebugCaptureInfo);

      const embeddings = (responseBody.data ?? [])
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
      const usage = responseBody.usage ?? { prompt_tokens: 0, total_tokens: 0 };

      return {
        embeddings,
        model: responseBody.model ?? options.model,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0),
        },
      };
    } catch (error) {
      cancelTimeout();
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${timeoutMs}ms`);
      }
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      cancelTimeout();
    }
  }






  async executeRerank(options: RerankOptions): Promise<RerankResult> {
    const url = this.buildUrl('/rerank');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> = {
      query: options.query,
      texts: options.documents,
    };
    if (options.returnDocuments) body.return_text = true;

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutMs = this.timeoutMs;
    const cancelTimeout = scheduleAbort(controller, timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let responseBody: TeiRerankResponse;
      try {
        responseBody = JSON.parse(rawText) as TeiRerankResponse;
      } catch {
        debugInfo.rawResponseText = rawText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name}: Invalid JSON response: ${rawText.slice(0, 200)}`);
      }

      debugInfo.rawResponseText = rawText;
      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };

      if (!response.ok) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        const errObj = (responseBody as unknown as Record<string, unknown>)?.error;
        const errMsg = errObj ? JSON.stringify(errObj) : `HTTP ${response.status}`;
        throw new Error(`${this.name} HTTP error: ${errMsg}`);
      }

      options.onDebug?.(debugInfo as DebugCaptureInfo);

      const items = Array.isArray(responseBody) ? responseBody : [];
      let results = items.map((item) => ({
        index: item.index,
        relevanceScore: item.score,
        ...(options.returnDocuments && typeof item.text === 'string' ? { document: item.text } : {}),
      }));


      results.sort((a, b) => b.relevanceScore - a.relevanceScore);

      if (typeof options.topN === 'number' && options.topN > 0) {
        results = results.slice(0, options.topN);
      }


      const approxTokens = Math.ceil(
        (options.query.length + options.documents.reduce((sum, d) => sum + d.length, 0)) / 4,
      );

      return {
        results,
        model: options.model,
        usage: {
          totalTokens: approxTokens,
        },
      };
    } catch (error) {
      cancelTimeout();
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${timeoutMs}ms`);
      }
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      cancelTimeout();
    }
  }



  async executeTts(options: TtsOptions): Promise<TtsResult> {
    const url = this.buildUrl('/audio/speech');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> = {
      model: options.model,
      input: options.input,
      voice: options.voice,
    };
    if (options.responseFormat) body.response_format = options.responseFormat;
    if (options.speed !== undefined) body.speed = options.speed;

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutMs = this.timeoutMs;
    const cancelTimeout = scheduleAbort(controller, timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        debugInfo.rawResponseText = errorText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name} HTTP error: ${response.status} ${errorText.slice(0, 200)}`);
      }

      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      const arrayBuffer = await response.arrayBuffer();
      const audio = Buffer.from(arrayBuffer);

      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };
      options.onDebug?.(debugInfo as DebugCaptureInfo);

      return { audio, contentType };
    } catch (error) {
      cancelTimeout();
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${timeoutMs}ms`);
      }
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      cancelTimeout();
    }
  }

  // === Health Check ===

  async checkHealth(): Promise<HealthStatus> {
    try {
      const url = this.buildUrl('/models');
      const headers = this.buildHeaders();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await this.fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        return response.ok ? 'healthy' : 'unhealthy';
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return 'unhealthy';
    }
  }
}



function parseSSELineToEvents(line: string): ProviderEvent[] {

  if (!line.startsWith('data: ')) return [];

  const data = line.slice(6);

  if (data === '[DONE]') {
    return [{ type: 'done' }];
  }

  try {
    const json = JSON.parse(data) as OpenAIChatCompletionChunk;
    const delta = json.choices?.[0]?.delta;
    const finishReason = json.choices?.[0]?.finish_reason;

    if (finishReason) {
      const events: ProviderEvent[] = [];
      if (json.usage) {
        events.push({
          type: 'usage',
          usage: {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
          },
        });
      }
      const reason = finishReason === 'length' ? 'length' as const
        : finishReason === 'tool_calls' ? 'tool_use' as const
        : 'stop' as const;
      events.push({ type: 'done', finishReason: reason });
      return events;
    }

    const events: ProviderEvent[] = [];



    const reasoningText = delta?.reasoning_content || delta?.reasoning;
    if (reasoningText) {
      events.push({ type: 'thinking', text: reasoningText });
    }
    if (delta?.content) {
      events.push({ type: 'text_delta', text: delta.content });
    }


    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        events.push({
          type: 'tool_use',
          toolCallId: tc.id ?? '',
          toolName: tc.function?.name ?? '',
          input: tc.function?.arguments ?? '',
          isPartial: !tc.id,
          ...(typeof tc.index === 'number' ? { index: tc.index } : {}),
        });
      }
    }

    return events;
  } catch {
    return [];
  }
}



interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      role?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      role?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIEmbeddingResponse {
  object?: string;
  data?: Array<{
    object?: string;
    embedding: number[];
    index: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}


type TeiRerankResponse = Array<{ index: number; score: number; text?: string }> & {
  error?: unknown;
};



function mapFinishReason(reason?: string): 'stop' | 'length' | 'tool_calls' | 'error' {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_calls';
  return 'stop';
}

function maskApiKey(headers: Record<string, string>): Record<string, string> {
  const masked = { ...headers };
  if (masked['Authorization']) {
    const token = masked['Authorization'].replace('Bearer ', '');
    if (token.length > 8) {
      masked['Authorization'] = `Bearer ${token.slice(0, 4)}...${token.slice(-4)}`;
    }
  }
  return masked;
}
