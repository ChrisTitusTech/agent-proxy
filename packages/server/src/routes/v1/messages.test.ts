import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecuteOptions,
  ExecuteResult,
  ProviderEvent,
  ValidationConfig,
} from '@agent-proxy/shared';
import type { BaseProvider } from '../../providers/base-provider.js';
import type { ResolvedRoute } from '../../services/router.js';
import { logRequest } from '../../middleware/request-logger.js';
import {
  normalizeAnthropicMessages,
  registerMessagesRoute,
  type MessagesDeps,
} from './messages.js';

vi.mock('../../middleware/request-logger.js', () => ({
  logRequest: vi.fn(),
}));

const validation: ValidationConfig = {
  maxMessageCount: 100,
  maxMessageLength: 10_000,
  maxPromptLength: 100_000,
  maxResponseLength: 100_000,
  bodyLimitBytes: 1_000_000,
};

const defaultResult: ExecuteResult = {
  content: 'Hello from the provider.',
  usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
  finishReason: 'stop',
};

interface FakeProviderOptions {
  execute?: (options: ExecuteOptions) => Promise<ExecuteResult>;
  executeStream?: (options: ExecuteOptions) => AsyncIterable<ProviderEvent>;
}

function fakeProvider(options: FakeProviderOptions = {}): BaseProvider {
  return {
    name: 'fixture',
    execute: options.execute ?? (async () => defaultResult),
    executeStream: options.executeStream ?? (async function* () {
      yield { type: 'text_delta', text: 'Hello ' };
      yield { type: 'text_delta', text: 'stream.' };
      yield { type: 'usage', usage: defaultResult.usage };
      yield { type: 'done', finishReason: 'stop' };
    }),
  } as unknown as BaseProvider;
}

function createDeps(
  provider = fakeProvider(),
  routes: ResolvedRoute[] = [{ provider: 'fixture', actualModel: 'fixture-model' }],
): MessagesDeps {
  return {
    router: {
      resolve: vi.fn(async () => routes),
    } as unknown as MessagesDeps['router'],
    queue: {
      enqueue: vi.fn(async (_provider: string, run: () => Promise<unknown>) => run()),
    } as unknown as MessagesDeps['queue'],
    rateLimiter: {
      checkGlobalAndKey: vi.fn(() => ({ allowed: true })),
      checkProvider: vi.fn(() => ({ allowed: true })),
    } as unknown as MessagesDeps['rateLimiter'],
    registry: {
      get: vi.fn(() => provider),
      assertExecutionReady: vi.fn(async () => undefined),
    } as unknown as MessagesDeps['registry'],
    healthChecker: {
      isHealthy: vi.fn(async () => true),
      onRequestFailure: vi.fn(),
    } as unknown as MessagesDeps['healthChecker'],
    validation,
    activeRequests: {
      start: vi.fn(),
      finish: vi.fn(),
    } as unknown as MessagesDeps['activeRequests'],
    cache: {
      generateHash: vi.fn(() => 'hash'),
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    } as unknown as MessagesDeps['cache'],
    debug: {
      isEnabled: vi.fn(() => false),
      logStart: vi.fn(),
      logComplete: vi.fn(),
    } as unknown as MessagesDeps['debug'],
  };
}

async function createTestApp(deps: MessagesDeps): Promise<FastifyInstance> {
  const app = Fastify();
  registerMessagesRoute(app, deps);
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.mocked(logRequest).mockClear();
});

