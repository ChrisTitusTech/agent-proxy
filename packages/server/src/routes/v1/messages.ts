import type { FastifyInstance } from 'fastify';
import type {
  ChatCompletionTool,
  ChatMessage,
  ChatMessageContent,
  ChatMessageContentPart,
  ChatMessageToolCall,
  ToolChoice,
  ValidationConfig,
  ReasoningEffort,
} from '@agent-proxy/shared';
import { isReasoningEffort } from '@agent-proxy/shared';
import { nanoid } from 'nanoid';
import { createRequestId } from '../../utils/stream-transformer.js';
import { extractProviderClientKey } from '../../utils/client-key.js';
import {
  classifyProviderError,
  sanitizeProviderError,
  shouldDegradeProviderHealth,
} from '../../utils/provider-error.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import type { ResponseCache } from '../../services/cache.js';
import type { DebugService } from '../../services/debug.js';
import type { DebugCaptureInfo } from '@agent-proxy/shared';

export interface MessagesDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  validation: ValidationConfig;
  activeRequests: ActiveRequestTracker;
  cache: ResponseCache;
  debug: DebugService;
}


interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

type AnthropicToolChoice =
  | { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

interface NormalizedAnthropicRequest {
  messages: ChatMessage[];
  tools?: ChatCompletionTool[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  promptLength: number;
}

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: unknown;
  metadata?: unknown;
  reasoning_effort?: string;
}


function sanitizeString(str: string): string {
  return str.replace(/\x00/g, '');
}



function makeAnthropicError(type: string, message: string) {
  return {
    type: 'error',
    error: { type, message },
  };
}


function toAnthropicStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    default: return 'end_turn';
  }
}


function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return sanitizeString(value);
  if (value == null) return '';
  try {
    return sanitizeString(JSON.stringify(value));
  } catch {
    return sanitizeString(String(value));
  }
}

function normalizeToolResultContent(value: unknown): ChatMessageContent {
  if (typeof value === 'string') return sanitizeString(value);
  if (!Array.isArray(value)) return stringifyToolValue(value);

  const parts: ChatMessageContentPart[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      const text = stringifyToolValue(candidate);
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    const block = candidate as AnthropicContentBlock;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: sanitizeString(block.text) });
      continue;
    }
    if (isSupportedAnthropicImageBlock(block)) {
      parts.push(block as ChatMessageContentPart);
      continue;
    }
    const text = stringifyToolValue(block);
    if (text) parts.push({ type: 'text', text });
  }
  if (parts.length === 0) return stringifyToolValue(value);
  if (parts.every((part) => part.type === 'text' && typeof part.text === 'string')) {
    return parts.map((part) => part.text as string).join('\n');
  }
  return parts;
}

function isSupportedAnthropicImageBlock(block: AnthropicContentBlock): boolean {
  if (block.type !== 'image') return false;
  const source = block.source as Record<string, unknown> | undefined;
  return Boolean(
    source
    && typeof source === 'object'
    && (
      (
        source.type === 'base64'
        && typeof source.data === 'string'
        && source.data.length > 0
        && typeof source.media_type === 'string'
        && source.media_type.trim().length > 0
      )
      || (
        source.type === 'url'
        && typeof source.url === 'string'
        && source.url.trim().length > 0
      )
    ),
  );
}

function validateToolSelectionResult(
  toolChoice: ToolChoice | undefined,
  parallelToolCalls: boolean | undefined,
  toolNames: string[],
): string | undefined {
  if (toolChoice === 'none' && toolNames.length > 0) {
    return 'Provider returned a tool call when tool_choice is none.';
  }
  if (toolChoice === 'required' && toolNames.length === 0) {
    return 'Provider did not return a required tool call.';
  }
  if (typeof toolChoice === 'object') {
    if (
      toolNames.length === 0
      || toolNames.some((name) => name !== toolChoice.function.name)
    ) {
      return `Provider did not return the required tool "${toolChoice.function.name}".`;
    }
  }
  if (parallelToolCalls === false && toolNames.length > 1) {
    return 'Provider returned parallel tool calls when parallel tool use is disabled.';
  }
  return undefined;
}

