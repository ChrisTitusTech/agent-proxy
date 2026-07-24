import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import type {
  ChatMessage,
  ChatMessageToolCall,
  ExecuteResult,
  ProviderEvent,
  ReasoningEffort,
  TokenUsage,
  ValidationConfig,
} from '@agent-proxy/shared';
import { extractClientKey } from '../../utils/client-key.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { LogEntry } from '../../middleware/request-logger.js';
import type { ModelRouter, ResolvedRoute } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import {
  makeResponsesError,
  normalizeResponsesInput,
  parseResponsesRequest,
  type NormalizedResponsesInput,
  type ResponsesRequest,
} from './responses-schema.js';
import { ResponsesStore } from './responses-store.js';

interface ResponseOutputText {
  type: 'output_text';
  text: string;
  annotations: unknown[];
}

interface ResponseMessageOutput {
  id: string;
  type: 'message';
  status: 'in_progress' | 'completed' | 'incomplete';
  role: 'assistant';
  content: ResponseOutputText[];
}

interface ResponseFunctionCallOutput {
  id: string;
  type: 'function_call';
  status: 'in_progress' | 'completed' | 'incomplete';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponseReasoningOutput {
  id: string;
  type: 'reasoning';
  summary: Array<{ type: 'summary_text'; text: string }>;
}

type ResponseOutputItem =
  | ResponseMessageOutput
  | ResponseFunctionCallOutput
  | ResponseReasoningOutput;

export interface ResponsesResult {
  id: string;
  object: 'response';
  created_at: number;
  completed_at: number | null;
  status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
  error: {
    code: string;
    message: string;
  } | null;
  incomplete_details: { reason: 'max_output_tokens' } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: {
    effort: string | null;
    summary: string | null;
  };
  store: boolean;
  temperature: number | null;
  text: {
    format: { type: 'text' };
  };
  tool_choice: unknown;
  tools: unknown[];
  top_p: number | null;
  truncation: 'disabled';
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
  } | null;
  metadata: Record<string, string>;
}

export interface ResponsesDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  validation: ValidationConfig;
  activeRequests: ActiveRequestTracker;
  store?: ResponsesStore;
  requestLogger?: (entry: LogEntry) => Promise<void> | void;
  corsOrigins?: string[];
}

interface RequestAuthContext {
  apiKeyId?: string;
  apiKeyRateLimits?: {
    rpm?: number | null;
    rpd?: number | null;
  };
}

interface ExecutionContext {
  request: FastifyRequest;
  body: ResponsesRequest;
  normalized: NormalizedResponsesInput;
  messages: ChatMessage[];
  clientKey: string;
  apiKeyId?: string;
  keyLimits?: RequestAuthContext['apiKeyRateLimits'];
  responseId: string;
  startedAt: number;
}

interface PreparedContinuation {
  messages: ChatMessage[];
  knownCallIds: Set<string>;
}

function createResponseId(): string {
  return `resp_${nanoid(24)}`;
}

function createItemId(prefix: 'msg' | 'fc' | 'rs'): string {
  return `${prefix}_${nanoid(24)}`;
}

function safeProviderError(message: string): string {
  return message
    .replace(/\/[\w/.@-]+/g, '[path]')
    .replace(/at\s+\S+\s*\(.*?\)/g, '')
    .trim()
    .slice(0, 200);
}

function isTimeoutError(error: Error): boolean {
  return /timed out|timeout/i.test(error.message);
}

function isCancellationError(error: Error): boolean {
  return /cancelled|canceled|aborted/i.test(error.message);
}

function usageToResponses(usage: TokenUsage, reasoning: string | undefined) {
  return {
    input_tokens: usage.promptTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.completionTokens,
    output_tokens_details: {
      reasoning_tokens: reasoning ? Math.ceil(reasoning.length / 4) : 0,
    },
    total_tokens: usage.totalTokens,
  };
}

