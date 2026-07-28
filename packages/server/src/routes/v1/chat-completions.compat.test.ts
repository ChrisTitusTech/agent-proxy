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
import { logRequest } from '../../middleware/request-logger.js';
import {
  registerChatCompletionsRoute,
  type ChatCompletionDeps,
} from './chat-completions.js';

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

const result: ExecuteResult = {
  content: 'done',
  usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
  finishReason: 'stop',
};

function createDeps(provider: BaseProvider): ChatCompletionDeps {
  return {
    router: {
      resolve: vi.fn(async () => [{
        provider: 'fixture',
        actualModel: 'fixture-model',
      }]),
    } as unknown as ChatCompletionDeps['router'],
    queue: {
      enqueue: vi.fn(async (_provider: string, run: () => Promise<unknown>) => run()),
    } as unknown as ChatCompletionDeps['queue'],
    rateLimiter: {
      checkGlobalAndKey: vi.fn(() => ({ allowed: true })),
      checkProvider: vi.fn(() => ({ allowed: true })),
    } as unknown as ChatCompletionDeps['rateLimiter'],
    registry: {
      get: vi.fn(() => provider),
      assertExecutionReady: vi.fn(async () => undefined),
    } as unknown as ChatCompletionDeps['registry'],
    healthChecker: {
      isHealthy: vi.fn(async () => true),
      onRequestFailure: vi.fn(),
    } as unknown as ChatCompletionDeps['healthChecker'],
    validation,
    activeRequests: {
      start: vi.fn(),
      finish: vi.fn(),
    } as unknown as ChatCompletionDeps['activeRequests'],
    cache: {
      generateHash: vi.fn(() => 'hash'),
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    } as unknown as ChatCompletionDeps['cache'],
    debug: {
      isEnabled: vi.fn(() => false),
      logStart: vi.fn(),
      logComplete: vi.fn(),
    } as unknown as ChatCompletionDeps['debug'],
  };
}

async function createApp(deps: ChatCompletionDeps): Promise<FastifyInstance> {
  const app = Fastify();
  registerChatCompletionsRoute(app, deps);
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.mocked(logRequest).mockClear();
});

const tool = {
  type: 'function' as const,
  function: {
    name: 'lookup',
    parameters: { type: 'object' },
  },
};