describe('Anthropic Messages normalization', () => {
  it('returns a 503 before opening SSE when Herdr is unavailable', async () => {
    const executeStream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: 'done' };
    });
    const deps = createDeps(fakeProvider({ executeStream }));
    deps.registry.assertExecutionReady = vi.fn(async () => {
      throw new Error('Herdr is unavailable; provider execution was not started.');
    });
    app = await createTestApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fixture',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(executeStream).not.toHaveBeenCalled();
  });

  it('propagates a non-streaming client disconnect to the provider signal', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const execute = vi.fn(async (providerOptions: ExecuteOptions) => {
      observedSignal = providerOptions.signal;
      await new Promise<void>((resolve) => {
        providerOptions.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      releaseProvider();
      throw new Error('Request cancelled');
    });
    const deps = createDeps(fakeProvider({ execute }));
    app = await createTestApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();
    await expect(request).rejects.toThrow();
    await providerReleased;

    expect(observedSignal?.aborted).toBe(true);
  });

  it('records cancellation when non-streaming execution returns after disconnect', async () => {
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const execute = vi.fn(async (providerOptions: ExecuteOptions) => {
      await new Promise<void>((resolve) => {
        providerOptions.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      releaseProvider();
      return defaultResult;
    });
    const deps = createDeps(fakeProvider({ execute }));
    app = await createTestApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();
    await expect(request).rejects.toThrow();
    await providerReleased;

    await vi.waitFor(() => {
      expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({
        status: 'cancelled',
        statusCode: 499,
      }));
    });
    expect(vi.mocked(logRequest).mock.calls.some(
      ([entry]) => entry.status === 'success',
    )).toBe(false);
    expect(deps.cache.set).not.toHaveBeenCalled();
  });

  it('keeps observing disconnects while a non-streaming cache write is pending', async () => {
    let cacheStarted!: () => void;
    const cachePending = new Promise<void>((resolve) => {
      cacheStarted = resolve;
    });
    let releaseCache!: () => void;
    const cacheReleased = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    const deps = createDeps(fakeProvider());
    deps.cache.set = vi.fn(async () => {
      cacheStarted();
      await cacheReleased;
    });
    app = await createTestApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
        signal: controller.signal,
      },
    );
    await cachePending;
    controller.abort();
    await expect(request).rejects.toThrow();
    releaseCache();

    await vi.waitFor(() => {
      expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({
        status: 'cancelled',
        statusCode: 499,
      }));
    });
    expect(vi.mocked(logRequest).mock.calls.some(
      ([entry]) => entry.status === 'success',
    )).toBe(false);
  });

  it('records a streaming provider cancellation as cancelled', async () => {
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const executeStream = vi.fn(async function* (
      providerOptions: ExecuteOptions,
    ): AsyncIterable<ProviderEvent> {
      yield { type: 'text_delta', text: 'started' };
      await new Promise<void>((resolve) => {
        providerOptions.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      releaseProvider();
      throw new Error('Request cancelled');
    });
    const deps = createDeps(fakeProvider({ executeStream }));
    app = await createTestApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await providerReleased;

    await vi.waitFor(() => {
      expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({
        status: 'cancelled',
        statusCode: 499,
      }));
      expect(deps.activeRequests.finish).toHaveBeenCalledOnce();
    });
    expect(vi.mocked(logRequest).mock.calls.some(
      ([entry]) => entry.status === 'error',
    )).toBe(false);
    expect(deps.healthChecker.onRequestFailure).not.toHaveBeenCalled();
  });

  it('records cancellation when streaming execution returns after disconnect', async () => {
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const executeStream = vi.fn(async function* (
      providerOptions: ExecuteOptions,
    ): AsyncIterable<ProviderEvent> {
      yield { type: 'text_delta', text: 'started' };
      await new Promise<void>((resolve) => {
        providerOptions.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      releaseProvider();
    });
    const deps = createDeps(fakeProvider({ executeStream }));
    app = await createTestApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await providerReleased;

    await vi.waitFor(() => {
      expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({
        status: 'cancelled',
        statusCode: 499,
      }));
    });
    expect(vi.mocked(logRequest).mock.calls.some(
      ([entry]) => entry.status === 'success',
    )).toBe(false);
    expect(deps.cache.set).not.toHaveBeenCalled();
  });

  it('finalizes a disconnect while the provider is still queued', async () => {
    const executeStream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: 'done' };
    });
    const deps = createDeps(fakeProvider({ executeStream }));
    deps.queue.enqueue = vi.fn((
      _provider: string,
      _run: () => Promise<void>,
      options: { signal?: AbortSignal } = {},
    ) => new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        reject(new Error('fixture queue wait cancelled with request'));
      }, { once: true });
    })) as unknown as MessagesDeps['queue']['enqueue'];
    app = await createTestApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => {
      expect(deps.activeRequests.start).toHaveBeenCalledOnce();
      expect(deps.queue.enqueue).toHaveBeenCalledOnce();
    });
    controller.abort();
    await expect(request).rejects.toThrow();
    await vi.waitFor(() => {
      expect(deps.activeRequests.finish).toHaveBeenCalledOnce();
      expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({
        status: 'cancelled',
        statusCode: 499,
      }));
    });

    expect(executeStream).not.toHaveBeenCalled();
    expect(vi.mocked(logRequest).mock.calls.some(
      ([entry]) => entry.status === 'error',
    )).toBe(false);
    expect(deps.healthChecker.onRequestFailure).not.toHaveBeenCalled();
  });

  it('preserves tool definitions, calls, results, and choice', () => {
    const result = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      system: 'Be concise.',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'lookup',
              input: { city: 'Chicago' },
            },
          ],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: '72F' }],
          }],
        },
      ],
      tools: [{
        name: 'lookup',
        description: 'Look up weather.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
        strict: true,
      }],
      tool_choice: {
        type: 'tool',
        name: 'lookup',
        disable_parallel_tool_use: true,
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{
          id: 'toolu_1',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: '{"city":"Chicago"}',
          },
        }],
      },
      { role: 'tool', content: '72F', tool_call_id: 'toolu_1' },
    ]);
    expect(result.data.tools?.[0].function).toMatchObject({
      name: 'lookup',
      strict: true,
    });
    expect(result.data.toolChoice).toEqual({
      type: 'function',
      function: { name: 'lookup' },
    });
    expect(result.data.parallelToolCalls).toBe(false);
  });

  it('preserves images in Anthropic tool-result content', () => {
    const image = {
      type: 'image',
      source: {
        type: 'url',
        url: 'https://example.test/tool-result.png',
      },
    };
    const normalizedContent = [
      { type: 'text', text: 'Generated image.' },
      image,
      {
        type: 'text',
        text: '{"type":"document","source":{"type":"text","data":"notes"}}',
      },
    ];
    const result = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_image',
          content: [
            { type: 'text', text: 'Generated image.' },
            image,
            { type: 'document', source: { type: 'text', data: 'notes' } },
          ],
        }],
      }],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages).toEqual([{
      role: 'tool',
      tool_call_id: 'toolu_image',
      content: normalizedContent,
    }]);
    expect(result.data.promptLength).toBe(
      'toolu_image'.length + JSON.stringify(normalizedContent).length,
    );
  });

  it('identifies unsupported content blocks exactly', () => {
    const result = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{ type: 'document', source: {} }],
      }],
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'invalid_request_error',
        message: 'Unsupported content block at messages[0].content[0].',
      },
    });
  });

  it('rejects image blocks with empty source values', () => {
    const result = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'url', url: '' },
        }],
      }],
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'invalid_request_error',
        message: 'Unsupported content block at messages[0].content[0].',
      },
    });
  });

  it('preserves Anthropic image blocks alongside user text', () => {
    const image = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'aW1hZ2U=',
      },
    };
    const result = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          image,
        ],
      }],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        image,
      ],
    }]);
  });

  it('accepts thinking blocks on assistant tool-use continuations', () => {
    const result = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'redacted_thinking', data: 'opaque-signature' },
          {
            type: 'tool_use',
            id: 'toolu_thinking',
            name: 'lookup',
            input: { city: 'Chicago' },
          },
        ],
      }],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages).toEqual([{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'toolu_thinking',
        type: 'function',
        function: {
          name: 'lookup',
          arguments: '{"city":"Chicago"}',
        },
      }],
    }]);
  });

  it.each([
    ['assistant', null],
    ['user', 42],
  ])('rejects primitive %s content blocks without throwing', (role, block) => {
    const result = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      messages: [{
        role: role as 'user' | 'assistant',
        content: [block as never],
      }],
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'invalid_request_error',
        message: 'Unsupported content block at messages[0].content[0].',
      },
    });
  });

  it('rejects required and named tool choices without matching declarations', () => {
    const required = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello.' }],
      tool_choice: { type: 'any' },
    });
    const unknown = normalizeAnthropicMessages({
      model: 'claude-test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello.' }],
      tools: [{
        name: 'lookup',
        input_schema: { type: 'object' },
      }],
      tool_choice: { type: 'tool', name: 'missing' },
    });

    expect(required).toMatchObject({
      success: false,
      error: { type: 'invalid_request_error' },
    });
    expect(unknown).toMatchObject({
      success: false,
      error: { type: 'invalid_request_error' },
    });
  });
});