function baseResponse(
  id: string,
  body: ResponsesRequest,
  status: ResponsesResult['status'],
  createdAt: number,
): ResponsesResult {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    completed_at: status === 'completed' || status === 'incomplete'
      ? Math.floor(Date.now() / 1000)
      : null,
    status,
    error: null,
    incomplete_details: status === 'incomplete'
      ? { reason: 'max_output_tokens' }
      : null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model,
    output: [],
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: {
      effort: body.reasoning?.effort ?? null,
      summary: body.reasoning?.summary ?? null,
    },
    store: body.store ?? true,
    temperature: body.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: body.tools ?? [],
    // top_p is not part of the supported request subset and is rejected by
    // the strict request schema, so the response reports no applied value.
    top_p: null,
    truncation: 'disabled',
    usage: null,
    metadata: body.metadata ?? {},
  };
}

function outputItemsFromResult(
  result: ExecuteResult,
  incomplete: boolean,
  maxResponseLength: number,
): ResponseOutputItem[] {
  const status = incomplete ? 'incomplete' : 'completed';
  const output: ResponseOutputItem[] = [];

  if (result.reasoning) {
    output.push({
      id: createItemId('rs'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: result.reasoning }],
    });
  }

  const text = result.content.slice(0, maxResponseLength);
  if (text || !result.toolCalls?.length) {
    output.push({
      id: createItemId('msg'),
      type: 'message',
      status,
      role: 'assistant',
      content: [{
        type: 'output_text',
        text,
        annotations: [],
      }],
    });
  }

  for (const toolCall of result.toolCalls ?? []) {
    output.push({
      id: createItemId('fc'),
      type: 'function_call',
      status,
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }

  return output;
}

function outputMessages(
  output: ResponseOutputItem[],
): ChatMessage[] {
  const message = output.find(
    (item): item is ResponseMessageOutput => item.type === 'message',
  );
  const toolCalls = output
    .filter((item): item is ResponseFunctionCallOutput => item.type === 'function_call')
    .map<ChatMessageToolCall>((item) => ({
      id: item.call_id,
      type: 'function',
      function: {
        name: item.name,
        arguments: item.arguments,
      },
    }));

  if (!message && toolCalls.length === 0) return [];
  return [{
    role: 'assistant',
    content: message?.content.map((part) => part.text).join('') ?? '',
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }];
}

function writeSSE(reply: FastifyReply, event: string, data: unknown): boolean {
  try {
    if (reply.raw.destroyed || reply.raw.writableEnded) return false;
    return reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    return false;
  }
}

function openSSE(
  request: FastifyRequest,
  reply: FastifyReply,
  requestId: string,
  corsOrigins: string[],
): void {
  const origin = request.headers.origin;
  const allowedOrigin = origin
    && (corsOrigins.includes('*') || corsOrigins.includes(origin))
    ? origin
    : undefined;
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Request-ID': requestId,
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
  });
}

function responseError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  param: string | null,
  code: string,
) {
  return reply.status(statusCode).send(makeResponsesError(message, param, code));
}

function prepareContinuation(
  body: ResponsesRequest,
  normalized: NormalizedResponsesInput,
  store: ResponsesStore,
  clientKey: string,
): { success: true; data: PreparedContinuation } | {
  success: false;
  statusCode: number;
  message: string;
  code: string;
  param: string;
} {
  const previous = body.previous_response_id
    ? store.get(body.previous_response_id, clientKey)
    : null;

  if (body.previous_response_id && !previous) {
    return {
      success: false,
      statusCode: 404,
      message: `Response '${body.previous_response_id}' was not found.`,
      code: 'response_not_found',
      param: 'previous_response_id',
    };
  }

  if (previous && previous.model !== body.model) {
    return {
      success: false,
      statusCode: 400,
      message: 'previous_response_id cannot be used with a different model.',
      code: 'model_mismatch',
      param: 'previous_response_id',
    };
  }

  const knownCallIds = new Set<string>([
    ...(previous?.callIds ?? []),
    ...normalized.callIds,
  ]);
  for (const callId of normalized.functionOutputCallIds) {
    if (!knownCallIds.has(callId)) {
      const inputIndex = Array.isArray(body.input)
        ? body.input.findIndex(
          (item) => item.type === 'function_call_output' && item.call_id === callId,
        )
        : -1;
      return {
        success: false,
        statusCode: 400,
        message: `No function call was found for call_id '${callId}'.`,
        code: 'function_call_not_found',
        param: inputIndex >= 0 ? `input[${inputIndex}].call_id` : 'input',
      };
    }
  }

  return {
    success: true,
    data: {
      messages: [
        ...normalized.instructionMessages,
        ...(previous?.contextMessages ?? []),
        ...normalized.inputMessages,
      ],
      knownCallIds,
    },
  };
}