describe('Chat Completions tool compatibility', () => {
  it.each([
    ['required without tools', { tool_choice: 'required' }],
    [
      'an undeclared named choice',
      {
        tools: [tool],
        tool_choice: {
          type: 'function',
          function: { name: 'missing' },
        },
      },
    ],
  ])('rejects %s', async (_label, extra) => {
    const execute = vi.fn(async () => result);
    const deps = createDeps({ name: 'fixture', execute } as unknown as BaseProvider);
    app = await createApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fixture',
        messages: [{ role: 'user', content: 'hello' }],
        ...extra,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe('tool_choice');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed tool definitions before provider dispatch', async () => {
    const execute = vi.fn(async () => result);
    const deps = createDeps({ name: 'fixture', execute } as unknown as BaseProvider);
    app = await createApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fixture',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{}],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe('tools[0]');
    expect(execute).not.toHaveBeenCalled();
  });

  it('counts assistant tool-call arguments toward message limits', async () => {
    const execute = vi.fn(async () => result);
    const deps = createDeps({ name: 'fixture', execute } as unknown as BaseProvider);
    app = await createApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fixture',
        messages: [{
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: 'x'.repeat(validation.maxMessageLength + 1),
            },
          }],
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('function.arguments too long');
    expect(execute).not.toHaveBeenCalled();
  });

  it('bypasses cache and forwards parallel_tool_calls for tools', async () => {
    const execute = vi.fn(async (_options: ExecuteOptions) => result);
    const provider = { name: 'fixture', execute } as unknown as BaseProvider;
    const deps = createDeps(provider);
    app = await createApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fixture',
        messages: [{ role: 'user', content: 'look up Chicago' }],
        tools: [tool],
        tool_choice: 'required',
        parallel_tool_calls: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      tools: [tool],
      toolChoice: 'required',
      parallelToolCalls: false,
    }));
    expect(deps.cache.generateHash).not.toHaveBeenCalled();
    expect(deps.cache.get).not.toHaveBeenCalled();
    expect(deps.cache.set).not.toHaveBeenCalled();
  });

  it('forwards parallel_tool_calls for streaming requests', async () => {
    const executeStream = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<ProviderEvent> {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const provider = {
      name: 'fixture',
      execute: vi.fn(async () => result),
      executeStream,
    } as unknown as BaseProvider;
    const deps = createDeps(provider);
    app = await createApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fixture',
        messages: [{ role: 'user', content: 'look up Chicago' }],
        stream: true,
        tools: [tool],
        parallel_tool_calls: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executeStream).toHaveBeenCalledWith(expect.objectContaining({
      tools: [tool],
      parallelToolCalls: false,
    }));
  });

  it('propagates a streaming client disconnect to the provider signal', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const executeStream = vi.fn(async function* (
      providerOptions: ExecuteOptions,
    ): AsyncIterable<ProviderEvent> {
      observedSignal = providerOptions.signal;
      yield { type: 'text_delta', text: 'started' };
      await new Promise<void>((resolve) => {
        providerOptions.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      releaseProvider();
      throw new Error('Request cancelled');
    });
    const provider = {
      name: 'fixture',
      execute: vi.fn(async () => result),
      executeStream,
    } as unknown as BaseProvider;
    const deps = createDeps(provider);
    app = await createApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();

    await Promise.race([
      providerReleased,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('provider did not observe cancellation')),
        2_000,
      )),
    ]);
    await vi.waitFor(() => {
      expect(deps.activeRequests.finish).toHaveBeenCalledOnce();
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(deps.healthChecker.onRequestFailure).not.toHaveBeenCalled();
  });

  it('returns a 503 before opening SSE when Herdr is unavailable', async () => {
    const executeStream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: 'done' };
    });
    const provider = {
      name: 'fixture',
      execute: vi.fn(async () => result),
      executeStream,
    } as unknown as BaseProvider;
    const deps = createDeps(provider);
    deps.registry.assertExecutionReady = vi.fn(async () => {
      throw new Error('Herdr is unavailable; provider execution was not started.');
    });
    app = await createApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fixture',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(executeStream).not.toHaveBeenCalled();
  });

  it('does not degrade provider health when the local queue is full', async () => {
    const deps = createDeps({
      name: 'fixture',
      execute: vi.fn(async () => result),
    } as unknown as BaseProvider);
    deps.queue.enqueue = vi.fn(async () => {
      throw new Error('fixture queue is full (1 waiting requests).');
    }) as unknown as ChatCompletionDeps['queue']['enqueue'];
    app = await createApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fixture',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('provider_queue_overloaded');
    expect(deps.healthChecker.onRequestFailure).not.toHaveBeenCalled();
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
    const deps = createDeps({
      name: 'fixture',
      execute,
    } as unknown as BaseProvider);
    app = await createApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
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
      return result;
    });
    const deps = createDeps({
      name: 'fixture',
      execute,
    } as unknown as BaseProvider);
    app = await createApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
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

  it('finalizes a disconnect while the provider is still queued', async () => {
    let runQueued!: () => Promise<void>;
    let resolveQueue!: () => void;
    const queueReleased = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });
    const executeStream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: 'done' };
    });
    const provider = {
      name: 'fixture',
      execute: vi.fn(async () => result),
      executeStream,
    } as unknown as BaseProvider;
    const deps = createDeps(provider);
    deps.queue.enqueue = vi.fn(async (
      _provider: string,
      run: () => Promise<void>,
    ) => {
      runQueued = async () => {
        await run();
        resolveQueue();
      };
      await queueReleased;
    }) as unknown as ChatCompletionDeps['queue']['enqueue'];
    app = await createApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => {
      expect(deps.activeRequests.start).toHaveBeenCalledOnce();
      expect(runQueued).toBeTypeOf('function');
    });
    controller.abort();
    await expect(request).rejects.toThrow();
    await vi.waitFor(() => {
      expect(deps.activeRequests.finish).toHaveBeenCalledOnce();
    });
    await runQueued();

    expect(executeStream).not.toHaveBeenCalled();
    expect(deps.healthChecker.onRequestFailure).not.toHaveBeenCalled();
  });
});
