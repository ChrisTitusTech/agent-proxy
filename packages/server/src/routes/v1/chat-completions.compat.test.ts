import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecuteOptions,
  ExecuteResult,
  ProviderEvent,
  ValidationConfig,
} from '@agent-proxy/shared';
import type { BaseProvider } from '../../providers/base-provider.js';
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
});