function validateTools(
  body: ResponsesRequest,
): { message: string; param: string; code: string } | null {
  if (
    body.tool_choice
    && body.tool_choice !== 'none'
    && body.tool_choice !== 'auto'
    && !body.tools?.length
  ) {
    return {
      message: 'tool_choice requires at least one function tool.',
      param: 'tool_choice',
      code: 'tool_choice_without_tools',
    };
  }
  if (typeof body.tool_choice === 'object') {
    const selectedToolName = body.tool_choice.name;
    const exists = body.tools?.some((tool) => tool.name === selectedToolName);
    if (!exists) {
      return {
        message: `Tool '${selectedToolName}' was not found in tools.`,
        param: 'tool_choice.name',
        code: 'tool_not_found',
      };
    }
  }
  return null;
}

async function resolveAvailableRoute(
  deps: ResponsesDeps,
  routes: ResolvedRoute[],
): Promise<{ route: ResolvedRoute | null; retryAfter: number | null }> {
  let retryAfter: number | null = null;
  for (const route of routes) {
    if (!await deps.healthChecker.isHealthy(route.provider)) continue;
    if (!deps.registry.get(route.provider)) continue;
    const providerLimit = deps.rateLimiter.checkProvider(route.provider);
    if (!providerLimit.allowed) {
      retryAfter = providerLimit.retryAfterSeconds ?? 30;
      continue;
    }
    return { route, retryAfter };
  }
  return { route: null, retryAfter };
}

function providerOptions(
  context: ExecutionContext,
  route: ResolvedRoute,
  signal: AbortSignal,
) {
  return {
    messages: context.messages,
    model: route.actualModel,
    stream: context.body.stream ?? false,
    maxTokens: context.body.max_output_tokens,
    temperature: context.body.temperature,
    signal,
    clientKey: context.clientKey,
    reasoningEffort: context.body.reasoning?.effort as ReasoningEffort | undefined
      ?? route.reasoningEffort,
    providerOverrides: route.providerOverrides,
    extraBody: route.extraBody,
    tools: context.normalized.tools,
    toolChoice: context.normalized.toolChoice,
    parallelToolCalls: context.body.parallel_tool_calls,
  };
}

function validateReturnedToolCalls(
  body: ResponsesRequest,
  toolCalls: Array<{ function: { name: string } }>,
): void {
  if (body.parallel_tool_calls === false && toolCalls.length > 1) {
    throw new Error('Provider returned parallel function calls when parallel_tool_calls is false.');
  }

  if (body.tool_choice === 'required' && toolCalls.length === 0) {
    throw new Error('Provider did not return a required function call.');
  }

  if (typeof body.tool_choice === 'object') {
    const requiredName = body.tool_choice.name;
    if (
      toolCalls.length === 0
      || toolCalls.some((call) => call.function.name !== requiredName)
    ) {
      throw new Error(`Provider did not return the required function '${requiredName}'.`);
    }
  }
}

function saveResponseContext(
  store: ResponsesStore,
  context: ExecutionContext,
  output: ResponseOutputItem[],
  knownCallIds: Set<string>,
): void {
  if (context.body.store === false) return;
  const newCallIds = output
    .filter((item): item is ResponseFunctionCallOutput => item.type === 'function_call')
    .map((item) => item.call_id);
  store.set({
    id: context.responseId,
    clientKey: context.clientKey,
    model: context.body.model,
    contextMessages: [
      ...context.messages.slice(context.normalized.instructionMessages.length),
      ...outputMessages(output),
    ],
    callIds: [...new Set([...knownCallIds, ...newCallIds])],
  });
}

