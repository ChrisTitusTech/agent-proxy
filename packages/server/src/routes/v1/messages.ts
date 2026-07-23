import type { FastifyInstance } from 'fastify';
import type { ValidationConfig, ReasoningEffort } from '@agent-proxy/shared';
import { isReasoningEffort } from '@agent-proxy/shared';
import { nanoid } from 'nanoid';
import { createRequestId } from '../../utils/stream-transformer.js';
import { extractClientKey } from '../../utils/client-key.js';
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

interface MessagesDeps {
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


interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
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
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: unknown;
  metadata?: unknown;
  reasoning_effort?: string;
}


function sanitizeString(str: string): string {
  return str.replace(/\x00/g, '');
}



function sanitizeProviderError(message: string): string {
  return message
    .replace(/\/[\w/.@-]+/g, '[path]')
    .replace(/at\s+\S+\s*\(.*?\)/g, '')
    .trim()
    .substring(0, 200);
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


function normalizeContent(content: string | Array<{ type: string; text?: string; [key: string]: unknown }>): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
  }
  return '';
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




      const internalMessages: Array<{ role: 'system' | 'user' | 'assistant' | 'developer'; content: string }> = [];


      if (body.system) {
        const systemContent = sanitizeString(normalizeSystem(body.system));
        if (systemContent) {
          internalMessages.push({ role: 'system', content: systemContent });
        }
      }


      let totalPromptLength = 0;
      for (let i = 0; i < body.messages.length; i++) {
        const msg = body.messages[i];


        if (msg.role !== 'user' && msg.role !== 'assistant') {
          return reply.status(400).send(makeAnthropicError('invalid_request_error', `Invalid role "${msg.role}" at messages[${i}]. Allowed: user, assistant`));
        }


        let content = normalizeContent(msg.content);
        content = sanitizeString(content);


        if (content.length > v.maxMessageLength) {
          return reply.status(400).send(makeAnthropicError('invalid_request_error', `messages[${i}].content too long: ${content.length} chars. Maximum is ${v.maxMessageLength}.`));
        }

        totalPromptLength += content.length;
        internalMessages.push({ role: msg.role, content });
      }


      if (totalPromptLength > v.maxPromptLength) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', `Total prompt length too long: ${totalPromptLength} chars. Maximum is ${v.maxPromptLength}.`));
      }


      body.model = sanitizeString(body.model);


      const unsupportedParams: string[] = [];
      if (body.temperature != null) unsupportedParams.push('temperature');
      if (body.top_p != null) unsupportedParams.push('top_p');
      if (body.top_k != null) unsupportedParams.push('top_k');
      if (body.stop_sequences != null) unsupportedParams.push('stop_sequences');
      if (body.tools != null) unsupportedParams.push('tools');
      if (body.tool_choice != null) unsupportedParams.push('tool_choice');
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

      const clientKey = extractClientKey(request, apiKeyId);


      const requestHash = !body.stream
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
      let rateLimitRetryAfter: number | null = null;

      for (const route of routes) {
        const healthy = await deps.healthChecker.isHealthy(route.provider);
        if (!healthy) {
          lastError = new Error(`Provider ${route.provider} is unhealthy`);
          continue;
        }


        const provRate = deps.rateLimiter.checkProvider(route.provider);
        if (!provRate.allowed) {
          rateLimitRetryAfter = provRate.retryAfterSeconds ?? 30;
          lastError = new Error(`Provider ${route.provider} rate limit exceeded`);
          continue;
        }

        const provider = deps.registry.get(route.provider);
        if (!provider) {
          lastError = new Error(`Provider ${route.provider} not available`);
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
            request.raw.on('close', () => abortController.abort());

            await deps.queue.enqueue(route.provider, async () => {

              if (abortController.signal.aborted) return;



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


              if (!writeSSE(reply.raw, 'content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              })) return;


              writeSSE(reply.raw, 'ping', { type: 'ping' });

              let totalContent = '';
              let ttfbMs: number | undefined;
              let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
              let blockIndex = 0;
              let currentBlockType: 'text' | 'thinking' | 'tool_use' | null = 'text';

              const streamIterator = provider.executeStream({
                messages: internalMessages,
                model: route.actualModel,
                stream: true,
                maxTokens: body.max_tokens,
                temperature: body.temperature,
                signal: abortController.signal,
                onDebug,
                clientKey,
                reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
                providerOverrides: route.providerOverrides,
              });

              try {
                for await (const event of streamIterator) {
                  if (!ttfbMs) {
                    ttfbMs = Date.now() - startTime;
                  }

                  if (event.type === 'text_delta') {

                    if (currentBlockType !== 'text') {
                      if (currentBlockType !== null) {
                        writeSSE(reply.raw, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
                        blockIndex++;
                      }
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
                      if (currentBlockType !== null) {
                        writeSSE(reply.raw, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
                        blockIndex++;
                      }
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

                    if (currentBlockType !== null) {
                      writeSSE(reply.raw, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
                      blockIndex++;
                    }
                    writeSSE(reply.raw, 'content_block_start', {
                      type: 'content_block_start', index: blockIndex,
                      content_block: { type: 'tool_use', id: event.toolCallId, name: event.toolName, input: {} },
                    });
                    writeSSE(reply.raw, 'content_block_delta', {
                      type: 'content_block_delta',
                      index: blockIndex,
                      delta: { type: 'input_json_delta', partial_json: event.input },
                    });
                    currentBlockType = 'tool_use';
                  }

                  if (event.type === 'usage') {
                    streamUsage = event.usage;
                  }


                  if (totalContent.length > v.maxResponseLength) {
                    break;
                  }

                  if (event.type === 'done') break;
                }
              } catch (streamErr) {

                const errMsg = streamErr instanceof Error ? streamErr.message : 'Stream interrupted';
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

                deps.activeRequests.finish(requestId);
                deps.healthChecker.onRequestFailure(route.provider);
                return;
              }


              writeSSE(reply.raw, 'content_block_stop', {
                type: 'content_block_stop',
                index: 0,
              });


              if (!writeSSE(reply.raw, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
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

              deps.activeRequests.finish(requestId);
            });

            return;
          }


          const result = await deps.queue.enqueue(
            route.provider,
            () => provider.execute({
              messages: internalMessages,
              model: route.actualModel,
              stream: false,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              onDebug,
              clientKey,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              providerOverrides: route.providerOverrides,
            }),
          );


          let content = result.content;
          if (content.length > v.maxResponseLength) {
            content = content.substring(0, v.maxResponseLength);
          }


          const response = {
            id: messageId,
            type: 'message' as const,
            role: 'assistant' as const,
            content: [{ type: 'text', text: content }],
            model: body.model,
            stop_reason: toAnthropicStopReason(result.finishReason === 'error' ? 'stop' : result.finishReason),
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

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(response);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
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
            errorMessage: lastError.message,
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
              errorMessage: lastError.message,
            });
          }

          deps.activeRequests.finish(requestId);
          deps.healthChecker.onRequestFailure(route.provider);
          continue;
        }
      }


      if (rateLimitRetryAfter !== null) {
        reply.header('Retry-After', String(rateLimitRetryAfter));
        return reply.status(429).send(makeAnthropicError('rate_limit_error', `Rate limit exceeded. Retry after ${rateLimitRetryAfter} seconds.`));
      }


      const isTimeout = lastError?.message.includes('timed out') ?? false;
      const statusCode = isTimeout ? 504 : 502;
      const errorType = isTimeout ? 'timeout_error' : 'api_error';

      return reply.status(statusCode).send(makeAnthropicError(errorType, `All providers failed for model "${body.model}". Last error: ${sanitizeProviderError(lastError?.message ?? 'unknown')}`));
    },
  );
}