export function normalizeAnthropicMessages(
  request: AnthropicMessagesRequest,
): { success: true; data: NormalizedAnthropicRequest } | {
  success: false;
  error: { type: string; message: string };
} {
  const messages: ChatMessage[] = [];
  let promptLength = 0;

  if (request.system) {
    const systemContent = sanitizeString(normalizeSystem(request.system));
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent });
      promptLength += systemContent.length;
    }
  }

  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex++) {
    const message = request.messages[messageIndex];
    if (message.role !== 'user' && message.role !== 'assistant') {
      return {
        success: false,
        error: {
          type: 'invalid_request_error',
          message: `Invalid role "${message.role}" at messages[${messageIndex}]. Allowed: user, assistant`,
        },
      };
    }

    if (typeof message.content === 'string') {
      const content = sanitizeString(message.content);
      messages.push({ role: message.role, content });
      promptLength += content.length;
      continue;
    }
    if (!Array.isArray(message.content)) {
      return {
        success: false,
        error: {
          type: 'invalid_request_error',
          message: `messages[${messageIndex}].content must be a string or content block array.`,
        },
      };
    }

    if (message.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: ChatMessageToolCall[] = [];
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex];
        if (!block || typeof block !== 'object') {
          return {
            success: false,
            error: {
              type: 'invalid_request_error',
              message: `Unsupported content block at messages[${messageIndex}].content[${blockIndex}].`,
            },
          };
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = sanitizeString(block.text);
          textParts.push(text);
          promptLength += text.length;
          continue;
        }
        if (
          (block.type === 'thinking' && typeof block.thinking === 'string')
          || (
            block.type === 'redacted_thinking'
            && typeof block.data === 'string'
          )
        ) {
          promptLength += block.type === 'thinking'
            ? (block.thinking as string).length
            : (block.data as string).length;
          continue;
        }
        if (
          block.type === 'tool_use'
          && typeof block.id === 'string'
          && typeof block.name === 'string'
        ) {
          const argumentsText = stringifyToolValue(block.input ?? {});
          toolCalls.push({
            id: sanitizeString(block.id),
            type: 'function',
            function: {
              name: sanitizeString(block.name),
              arguments: argumentsText,
            },
          });
          promptLength += block.id.length + block.name.length + argumentsText.length;
          continue;
        }
        return {
          success: false,
          error: {
            type: 'invalid_request_error',
            message: `Unsupported content block at messages[${messageIndex}].content[${blockIndex}].`,
          },
        };
      }
      messages.push({
        role: 'assistant',
        content: textParts.join('\n'),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    let userContentBuffer: ChatMessageContentPart[] = [];
    const flushUserContent = () => {
      if (userContentBuffer.length === 0) return;
      const textOnly = userContentBuffer.every(
        (part) => part.type === 'text' && typeof part.text === 'string',
      );
      messages.push({
        role: 'user',
        content: textOnly
          ? userContentBuffer.map((part) => part.text as string).join('\n')
          : userContentBuffer,
      });
      userContentBuffer = [];
    };
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex];
      if (!block || typeof block !== 'object') {
        return {
          success: false,
          error: {
            type: 'invalid_request_error',
            message: `Unsupported content block at messages[${messageIndex}].content[${blockIndex}].`,
          },
        };
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = sanitizeString(block.text);
        userContentBuffer.push({ type: 'text', text });
        promptLength += text.length;
        continue;
      }
      if (block.type === 'image') {
        if (isSupportedAnthropicImageBlock(block)) {
          userContentBuffer.push(block as ChatMessageContentPart);
          continue;
        }
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        flushUserContent();
        const content = normalizeToolResultContent(block.content);
        messages.push({
          role: 'tool',
          content,
          tool_call_id: sanitizeString(block.tool_use_id),
        });
        const contentLength = stringifyToolValue(content).length;
        promptLength += block.tool_use_id.length + contentLength;
        continue;
      }
      return {
        success: false,
        error: {
          type: 'invalid_request_error',
          message: `Unsupported content block at messages[${messageIndex}].content[${blockIndex}].`,
        },
      };
    }
    flushUserContent();
  }

  let tools: ChatCompletionTool[] | undefined;
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) {
      return {
        success: false,
        error: { type: 'invalid_request_error', message: 'tools must be an array.' },
      };
    }
    tools = [];
    for (let index = 0; index < request.tools.length; index++) {
      const tool = request.tools[index];
      if (
        !tool
        || typeof tool.name !== 'string'
        || tool.name.length === 0
        || typeof tool.input_schema !== 'object'
        || tool.input_schema === null
        || Array.isArray(tool.input_schema)
      ) {
        return {
          success: false,
          error: {
            type: 'invalid_request_error',
            message: `Invalid tool definition at tools[${index}].`,
          },
        };
      }
      tools.push({
        type: 'function',
        function: {
          name: sanitizeString(tool.name),
          ...(typeof tool.description === 'string'
            ? { description: sanitizeString(tool.description) }
            : {}),
          parameters: tool.input_schema,
          ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
        },
      });
    }
  }

  let toolChoice: ToolChoice | undefined;
  let parallelToolCalls: boolean | undefined;
  if (request.tool_choice !== undefined) {
    const choice = request.tool_choice;
    if (!choice || typeof choice !== 'object' || typeof choice.type !== 'string') {
      return {
        success: false,
        error: { type: 'invalid_request_error', message: 'tool_choice is invalid.' },
      };
    }
    if (choice.type === 'auto') toolChoice = 'auto';
    else if (choice.type === 'any') toolChoice = 'required';
    else if (choice.type === 'none') toolChoice = 'none';
    else if (choice.type === 'tool' && typeof choice.name === 'string' && choice.name.length > 0) {
      toolChoice = {
        type: 'function',
        function: { name: sanitizeString(choice.name) },
      };
    } else {
      return {
        success: false,
        error: { type: 'invalid_request_error', message: 'tool_choice is invalid.' },
      };
    }
    if (typeof choice.disable_parallel_tool_use === 'boolean') {
      parallelToolCalls = !choice.disable_parallel_tool_use;
    }
  }
  if (
    (toolChoice === 'required' || typeof toolChoice === 'object')
    && (!tools || tools.length === 0)
  ) {
    return {
      success: false,
      error: {
        type: 'invalid_request_error',
        message: 'tool_choice requires at least one declared tool.',
      },
    };
  }
  if (
    typeof toolChoice === 'object'
    && !tools?.some((tool) => tool.function.name === toolChoice.function.name)
  ) {
    return {
      success: false,
      error: {
        type: 'invalid_request_error',
        message: `tool_choice references undeclared tool "${toolChoice.function.name}".`,
      },
    };
  }

  return {
    success: true,
    data: {
      messages,
      ...(tools ? { tools } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
      promptLength,
    },
  };
}