describe('Anthropic Messages tool compatibility', () => {
  it('forwards tools and returns non-streaming tool-use blocks', async () => {
    const execute = vi.fn(async (options: ExecuteOptions): Promise<ExecuteResult> => {
      expect(options.tools?.[0].function.name).toBe('write_fixture');
      expect(options.toolChoice).toBe('required');
      return {
        content: '',
        toolCalls: [{
          id: 'toolu_fixture',
          type: 'function',
          function: {
            name: 'write_fixture',
            arguments: '{"content":"phase3"}',
          },
        }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'tool_calls',
      };
    });
    app = await createTestApp(createDeps(fakeProvider({ execute })));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-test',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Write the fixture.' }],
        tools: [{
          name: 'write_fixture',
          input_schema: { type: 'object' },
        }],
        tool_choice: { type: 'any' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: 'toolu_fixture',
        name: 'write_fixture',
        input: { content: 'phase3' },
      }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('streams one ordered tool-use block with incremental JSON', async () => {
    const executeStream = async function* (): AsyncIterable<ProviderEvent> {
      yield {
        type: 'tool_use',
        toolCallId: 'toolu_stream',
        toolName: 'write_fixture',
        input: '{"content":',
        index: 0,
      };
      yield {
        type: 'tool_use',
        toolCallId: 'toolu_stream',
        toolName: 'write_fixture',
        input: '"phase',
        index: 0,
      };
      yield {
        type: 'tool_use',
        toolCallId: '',
        toolName: '',
        input: '3"}',
        isPartial: true,
        index: 0,
      };
      yield {
        type: 'usage',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
      yield { type: 'done', finishReason: 'tool_use' };
    };
    app = await createTestApp(createDeps(fakeProvider({ executeStream })));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-test',
        max_tokens: 256,
        stream: true,
        messages: [{ role: 'user', content: 'Write the fixture.' }],
        tools: [{
          name: 'write_fixture',
          input_schema: { type: 'object' },
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    const events = response.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const partialJson = events
      .filter((event) => event.type === 'content_block_delta')
      .map((event) => (event.delta as { partial_json: string }).partial_json)
      .join('');
    expect(partialJson).toBe('{"content":"phase3"}');
    expect(events.at(-2)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    });
  });

  it('rejects a non-streaming required-tool response without a tool call', async () => {
    app = await createTestApp(createDeps(fakeProvider({
      execute: async () => defaultResult,
    })));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-test',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Use the lookup tool.' }],
        tools: [{
          name: 'lookup',
          input_schema: { type: 'object' },
        }],
        tool_choice: { type: 'any' },
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain('required tool call');
  });

  it('streams an error when a provider ignores a required tool', async () => {
    app = await createTestApp(createDeps(fakeProvider()));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-test',
        max_tokens: 256,
        stream: true,
        messages: [{ role: 'user', content: 'Use the lookup tool.' }],
        tools: [{
          name: 'lookup',
          input_schema: { type: 'object' },
        }],
        tool_choice: { type: 'any' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"error"');
    expect(response.body).toContain('required tool call');
    expect(response.body).not.toContain('"type":"message_stop"');
  });
});

describe('Anthropic Messages provider errors', () => {
  it.each([
    ['invalid JSON', '{'],
    ['oversized JSON', 'x'.repeat(validation.maxMessageLength + 1)],
  ])('returns %s tool arguments directly without fallback', async (_label, args) => {
    const execute = vi.fn(async (): Promise<ExecuteResult> => ({
      content: '',
      toolCalls: [{
        id: 'toolu_invalid',
        type: 'function',
        function: { name: 'fixture', arguments: args },
      }],
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      finishReason: 'tool_calls',
    }));
    const deps = createDeps(
      fakeProvider({ execute }),
      [
        { provider: 'primary', actualModel: 'fixture-model' },
        { provider: 'fallback', actualModel: 'fixture-model' },
      ],
    );
    app = await createTestApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-test',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello.' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.type).toBe('api_error');
    expect(execute).toHaveBeenCalledOnce();
    expect(deps.healthChecker.onRequestFailure).not.toHaveBeenCalled();
  });

  it('returns an actionable sanitized expired-login error', async () => {
    app = await createTestApp(createDeps(fakeProvider({
      execute: async () => {
        throw new Error(
          'OAuth token expired for person@example.test in /var/lib/agent-proxy/private.',
        );
      },
    })));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-test',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello.' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: "Fixture login expired. Refresh the logged-in user's provider session.",
      },
    });
    expect(response.body).not.toContain('person@example.test');
    expect(response.body).not.toContain('/var/lib');
  });
});