function logExecution(
  deps: ResponsesDeps,
  context: ExecutionContext,
  route: ResolvedRoute,
  status: 'success' | 'error' | 'timeout',
  usage?: TokenUsage,
  errorMessage?: string,
): void {
  void (deps.requestLogger ?? logRequest)({
    requestId: context.responseId,
    apiKeyId: context.apiKeyId,
    modelAlias: context.body.model,
    provider: route.provider,
    actualModel: route.actualModel,
    reasoningEffort: context.body.reasoning?.effort as ReasoningEffort | undefined
      ?? route.reasoningEffort,
    status,
    statusCode: status === 'success' ? 200 : status === 'timeout' ? 504 : 502,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
    totalTokens: usage?.totalTokens,
    latencyMs: Date.now() - context.startedAt,
    isStream: context.body.stream ?? false,
    errorMessage,
  });
}

async function executeNonStreaming(
  reply: FastifyReply,
  deps: ResponsesDeps,
  store: ResponsesStore,
  context: ExecutionContext,
  routes: ResolvedRoute[],
  knownCallIds: Set<string>,
  signal: AbortSignal,
) {
  let lastError: Error | null = null;
  let retryAfter: number | null = null;

  for (const route of routes) {
    if (!await deps.healthChecker.isHealthy(route.provider)) {
      continue;
    }
    const providerLimit = deps.rateLimiter.checkProvider(route.provider);
    if (!providerLimit.allowed) {
      retryAfter = providerLimit.retryAfterSeconds ?? 30;
      continue;
    }
    const provider = deps.registry.get(route.provider);
    if (!provider) continue;

    deps.activeRequests.start({
      requestId: context.responseId,
      modelAlias: context.body.model,
      provider: route.provider,
      actualModel: route.actualModel,
      reasoningEffort: context.body.reasoning?.effort as ReasoningEffort | undefined
        ?? route.reasoningEffort,
      isStream: false,
      startedAt: context.startedAt,
    });

    try {
      const result = await deps.queue.enqueue(
        route.provider,
        () => provider.execute(providerOptions(context, route, signal)),
      );
      validateReturnedToolCalls(context.body, result.toolCalls ?? []);

      const incomplete = result.finishReason === 'length'
        || result.content.length > deps.validation.maxResponseLength;
      const response = baseResponse(
        context.responseId,
        context.body,
        incomplete ? 'incomplete' : 'completed',
        Math.floor(context.startedAt / 1000),
      );
      response.output = outputItemsFromResult(
        result,
        incomplete,
        deps.validation.maxResponseLength,
      );
      response.usage = usageToResponses(result.usage, result.reasoning);
      saveResponseContext(store, context, response.output, knownCallIds);
      logExecution(deps, context, route, 'success', result.usage);
      reply.header('X-Request-ID', context.responseId);
      if (routes.indexOf(route) > 0) {
        reply.header('X-Fallback-Provider', route.provider);
      }
      return reply.status(200).send(response);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const timeout = isTimeoutError(lastError);
      logExecution(deps, context, route, timeout ? 'timeout' : 'error', undefined, lastError.message);
      await deps.healthChecker.onRequestFailure(route.provider);
      if (isCancellationError(lastError)) break;
    } finally {
      deps.activeRequests.finish(context.responseId);
    }
  }

  if (retryAfter !== null && !lastError) {
    reply.header('Retry-After', String(retryAfter));
    return responseError(
      reply,
      429,
      `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
      null,
      'rate_limit_exceeded',
    );
  }

  const timeout = lastError ? isTimeoutError(lastError) : false;
  const cancelled = lastError ? isCancellationError(lastError) : false;
  return responseError(
    reply,
    timeout ? 504 : cancelled ? 499 : 502,
    cancelled
      ? 'Request was cancelled.'
      : `All providers failed for model '${context.body.model}'. Last error: ${safeProviderError(lastError?.message ?? 'unknown')}`,
    null,
    timeout ? 'timeout' : cancelled ? 'request_cancelled' : 'provider_error',
  );
}

interface StreamState {
  output: ResponseOutputItem[];
  message?: ResponseMessageOutput;
  reasoning?: ResponseReasoningOutput;
  functionCalls: Map<string, ResponseFunctionCallOutput>;
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'tool_use' | 'error';
  responseLengthExceeded: boolean;
  terminal: boolean;
}

function initialStreamState(): StreamState {
  return {
    output: [],
    functionCalls: new Map(),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'stop',
    responseLengthExceeded: false,
    terminal: false,
  };
}

function ensureMessage(
  reply: FastifyReply,
  state: StreamState,
): ResponseMessageOutput {
  if (state.message) return state.message;
  const message: ResponseMessageOutput = {
    id: createItemId('msg'),
    type: 'message',
    status: 'in_progress',
    role: 'assistant',
    content: [],
  };
  state.message = message;
  state.output.push(message);
  writeSSE(reply, 'response.output_item.added', {
    type: 'response.output_item.added',
    output_index: state.output.length - 1,
    item: message,
  });
  const part: ResponseOutputText = {
    type: 'output_text',
    text: '',
    annotations: [],
  };
  message.content.push(part);
  writeSSE(reply, 'response.content_part.added', {
    type: 'response.content_part.added',
    item_id: message.id,
    output_index: state.output.length - 1,
    content_index: 0,
    part,
  });
  return message;
}

function consumeStreamEvent(
  reply: FastifyReply,
  state: StreamState,
  event: ProviderEvent,
  body: ResponsesRequest,
  maxResponseLength: number,
): void {
  if (event.type === 'text_delta') {
    if (state.responseLengthExceeded) return;
    const message = ensureMessage(reply, state);
    const outputIndex = state.output.indexOf(message);
    const remaining = Math.max(0, maxResponseLength - message.content[0].text.length);
    const delta = event.text.slice(0, remaining);
    if (delta) {
      message.content[0].text += delta;
      writeSSE(reply, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: message.id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    if (event.text.length > remaining) {
      state.responseLengthExceeded = true;
      state.finishReason = 'length';
    }
    return;
  }

  if (event.type === 'thinking') {
    if (!state.reasoning) {
      state.reasoning = {
        id: createItemId('rs'),
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '' }],
      };
      state.output.push(state.reasoning);
      writeSSE(reply, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: state.output.length - 1,
        item: state.reasoning,
      });
    }
    state.reasoning.summary[0].text += event.text;
    writeSSE(reply, 'response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta',
      item_id: state.reasoning.id,
      output_index: state.output.indexOf(state.reasoning),
      summary_index: 0,
      delta: event.text,
    });
    return;
  }

  if (event.type === 'tool_use') {
    const key = event.index !== undefined
      ? `index-${event.index}`
      : event.toolCallId || `index-${state.functionCalls.size}`;
    let call = state.functionCalls.get(key);
    if (!call) {
      if (body.parallel_tool_calls === false && state.functionCalls.size > 0) {
        throw new Error(
          'Provider returned parallel function calls when parallel_tool_calls is false.',
        );
      }
      if (
        typeof body.tool_choice === 'object'
        && event.toolName !== body.tool_choice.name
      ) {
        throw new Error(
          `Provider did not return the required function '${body.tool_choice.name}'.`,
        );
      }
      call = {
        id: createItemId('fc'),
        type: 'function_call',
        status: 'in_progress',
        call_id: event.toolCallId || `call_${nanoid(24)}`,
        name: event.toolName,
        arguments: '',
      };
      state.functionCalls.set(key, call);
      state.output.push(call);
      writeSSE(reply, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: state.output.length - 1,
        item: call,
      });
    }
    call.arguments += event.input;
    writeSSE(reply, 'response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: call.id,
      output_index: state.output.indexOf(call),
      delta: event.input,
    });
    return;
  }

  if (event.type === 'usage') {
    state.usage = event.usage;
    return;
  }

  if (event.type === 'done') {
    if (!state.responseLengthExceeded) {
      state.finishReason = event.finishReason ?? 'stop';
    }
    return;
  }

  if (event.type === 'error') {
    throw new Error(event.error);
  }
}

function finishStreamItems(reply: FastifyReply, state: StreamState): void {
  if (!state.message && state.functionCalls.size === 0) {
    ensureMessage(reply, state);
  }

  if (state.reasoning) {
    const outputIndex = state.output.indexOf(state.reasoning);
    writeSSE(reply, 'response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      item_id: state.reasoning.id,
      output_index: outputIndex,
      summary_index: 0,
      text: state.reasoning.summary[0].text,
    });
    writeSSE(reply, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: state.reasoning,
    });
  }

  if (state.message) {
    const outputIndex = state.output.indexOf(state.message);
    const part = state.message.content[0];
    writeSSE(reply, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: state.message.id,
      output_index: outputIndex,
      content_index: 0,
      text: part.text,
    });
    writeSSE(reply, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: state.message.id,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    state.message.status = state.finishReason === 'length' ? 'incomplete' : 'completed';
    writeSSE(reply, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: state.message,
    });
  }

  for (const call of state.functionCalls.values()) {
    const outputIndex = state.output.indexOf(call);
    writeSSE(reply, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: call.id,
      output_index: outputIndex,
      arguments: call.arguments,
    });
    call.status = state.finishReason === 'length' ? 'incomplete' : 'completed';
    writeSSE(reply, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: call,
    });
  }
}

async function executeStreaming(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ResponsesDeps,
  store: ResponsesStore,
  context: ExecutionContext,
  route: ResolvedRoute,
  knownCallIds: Set<string>,
  signal: AbortSignal,
): Promise<void> {
  const provider = deps.registry.get(route.provider);
  if (!provider) {
    responseError(reply, 502, `Provider '${route.provider}' is unavailable.`, null, 'provider_error');
    return;
  }

  deps.activeRequests.start({
    requestId: context.responseId,
    modelAlias: context.body.model,
    provider: route.provider,
    actualModel: route.actualModel,
    reasoningEffort: context.body.reasoning?.effort as ReasoningEffort | undefined
      ?? route.reasoningEffort,
    isStream: true,
    startedAt: context.startedAt,
  });

  const state = initialStreamState();
  openSSE(request, reply, context.responseId, deps.corsOrigins ?? []);
  const createdAt = Math.floor(context.startedAt / 1000);
  const created = baseResponse(
    context.responseId,
    context.body,
    'in_progress',
    createdAt,
  );
  writeSSE(reply, 'response.created', {
    type: 'response.created',
    response: created,
  });
  writeSSE(reply, 'response.in_progress', {
    type: 'response.in_progress',
    response: created,
  });

  try {
    await deps.queue.enqueue(route.provider, async () => {
      for await (const event of provider.executeStream(
        providerOptions(context, route, signal),
      )) {
        consumeStreamEvent(
          reply,
          state,
          event,
          context.body,
          deps.validation.maxResponseLength,
        );
        if (
          reply.raw.destroyed
          || signal.aborted
          || state.responseLengthExceeded
        ) break;
      }
    });

    if (signal.aborted) {
      throw new Error('Request cancelled');
    }
    validateReturnedToolCalls(
      context.body,
      [...state.functionCalls.values()].map((call) => ({
        function: { name: call.name },
      })),
    );

    finishStreamItems(reply, state);
    const incomplete = state.finishReason === 'length';
    const result = baseResponse(
      context.responseId,
      context.body,
      incomplete ? 'incomplete' : 'completed',
      createdAt,
    );
    result.output = state.output;
    result.usage = usageToResponses(
      state.usage,
      state.reasoning?.summary[0]?.text,
    );
    saveResponseContext(store, context, state.output, knownCallIds);
    writeSSE(reply, incomplete ? 'response.incomplete' : 'response.completed', {
      type: incomplete ? 'response.incomplete' : 'response.completed',
      response: result,
    });
    state.terminal = true;
    logExecution(deps, context, route, 'success', state.usage);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!state.terminal && !reply.raw.destroyed) {
      const failed = baseResponse(
        context.responseId,
        context.body,
        'failed',
        createdAt,
      );
      failed.output = state.output;
      failed.error = {
        code: isTimeoutError(failure)
          ? 'timeout'
          : isCancellationError(failure)
            ? 'request_cancelled'
            : 'provider_error',
        message: safeProviderError(failure.message),
      };
      writeSSE(reply, 'response.failed', {
        type: 'response.failed',
        response: failed,
      });
      state.terminal = true;
    }
    logExecution(
      deps,
      context,
      route,
      isTimeoutError(failure) ? 'timeout' : 'error',
      undefined,
      failure.message,
    );
    await deps.healthChecker.onRequestFailure(route.provider);
  } finally {
    deps.activeRequests.finish(context.responseId);
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  }
}

export function registerResponsesRoute(
  app: FastifyInstance,
  deps: ResponsesDeps,
): void {
  const store = deps.store ?? new ResponsesStore();

  app.post('/v1/responses', async (request, reply) => {
    const parsed = parseResponsesRequest(request.body);
    if (!parsed.success) {
      return reply.status(400).send(parsed.error);
    }
    const body = parsed.data;

    const normalized = normalizeResponsesInput(body, deps.validation);
    if (!normalized.success) {
      return reply.status(400).send(normalized.error);
    }

    const toolError = validateTools(body);
    if (toolError) {
      return responseError(
        reply,
        400,
        toolError.message,
        toolError.param,
        toolError.code,
      );
    }

    const authContext = request as FastifyRequest & RequestAuthContext;
    const clientKey = extractClientKey(request, authContext.apiKeyId);
    const continuation = prepareContinuation(
      body,
      normalized.data,
      store,
      clientKey,
    );
    if (!continuation.success) {
      return responseError(
        reply,
        continuation.statusCode,
        continuation.message,
        continuation.param,
        continuation.code,
      );
    }

    const routes = await deps.router.resolve(body.model);
    if (routes.length === 0) {
      return responseError(
        reply,
        400,
        `Model '${body.model}' not found. Check model mappings.`,
        'model',
        'model_not_found',
      );
    }

    const globalLimit = deps.rateLimiter.checkGlobalAndKey(
      authContext.apiKeyId ?? 'anonymous',
      authContext.apiKeyRateLimits,
    );
    if (!globalLimit.allowed) {
      const retryAfter = globalLimit.retryAfterSeconds ?? 30;
      reply.header('Retry-After', String(retryAfter));
      return responseError(
        reply,
        429,
        `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
        null,
        'rate_limit_exceeded',
      );
    }

    const responseId = createResponseId();
    const context: ExecutionContext = {
      request,
      body,
      normalized: normalized.data,
      messages: continuation.data.messages,
      clientKey,
      apiKeyId: authContext.apiKeyId,
      keyLimits: authContext.apiKeyRateLimits,
      responseId,
      startedAt: Date.now(),
    };

    const abortController = new AbortController();
    const abort = () => {
      if (!reply.raw.writableEnded) abortController.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);

    try {
      if (body.stream === true) {
        const available = await resolveAvailableRoute(deps, routes);
        if (!available.route) {
          if (available.retryAfter !== null) {
            reply.header('Retry-After', String(available.retryAfter));
            return responseError(
              reply,
              429,
              `Rate limit exceeded. Retry after ${available.retryAfter} seconds.`,
              null,
              'rate_limit_exceeded',
            );
          }
          return responseError(
            reply,
            502,
            `No healthy provider is available for model '${body.model}'.`,
            null,
            'provider_unavailable',
          );
        }
        await executeStreaming(
          request,
          reply,
          deps,
          store,
          context,
          available.route,
          continuation.data.knownCallIds,
          abortController.signal,
        );
        return;
      }

      return await executeNonStreaming(
        reply,
        deps,
        store,
        context,
        routes,
        continuation.data.knownCallIds,
        abortController.signal,
      );
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
}