function normalizeSystem(system: string | Array<{ type: string; text: string }>): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function writeSSE(raw: NodeJS.WritableStream, event: string, data: unknown): boolean {
  try {
    if ((raw as unknown as Record<string, unknown>).destroyed || (raw as unknown as Record<string, unknown>).writableEnded) return false;
    return raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    return false;
  }
}


function createMessageId(): string {
  return `msg_${nanoid(24)}`;
}

export function registerMessagesRoute(
  app: FastifyInstance,
  deps: MessagesDeps,
): void {
  const v = deps.validation;

  app.post<{ Body: AnthropicMessagesRequest }>(
    '/v1/messages',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const messageId = createMessageId();
      const body = request.body;



      if (!body.model) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', 'model is required.'));
      }

      if (!body.messages?.length) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', 'messages is required and must not be empty.'));
      }

      if (!Array.isArray(body.messages)) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', 'messages must be an array.'));
      }

      if (body.max_tokens == null) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', 'max_tokens is required.'));
      }


      if (body.messages.length > v.maxMessageCount) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', `Too many messages: ${body.messages.length}. Maximum is ${v.maxMessageCount}.`));
      }




      const normalized = normalizeAnthropicMessages(body);
      if (!normalized.success) {
        return reply.status(400).send(makeAnthropicError(
          normalized.error.type,
          normalized.error.message,
        ));
      }
      const internalMessages = normalized.data.messages;

      for (const message of internalMessages) {
        const content = typeof message.content === 'string'
          ? message.content
          : stringifyToolValue(message.content);
        if (content.length > v.maxMessageLength) {
          return reply.status(400).send(makeAnthropicError(
            'invalid_request_error',
            `Message content too long: ${content.length} chars. Maximum is ${v.maxMessageLength}.`,
          ));
        }
        for (const toolCall of message.tool_calls ?? []) {
          if (toolCall.function.arguments.length > v.maxMessageLength) {
            return reply.status(400).send(makeAnthropicError(
              'invalid_request_error',
              `Tool input is too long. Maximum is ${v.maxMessageLength}.`,
            ));
          }
        }
      }

      if (normalized.data.promptLength > v.maxPromptLength) {
        return reply.status(400).send(makeAnthropicError(
          'invalid_request_error',
          `Total prompt length too long: ${normalized.data.promptLength} chars. Maximum is ${v.maxPromptLength}.`,
        ));
      }


      body.model = sanitizeString(body.model);


      const unsupportedParams: string[] = [];
      if (body.temperature != null) unsupportedParams.push('temperature');
      if (body.top_p != null) unsupportedParams.push('top_p');
      if (body.top_k != null) unsupportedParams.push('top_k');
      if (body.stop_sequences != null) unsupportedParams.push('stop_sequences');
      if (body.thinking != null) unsupportedParams.push('thinking');
      if (body.metadata != null) unsupportedParams.push('metadata');



      const routes = await deps.router.resolve(body.model);
      if (routes.length === 0) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', `Model "${body.model}" not found. Check model mappings.`));
      }


      let bodyReasoningEffort: ReasoningEffort | undefined;
      if (body.reasoning_effort != null) {
        const normalized = typeof body.reasoning_effort === 'string'
          ? body.reasoning_effort.trim().toLowerCase()
          : '';
        if (!isReasoningEffort(normalized)) {
          return reply.status(400).send(
            makeAnthropicError('invalid_request_error', 'reasoning_effort must be one of: low, medium, high, xhigh, max.'),
          );
        }
        bodyReasoningEffort = normalized;
      }

      const apiKeyId = (request as unknown as { apiKeyId?: string }).apiKeyId;
      const keyLimits = (request as unknown as { apiKeyRateLimits?: { rpm?: number | null; rpd?: number | null } }).apiKeyRateLimits;

      const clientKey = extractProviderClientKey(request, apiKeyId);


      const requestHash = !body.stream && !normalized.data.tools?.length
        ? deps.cache.generateHash(body.model, internalMessages)
        : undefined;

      if (!body.stream && requestHash) {
        const cached = await deps.cache.get(requestHash);
        if (cached) {
          const cachedBody = JSON.parse(cached.responseBody);

          reply.header('X-Cache', 'HIT');
          reply.header('X-Request-ID', requestId);

          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: cached.provider,
            actualModel: routes[0].actualModel,
            reasoningEffort: bodyReasoningEffort ?? routes[0].reasoningEffort,
            status: 'success',
            statusCode: 200,
            promptTokens: cachedBody.usage?.input_tokens,
            completionTokens: cachedBody.usage?.output_tokens,
            totalTokens: (cachedBody.usage?.input_tokens ?? 0) + (cachedBody.usage?.output_tokens ?? 0),
            latencyMs: Date.now() - startTime,
            isStream: false,
            requestHash,
          });

          return reply.status(200).send(cachedBody);
        }
      }


      const gkResult = deps.rateLimiter.checkGlobalAndKey(apiKeyId ?? 'anonymous', keyLimits);
      if (!gkResult.allowed) {
        reply.header('Retry-After', String(gkResult.retryAfterSeconds ?? 30));
        return reply.status(429).send(makeAnthropicError('rate_limit_error', `Rate limit exceeded. Retry after ${gkResult.retryAfterSeconds} seconds.`));
      }



      let lastError: Error | null = null;
      let lastErrorProvider: string | undefined;
      let rateLimitRetryAfter: number | null = null;

      for (const route of routes) {
        const healthy = await deps.healthChecker.isHealthy(route.provider);
        if (!healthy) {
          lastError = new Error(`Provider ${route.provider} is unhealthy`);
          lastErrorProvider = route.provider;
          continue;
        }


        const provRate = deps.rateLimiter.checkProvider(route.provider);
        if (!provRate.allowed) {
          rateLimitRetryAfter = provRate.retryAfterSeconds ?? 30;
          lastError = new Error(`Provider ${route.provider} rate limit exceeded`);
          lastErrorProvider = route.provider;
          continue;
        }

        const provider = deps.registry.get(route.provider);
        if (!provider) {
          lastError = new Error(`Provider ${route.provider} not available`);
          lastErrorProvider = route.provider;
          continue;
        }


        deps.activeRequests.start({
          requestId,
          modelAlias: body.model,
          provider: route.provider,
          actualModel: route.actualModel,
          reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
          isStream: body.stream ?? false,
          startedAt: startTime,
        });
        let attemptFinalized = false;
        const finishActiveRequest = (): boolean => {
          if (attemptFinalized) return false;
          attemptFinalized = true;
          deps.activeRequests.finish(requestId);
          return true;
        };
        const finalizeCancellation = async (
          message = 'Request cancelled',
        ): Promise<void> => {
          if (!finishActiveRequest()) return;
          const latencyMs = Date.now() - startTime;
          try {
            await logRequest({
              requestId,
              apiKeyId,
              modelAlias: body.model,
              provider: route.provider,
              actualModel: route.actualModel,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              status: 'cancelled',
              statusCode: 499,
              latencyMs,
              isStream: body.stream ?? false,
              errorMessage: sanitizeProviderError(message),
            });
          } catch {
            // Request cleanup must not depend on optional persistence.
          }
        };


        const debugEnabled = deps.debug.isEnabled(body.model);
        let debugCapture: DebugCaptureInfo | undefined;
        let debugLogId: string | undefined;
        const onDebug = debugEnabled
          ? (info: DebugCaptureInfo) => { debugCapture = info; }
          : undefined;

        if (debugEnabled) {
          debugLogId = await deps.debug.logStart({
            requestId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            isStream: body.stream ?? false,
            requestMessages: internalMessages,
          });
        }

        try {
          if (body.stream) {

            const abortController = new AbortController();
            let providerStarted = false;
            const onClientClose = () => {
              abortController.abort();
              if (!providerStarted) void finalizeCancellation();
            };
            request.raw.once('aborted', onClientClose);
            reply.raw.once('close', onClientClose);

            try {
              await deps.queue.enqueue(route.provider, async () => {

              if (abortController.signal.aborted) {
                await finalizeCancellation();
                return;
              }

              await deps.registry.assertExecutionReady(provider);
              if (abortController.signal.aborted) {
                await finalizeCancellation();
                return;
              }
              providerStarted = true;


              const origin = request.headers.origin;
              reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Request-ID': requestId,
                ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
                ...(routes.indexOf(route) > 0 ? { 'X-Fallback-Provider': route.provider } : {}),
                ...(unsupportedParams.length > 0 ? { 'X-Unsupported-Params': unsupportedParams.join(',') } : {}),
              });


              if (!writeSSE(reply.raw, 'message_start', {
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: body.model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 1 },
                },
              })) return;

              writeSSE(reply.raw, 'ping', { type: 'ping' });

              let totalContent = '';
              let ttfbMs: number | undefined;
              let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
              let blockIndex = 0;
              let currentBlockType: 'text' | 'thinking' | 'tool_use' | null = null;
              let currentToolIndex: number | undefined;
              let currentToolInputLength = 0;
              const streamedToolNames: string[] = [];
              let streamFinishReason: 'end_turn' | 'max_tokens' | 'tool_use' = 'end_turn';

              const closeCurrentBlock = () => {
                if (currentBlockType === null) return;
                writeSSE(reply.raw, 'content_block_stop', {
                  type: 'content_block_stop',
                  index: blockIndex,
                });
                blockIndex++;
                currentBlockType = null;
                currentToolIndex = undefined;
                currentToolInputLength = 0;
              };

              const streamIterator = provider.executeStream({
                messages: internalMessages,
                model: route.actualModel,
                stream: true,
                maxTokens: body.max_tokens,
                temperature: body.temperature,
                signal: abortController.signal,
                onDebug,
                clientKey,
                requestId,
                reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
                providerOverrides: route.providerOverrides,
                extraBody: route.extraBody,
                tools: normalized.data.tools,
                toolChoice: normalized.data.toolChoice,
                parallelToolCalls: normalized.data.parallelToolCalls,
              });

              try {
                for await (const event of streamIterator) {
                  if (!ttfbMs) {
                    ttfbMs = Date.now() - startTime;
                  }

                  if (event.type === 'text_delta') {

                    if (currentBlockType !== 'text') {
                      closeCurrentBlock();
                      writeSSE(reply.raw, 'content_block_start', {
                        type: 'content_block_start', index: blockIndex,
                        content_block: { type: 'text', text: '' },
                      });
                      currentBlockType = 'text';
                    }
                    if (!writeSSE(reply.raw, 'content_block_delta', {
                      type: 'content_block_delta',
                      index: blockIndex,
                      delta: { type: 'text_delta', text: event.text },
                    })) break;
                    totalContent += event.text;
                  }

                  if (event.type === 'thinking') {
                    if (currentBlockType !== 'thinking') {
                      closeCurrentBlock();
                      writeSSE(reply.raw, 'content_block_start', {
                        type: 'content_block_start', index: blockIndex,
                        content_block: { type: 'thinking', thinking: '' },
                      });
                      currentBlockType = 'thinking';
                    }
                    writeSSE(reply.raw, 'content_block_delta', {
                      type: 'content_block_delta',
                      index: blockIndex,
                      delta: { type: 'thinking_delta', thinking: event.text },
                    });
                  }

                  if (event.type === 'tool_use') {
                    const toolIndex = event.index ?? currentToolIndex ?? 0;
                    const startsNewTool = currentBlockType !== 'tool_use'
                      || currentToolIndex !== toolIndex;
                    if (startsNewTool) {
                      closeCurrentBlock();
                      if (!event.toolCallId || !event.toolName) {
                        throw new Error('Provider returned a tool call without an ID or name.');
                      }
                      writeSSE(reply.raw, 'content_block_start', {
                        type: 'content_block_start', index: blockIndex,
                        content_block: {
                          type: 'tool_use',
                          id: event.toolCallId,
                          name: event.toolName,
                          input: {},
                        },
                      });
                      currentBlockType = 'tool_use';
                      currentToolIndex = toolIndex;
                      streamedToolNames.push(event.toolName);
                    }
                    currentToolInputLength += event.input.length;
                    if (currentToolInputLength > v.maxMessageLength) {
                      throw new Error(
                        `Provider returned tool input longer than ${v.maxMessageLength} characters.`,
                      );
                    }
                    writeSSE(reply.raw, 'content_block_delta', {
                      type: 'content_block_delta',
                      index: blockIndex,
                      delta: { type: 'input_json_delta', partial_json: event.input },
                    });
                    streamFinishReason = 'tool_use';
                  }

                  if (event.type === 'usage') {
                    streamUsage = event.usage;
                  }


                  if (totalContent.length > v.maxResponseLength) {
                    break;
                  }

                  if (event.type === 'done') {
                    if (event.finishReason === 'length') streamFinishReason = 'max_tokens';
                    if (event.finishReason === 'tool_use') streamFinishReason = 'tool_use';
                    break;
                  }
                }
              } catch (streamErr) {

                const errMsg = streamErr instanceof Error ? streamErr.message : 'Stream interrupted';
                const failure = classifyProviderError(errMsg, route.provider);
                if (
                  abortController.signal.aborted
                  || failure.kind === 'cancelled'
                ) {
                  reply.raw.end();
                  await finalizeCancellation(errMsg);
                  return;
                }
                writeSSE(reply.raw, 'error', makeAnthropicError('api_error', errMsg));
                reply.raw.end();

                logRequest({
                  requestId,
                  apiKeyId,
                  modelAlias: body.model,
                  provider: route.provider,
                  actualModel: route.actualModel,
                  reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
                  status: 'error',
                  statusCode: 200,
                  latencyMs: Date.now() - startTime,
                  isStream: true,
                  errorMessage: errMsg,
                });

                finishActiveRequest();
                if (shouldDegradeProviderHealth(failure)) {
                  await deps.healthChecker.onRequestFailure(route.provider);
                }
                return;
              }

              if (abortController.signal.aborted) {
                reply.raw.end();
                await finalizeCancellation();
                return;
              }

              const toolSelectionError = validateToolSelectionResult(
                normalized.data.toolChoice,
                normalized.data.parallelToolCalls,
                streamedToolNames,
              );
              if (toolSelectionError) {
                writeSSE(
                  reply.raw,
                  'error',
                  makeAnthropicError('api_error', toolSelectionError),
                );
                reply.raw.end();
                logRequest({
                  requestId,
                  apiKeyId,
                  modelAlias: body.model,
                  provider: route.provider,
                  actualModel: route.actualModel,
                  reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
                  status: 'error',
                  statusCode: 200,
                  latencyMs: Date.now() - startTime,
                  isStream: true,
                  errorMessage: toolSelectionError,
                });
                finishActiveRequest();
                return;
              }

              if (currentBlockType === null) {
                writeSSE(reply.raw, 'content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'text', text: '' },
                });
                currentBlockType = 'text';
              }
              closeCurrentBlock();


              if (!writeSSE(reply.raw, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: streamFinishReason, stop_sequence: null },
                usage: { output_tokens: streamUsage?.completionTokens ?? Math.ceil(totalContent.length / 4) },
              })) {
                reply.raw.end();
              } else {

                writeSSE(reply.raw, 'message_stop', { type: 'message_stop' });
                reply.raw.end();
              }

              const streamLatency = Date.now() - startTime;
              logRequest({
                requestId,
                apiKeyId,
                modelAlias: body.model,
                provider: route.provider,
                actualModel: route.actualModel,
                reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
                status: 'success',
                statusCode: 200,
                promptTokens: streamUsage?.promptTokens ?? 0,
                completionTokens: streamUsage?.completionTokens ?? Math.ceil(totalContent.length / 4),
                totalTokens: streamUsage?.totalTokens ?? Math.ceil(totalContent.length / 4),
                latencyMs: streamLatency,
                ttfbMs,
                isStream: true,
              });

              if (debugLogId && debugCapture) {
                deps.debug.logComplete(debugLogId, {
                  requestId,
                  cliArgs: debugCapture.cliArgs,
                  streamLines: debugCapture.streamLines,
                  rawResponseText: debugCapture.rawResponseText,
                  parsedContent: totalContent,
                  tokenUsage: streamUsage,
                  status: 'success',
                  latencyMs: streamLatency,
                });
              }

              finishActiveRequest();
              }, { signal: abortController.signal });
            } finally {
              request.raw.removeListener('aborted', onClientClose);
              reply.raw.removeListener('close', onClientClose);
              finishActiveRequest();
            }

            return;
          }


          const abortController = new AbortController();
          const onClientClose = () => abortController.abort();
          request.raw.once('aborted', onClientClose);
          reply.raw.once('close', onClientClose);
          let result;
          try {
            result = await deps.queue.enqueue(
              route.provider,
              () => provider.execute({
              messages: internalMessages,
              model: route.actualModel,
              stream: false,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              onDebug,
              clientKey,
              requestId,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              providerOverrides: route.providerOverrides,
              extraBody: route.extraBody,
              tools: normalized.data.tools,
              toolChoice: normalized.data.toolChoice,
              parallelToolCalls: normalized.data.parallelToolCalls,
              signal: abortController.signal,
              }),
              { signal: abortController.signal },
            );
          } finally {
            request.raw.removeListener('aborted', onClientClose);
            reply.raw.removeListener('close', onClientClose);
          }

          if (abortController.signal.aborted) {
            await finalizeCancellation();
            return;
          }


          let content = result.content;
          if (content.length > v.maxResponseLength) {
            content = content.substring(0, v.maxResponseLength);
          }


          const responseContent: Array<Record<string, unknown>> = [];
          if (content || !result.toolCalls?.length) {
            responseContent.push({ type: 'text', text: content });
          }
          const rejectToolOutput = (message: string) => {
            const latencyMs = Date.now() - startTime;
            logRequest({
              requestId,
              apiKeyId,
              modelAlias: body.model,
              provider: route.provider,
              actualModel: route.actualModel,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              status: 'error',
              statusCode: 502,
              latencyMs,
              isStream: false,
              errorMessage: message,
            });
            if (debugLogId) {
              deps.debug.logComplete(debugLogId, {
                requestId,
                cliArgs: debugCapture?.cliArgs,
                rawStdout: debugCapture?.stdout,
                rawStderr: debugCapture?.stderr,
                rawResponseText: debugCapture?.rawResponseText,
                status: 'error',
                latencyMs,
                errorMessage: message,
              });
            }
            finishActiveRequest();
            return reply.status(502).send(makeAnthropicError('api_error', message));
          };
          const toolSelectionError = validateToolSelectionResult(
            normalized.data.toolChoice,
            normalized.data.parallelToolCalls,
            (result.toolCalls ?? []).map((toolCall) => toolCall.function.name),
          );
          if (toolSelectionError) {
            return rejectToolOutput(toolSelectionError);
          }
          for (const toolCall of result.toolCalls ?? []) {
            let input: unknown;
            const argumentsJson = toolCall.function.arguments;
            if (
              typeof argumentsJson !== 'string'
              || argumentsJson.length > v.maxMessageLength
            ) {
              return rejectToolOutput(
                typeof argumentsJson === 'string'
                  ? `Provider returned tool input longer than ${v.maxMessageLength} characters.`
                  : `Provider returned invalid JSON arguments for tool "${toolCall.function.name}".`,
              );
            }
            try {
              input = JSON.parse(argumentsJson || '{}');
            } catch {
              return rejectToolOutput(
                `Provider returned invalid JSON arguments for tool "${toolCall.function.name}".`,
              );
            }
            responseContent.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input,
            });
          }

          const response = {
            id: messageId,
            type: 'message' as const,
            role: 'assistant' as const,
            content: responseContent,
            model: body.model,
            stop_reason: result.finishReason === 'length'
              ? 'max_tokens'
              : result.toolCalls?.length
              ? 'tool_use'
              : toAnthropicStopReason(result.finishReason === 'error' ? 'stop' : result.finishReason),
            stop_sequence: null,
            usage: {
              input_tokens: result.usage.promptTokens,
              output_tokens: result.usage.completionTokens,
            },
          };

          if (routes.indexOf(route) > 0) {
            reply.header('X-Fallback-Provider', route.provider);
          }
          reply.header('X-Request-ID', requestId);
          reply.header('X-Cache', 'MISS');
          if (unsupportedParams.length > 0) {
            reply.header('X-Unsupported-Params', unsupportedParams.join(','));
          }

          if (result.meta?.threadId) {
            reply.header('X-Agent-Proxy-Thread-Id', result.meta.threadId);
          }


          if (requestHash) {
            await deps.cache.set(
              requestHash,
              body.model,
              route.provider,
              JSON.stringify(response),
              result.usage.totalTokens,
            );
          }

          const nonStreamLatency = Date.now() - startTime;
          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            status: 'success',
            statusCode: 200,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            latencyMs: nonStreamLatency,
            isStream: false,
            requestHash,
          });

          if (debugLogId && debugCapture) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture.cliArgs,
              rawStdout: debugCapture.stdout,
              rawStderr: debugCapture.stderr,
              rawResponseText: debugCapture.rawResponseText,
              parsedContent: content,
              tokenUsage: result.usage,
              status: 'success',
              latencyMs: nonStreamLatency,
            });
          }

          finishActiveRequest();
          return reply.status(200).send(response);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          lastErrorProvider = route.provider;
          const failure = classifyProviderError(lastError, route.provider);
          if (failure.kind === 'cancelled') {
            await finalizeCancellation(lastError.message);
            lastError = new Error('Request cancelled');
            break;
          }
          const isTimeout = lastError.message.includes('timed out');

          const errLatency = Date.now() - startTime;
          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            status: isTimeout ? 'timeout' : 'error',
            statusCode: isTimeout ? 504 : 502,
            latencyMs: errLatency,
            isStream: body.stream ?? false,
            errorMessage: sanitizeProviderError(lastError.message),
          });

          if (debugLogId) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture?.cliArgs,
              rawStdout: debugCapture?.stdout,
              rawStderr: debugCapture?.stderr,
              streamLines: debugCapture?.streamLines,
              rawResponseText: debugCapture?.rawResponseText,
              status: isTimeout ? 'timeout' : 'error',
              latencyMs: errLatency,
              errorMessage: sanitizeProviderError(lastError.message),
            });
          }

          finishActiveRequest();
          if (shouldDegradeProviderHealth(failure)) {
            await deps.healthChecker.onRequestFailure(route.provider);
          }
          if (!failure.fallbackEligible) break;
          continue;
        }
      }


      if (rateLimitRetryAfter !== null) {
        reply.header('Retry-After', String(rateLimitRetryAfter));
        return reply.status(429).send(makeAnthropicError('rate_limit_error', `Rate limit exceeded. Retry after ${rateLimitRetryAfter} seconds.`));
      }


      const failure = classifyProviderError(
        lastError ?? 'Provider request failed.',
        lastErrorProvider,
      );
      const errorType = failure.kind === 'timeout'
        ? 'timeout_error'
        : failure.kind === 'login_required' || failure.kind === 'login_expired'
          ? 'authentication_error'
          : 'api_error';

      return reply.status(failure.statusCode).send(
        makeAnthropicError(errorType, failure.message),
      );
    },
  );
}
