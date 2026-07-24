import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseProvider,
} from '../../providers/base-provider.js';
import { HttpProvider } from '../../providers/http-provider.js';
import type { ResolvedRoute } from '../../services/router.js';
import type {
  ExecuteOptions,
  ExecuteResult,
  ProviderEvent,
  ValidationConfig,
} from '@agent-proxy/shared';
import type { ResponsesDeps } from './responses.js';
import { registerResponsesRoute } from './responses.js';
import {
  normalizeResponsesInput,
  parseResponsesRequest,
  type ResponsesRequest,
} from './responses-schema.js';
import { ResponsesStore } from './responses-store.js';

const validation: ValidationConfig = {
  maxMessageCount: 100,
  maxMessageLength: 10_000,
  maxPromptLength: 100_000,
  maxResponseLength: 100_000,
  bodyLimitBytes: 1_000_000,
};

const defaultResult: ExecuteResult = {
  content: 'Hello from the provider.',
  usage: {
    promptTokens: 4,
    completionTokens: 5,
    totalTokens: 9,
  },
  finishReason: 'stop',
};

interface FakeProviderOptions {
  name?: string;
  execute?: (options: ExecuteOptions) => Promise<ExecuteResult>;
  executeStream?: (options: ExecuteOptions) => AsyncIterable<ProviderEvent>;
}

function fakeProvider(options: FakeProviderOptions = {}): BaseProvider {
  return {
    name: options.name ?? 'codex',
    execute: options.execute ?? (async () => defaultResult),
    executeStream: options.executeStream ?? (async function* () {
      yield { type: 'text_delta', text: 'Hello ' };
      yield { type: 'text_delta', text: 'stream.' };
      yield { type: 'usage', usage: defaultResult.usage };
      yield { type: 'done', finishReason: 'stop' };
    }),
    getConfig: () => ({
      enabled: true,
      cli_path: 'fake',
      default_model: 'fake-model',
      max_concurrent: 1,
      timeout_ms: 1_000,
      extra_args: [],
    }),
  } as unknown as BaseProvider;
}

function createDeps(
  providers: Record<string, BaseProvider> = { codex: fakeProvider() },
  routes: ResolvedRoute[] = [{ provider: 'codex', actualModel: 'fake-model' }],
  store = new ResponsesStore(),
): ResponsesDeps {
  return {
    router: {
      resolve: vi.fn(async () => routes),
    } as unknown as ResponsesDeps['router'],
    queue: {
      enqueue: vi.fn(async (_provider: string, run: () => Promise<unknown>) => run()),
    } as unknown as ResponsesDeps['queue'],
    rateLimiter: {
      checkGlobalAndKey: vi.fn(() => ({ allowed: true })),
      checkProvider: vi.fn(() => ({ allowed: true })),
    } as unknown as ResponsesDeps['rateLimiter'],
    registry: {
      get: vi.fn((name: string) => providers[name]),
    } as unknown as ResponsesDeps['registry'],
    healthChecker: {
      isHealthy: vi.fn(async () => true),
      onRequestFailure: vi.fn(async () => undefined),
    } as unknown as ResponsesDeps['healthChecker'],
    validation,
    activeRequests: {
      start: vi.fn(),
      finish: vi.fn(),
    } as unknown as ResponsesDeps['activeRequests'],
    store,
    requestLogger: vi.fn(),
  };
}

async function createTestApp(deps = createDeps()): Promise<FastifyInstance> {
  const testApp = Fastify();
  registerResponsesRoute(testApp, deps);
  await testApp.ready();
  return testApp;
}

async function createSdkClient(
  deps = createDeps(),
): Promise<{ app: FastifyInstance; client: OpenAI }> {
  const testApp = await createTestApp(deps);
  await testApp.listen({ host: '127.0.0.1', port: 0 });
  const address = testApp.server.address() as AddressInfo;
  return {
    app: testApp,
    client: new OpenAI({
      apiKey: 'sk-proxy-test',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    }),
  };
}

let app: FastifyInstance | undefined;
let upstreamApp: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await upstreamApp?.close();
  app = undefined;
  upstreamApp = undefined;
});

describe('Responses request validation', () => {
  it('accepts the documented Phase 2 request fields', () => {
    const parsed = parseResponsesRequest({
      model: 'gpt-test',
      input: 'hello',
      instructions: 'be concise',
      stream: false,
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: true,
      }],
      tool_choice: { type: 'function', name: 'lookup' },
      max_output_tokens: 100,
      reasoning: { effort: 'high', summary: 'auto' },
      previous_response_id: 'resp_previous',
      store: true,
      metadata: { tenant: 'test' },
      parallel_tool_calls: false,
      temperature: 0.2,
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    [{ input: 'hello' }, 'model'],
    [{ model: 'gpt-test' }, 'input'],
    [{ model: 'gpt-test', input: 'hello', unsupported: true }, 'unsupported'],
    [{ model: 'gpt-test', input: 'hello', max_output_tokens: 0 }, 'max_output_tokens'],
    [{
      model: 'gpt-test',
      input: 'hello',
      tools: [{ type: 'web_search' }],
    }, 'tools[0].type'],
  ])('returns an exact parameter for invalid input %#', async (body, param) => {
    app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: 'invalid_request_error',
      param,
    });
  });
});

describe('Responses input normalization', () => {
  it('preserves instructions, roles, images, function calls, and results', () => {
    const request = {
      model: 'gpt-test',
      instructions: 'Current instructions',
      input: [
        {
          role: 'developer',
          content: [{ type: 'input_text', text: 'Developer context' }],
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect this' },
            {
              type: 'input_image',
              image_url: 'https://example.test/im\u0000age.png',
              detail: 'high',
            },
            {
              type: 'input_image',
              file_id: 'file\u0000_123',
            },
          ],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'look\u0000up',
          arguments: '{"id":\u00001}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: { value: 'done' },
        },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Finished' }],
        },
      ],
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: true,
      }],
      tool_choice: { type: 'function', name: 'lookup' },
    } satisfies ResponsesRequest;

    const result = normalizeResponsesInput(request, validation);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.instructionMessages).toEqual([
      { role: 'developer', content: 'Current instructions' },
    ]);
    expect(result.data.inputMessages).toEqual([
      {
        role: 'developer',
        content: [{ type: 'text', text: 'Developer context' }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this' },
          {
            type: 'image_url',
            image_url: {
              url: 'https://example.test/image.png',
              detail: 'high',
            },
          },
          {
            type: 'input_image',
            file_id: 'file_123',
          },
        ],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":1}' },
        }],
      },
      {
        role: 'tool',
        content: '{"value":"done"}',
        tool_call_id: 'call_1',
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Finished' }],
      },
    ]);
    expect(result.data.tools?.[0].function.strict).toBe(true);
    expect(result.data.toolChoice).toEqual({
      type: 'function',
      function: { name: 'lookup' },
    });
  });

  it.each([
    [
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '123456',
      },
      'input[0].arguments',
    ],
    [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '123456',
      },
      'input[0].output',
    ],
  ])('enforces per-message limits for function items %#', (item, param) => {
    const result = normalizeResponsesInput({
      model: 'gpt-test',
      input: [item],
    } as ResponsesRequest, {
      ...validation,
      maxMessageLength: 5,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.error).toMatchObject({
      param,
      code: 'string_too_long',
    });
  });
});

describe('Responses SDK compatibility', () => {
  it('returns a complete non-streaming response through the OpenAI SDK', async () => {
    const fixture = await createSdkClient();
    app = fixture.app;

    const response = await fixture.client.responses.create({
      model: 'gpt-test',
      input: 'hello',
      reasoning: { effort: 'high' },
    });

    expect(response.id).toMatch(/^resp_/);
    expect(response.status).toBe('completed');
    expect(response.output_text).toBe('Hello from the provider.');
    expect(response.usage).toMatchObject({
      input_tokens: 4,
      output_tokens: 5,
      total_tokens: 9,
    });
  });

  it('streams ordered typed events through the OpenAI SDK', async () => {
    const fixture = await createSdkClient();
    app = fixture.app;
    const stream = await fixture.client.responses.create({
      model: 'gpt-test',
      input: 'hello',
      stream: true,
    });

    const eventTypes: string[] = [];
    let text = '';
    let createdAt: number | undefined;
    let completedAt: number | undefined;
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === 'response.output_text.delta') text += event.delta;
      if (event.type === 'response.created') {
        createdAt = event.response.created_at;
      }
      if (event.type === 'response.completed') {
        completedAt = event.response.created_at;
      }
    }

    expect(text).toBe('Hello stream.');
    expect(eventTypes).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(completedAt).toBe(createdAt);
  });

  it('coalesces streamed function argument deltas by tool index', async () => {
    const provider = fakeProvider({
      executeStream: async function* () {
        yield {
          type: 'tool_use',
          toolCallId: 'call_stream_1',
          toolName: 'lookup',
          input: '{"id":',
          index: 0,
        };
        yield {
          type: 'tool_use',
          toolCallId: '',
          toolName: '',
          input: '7}',
          isPartial: true,
          index: 0,
        };
        yield { type: 'done', finishReason: 'tool_use' };
      },
    });
    const fixture = await createSdkClient(createDeps({ codex: provider }));
    app = fixture.app;
    const stream = await fixture.client.responses.create({
      model: 'gpt-test',
      input: 'lookup',
      tools: [{
        type: 'function',
        name: 'lookup',
        strict: false,
        parameters: { type: 'object' },
      }],
      stream: true,
    });

    const events = [];
    for await (const event of stream) events.push(event);
    const completed = events.find((event) => event.type === 'response.completed');
    expect(completed?.response.output).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_stream_1',
        name: 'lookup',
        arguments: '{"id":7}',
      }),
    ]);
  });

  it('waits for streamed function metadata before forwarding the call', async () => {
    const provider = fakeProvider({
      executeStream: async function* () {
        yield {
          type: 'tool_use',
          toolCallId: '',
          toolName: '',
          input: '{"id":',
          isPartial: true,
          index: 0,
        };
        yield {
          type: 'tool_use',
          toolCallId: 'call_stream_late',
          toolName: 'lookup',
          input: '7}',
          index: 0,
        };
        yield { type: 'done', finishReason: 'tool_use' };
      },
    });
    const fixture = await createSdkClient(createDeps({ codex: provider }));
    app = fixture.app;
    const stream = await fixture.client.responses.create({
      model: 'gpt-test',
      input: 'lookup',
      tools: [{
        type: 'function',
        name: 'lookup',
        strict: false,
        parameters: { type: 'object' },
      }],
      tool_choice: { type: 'function', name: 'lookup' },
      stream: true,
    });

    const events = [];
    for await (const event of stream) events.push(event);
    const completed = events.find((event) => event.type === 'response.completed');
    expect(completed?.response.output).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_stream_late',
        name: 'lookup',
        arguments: '{"id":7}',
      }),
    ]);
    expect(events
      .filter((event) => event.type === 'response.function_call_arguments.delta')
      .map((event) => event.delta)
      .join('')).toBe('{"id":7}');
  });

  it('reflects only configured CORS origins on raw SSE responses', async () => {
    const allowedDeps = createDeps();
    allowedDeps.corsOrigins = ['https://allowed.example'];
    app = await createTestApp(allowedDeps);

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { origin: 'https://allowed.example' },
      payload: { model: 'gpt-test', input: 'hello', stream: true },
    });
    expect(allowed.headers['access-control-allow-origin'])
      .toBe('https://allowed.example');

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { origin: 'https://denied.example' },
      payload: { model: 'gpt-test', input: 'hello', stream: true },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Responses function tool loop', () => {
  it('round-trips call IDs, strict tools, and function output', async () => {
    const execute = vi.fn(async (options: ExecuteOptions): Promise<ExecuteResult> => {
      if (execute.mock.calls.length === 1) {
        expect(options.tools?.[0].function).toMatchObject({
          name: 'lookup_weather',
          strict: true,
        });
        return {
          content: '',
          toolCalls: [{
            id: 'call_weather_1',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: '{"city":"Chicago"}',
            },
          }],
          usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
          finishReason: 'tool_calls',
        };
      }

      expect(options.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [expect.objectContaining({ id: 'call_weather_1' })],
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_weather_1',
          content: '72F',
        }),
      ]));
      return {
        content: 'It is 72F in Chicago.',
        usage: { promptTokens: 18, completionTokens: 7, totalTokens: 25 },
        finishReason: 'stop',
      };
    });

    const deps = createDeps({ codex: fakeProvider({ execute }) });
    const fixture = await createSdkClient(deps);
    app = fixture.app;

    const first = await fixture.client.responses.create({
      model: 'gpt-test',
      input: 'What is the weather?',
      tools: [{
        type: 'function',
        name: 'lookup_weather',
        strict: true,
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
      }],
      tool_choice: 'required',
    });
    const call = first.output.find((item) => item.type === 'function_call');
    expect(call).toMatchObject({
      type: 'function_call',
      call_id: 'call_weather_1',
      name: 'lookup_weather',
      arguments: '{"city":"Chicago"}',
    });

    const second = await fixture.client.responses.create({
      model: 'gpt-test',
      previous_response_id: first.id,
      input: [{
        type: 'function_call_output',
        call_id: 'call_weather_1',
        output: '72F',
      }],
    });
    expect(second.output_text).toBe('It is 72F in Chicago.');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects an orphaned function result', async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: [{
          type: 'function_call_output',
          call_id: 'missing_call',
          output: 'result',
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      param: 'input[0].call_id',
      code: 'function_call_not_found',
    });
  });

  it('completes a tool loop through the real HTTP provider adapter', async () => {
    upstreamApp = Fastify();
    let requestCount = 0;
    upstreamApp.post('/chat/completions', async (request) => {
      requestCount++;
      const body = request.body as Record<string, unknown>;
      const messages = body.messages as Array<Record<string, unknown>>;

      if (requestCount === 1) {
        expect(messages[0]).toEqual({
          role: 'developer',
          content: 'Use the record lookup tool.',
        });
        expect(messages[1]).toMatchObject({
          role: 'user',
          content: [
            { type: 'text', text: 'Find record seven.' },
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.test/record-seven.png',
                detail: 'high',
              },
            },
          ],
        });
        expect(body.tools).toEqual([
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: {
                type: 'object',
                properties: { id: { type: 'number' } },
                required: ['id'],
                additionalProperties: false,
              },
              strict: true,
            },
          },
        ]);
        expect(body.tool_choice).toBe('required');
        expect(body.parallel_tool_calls).toBe(false);
        return {
          id: 'chatcmpl-tool',
          object: 'chat.completion',
          created: 1,
          model: 'upstream-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_http_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"id":7}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        };
      }

      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [expect.objectContaining({ id: 'call_http_1' })],
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_http_1',
          content: 'record seven',
        }),
      ]));
      return {
        id: 'chatcmpl-final',
        object: 'chat.completion',
        created: 2,
        model: 'upstream-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'The record is seven.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      };
    });
    await upstreamApp.listen({ host: '127.0.0.1', port: 0 });
    const upstreamAddress = upstreamApp.server.address() as AddressInfo;
    const provider = new HttpProvider('live-http', {
      enabled: true,
      base_url: `http://127.0.0.1:${upstreamAddress.port}`,
      allow_private_network: true,
      default_model: 'upstream-model',
      max_concurrent: 1,
      timeout_ms: 5_000,
      display_name: 'Live test provider',
    });
    const deps = createDeps(
      { 'live-http': provider },
      [{ provider: 'live-http', actualModel: 'upstream-model' }],
    );
    const fixture = await createSdkClient(deps);
    app = fixture.app;

    const first = await fixture.client.responses.create({
      model: 'http-alias',
      instructions: 'Use the record lookup tool.',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Find record seven.' },
          {
            type: 'input_image',
            image_url: 'https://example.test/record-seven.png',
            detail: 'high',
          },
        ],
      }],
      tools: [{
        type: 'function',
        name: 'lookup',
        strict: true,
        parameters: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id'],
          additionalProperties: false,
        },
      }],
      tool_choice: 'required',
      parallel_tool_calls: false,
    });
    const call = first.output.find((item) => item.type === 'function_call');
    expect(call).toMatchObject({ call_id: 'call_http_1', name: 'lookup' });

    const second = await fixture.client.responses.create({
      model: 'http-alias',
      previous_response_id: first.id,
      input: [{
        type: 'function_call_output',
        call_id: 'call_http_1',
        output: 'record seven',
      }],
    });

    expect(second.output_text).toBe('The record is seven.');
    expect(requestCount).toBe(2);
  });
});

describe('Responses continuation and retention', () => {
  it('retains context while requiring current instructions to be resent', async () => {
    const executions: ExecuteOptions[] = [];
    const provider = fakeProvider({
      execute: async (options) => {
        executions.push(options);
        return defaultResult;
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));

    const first = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'x-agent-proxy-session-id': 'client-a' },
      payload: {
        model: 'gpt-test',
        instructions: 'First instructions',
        input: [
          { role: 'developer', content: 'Persisted developer item' },
          { role: 'user', content: 'first' },
        ],
      },
    });
    const firstId = first.json().id as string;

    const second = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'x-agent-proxy-session-id': 'client-a' },
      payload: {
        model: 'gpt-test',
        instructions: 'Second instructions',
        previous_response_id: firstId,
        input: 'second',
      },
    });

    expect(second.statusCode).toBe(200);
    expect(executions[1].messages).toEqual([
      { role: 'developer', content: 'Persisted developer item' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'Hello from the provider.' },
      { role: 'developer', content: 'Second instructions' },
      { role: 'user', content: 'second' },
    ]);
    expect(executions[0].clientKey).toBeDefined();
    expect(executions[1].clientKey).toBeUndefined();

    const third = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'x-agent-proxy-session-id': 'client-a' },
      payload: {
        model: 'gpt-test',
        instructions: 'Third instructions',
        previous_response_id: second.json().id,
        input: 'third',
      },
    });
    expect(third.statusCode).toBe(200);
    expect(executions[2].messages).toEqual([
      { role: 'developer', content: 'Persisted developer item' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'Hello from the provider.' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'Hello from the provider.' },
      { role: 'developer', content: 'Third instructions' },
      { role: 'user', content: 'third' },
    ]);
    expect(executions[2].clientKey).toBeUndefined();
  });

  it('does not retain incomplete function calls as outstanding context', async () => {
    let callCount = 0;
    const executions: ExecuteOptions[] = [];
    const provider = fakeProvider({
      execute: async (options) => {
        executions.push(options);
        callCount++;
        if (callCount === 1) {
          return {
            ...defaultResult,
            content: '',
            toolCalls: [{
              id: 'call_incomplete',
              type: 'function',
              function: { name: 'lookup', arguments: '{"id":' },
            }],
            finishReason: 'length',
          };
        }
        return defaultResult;
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));

    const first = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'first',
        tools: [{ type: 'function', name: 'lookup' }],
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('incomplete');

    const second = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        previous_response_id: first.json().id,
        input: 'continue without a tool result',
      },
    });

    expect(second.statusCode).toBe(200);
    expect(executions[1].messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'continue without a tool result' },
    ]);
  });

  it('isolates previous responses by client and model', async () => {
    app = await createTestApp();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'x-agent-proxy-session-id': 'client-a' },
      payload: { model: 'gpt-test', input: 'first' },
    });
    const previousId = first.json().id as string;

    const crossClient = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'x-agent-proxy-session-id': 'client-b' },
      payload: {
        model: 'gpt-test',
        previous_response_id: previousId,
        input: 'second',
      },
    });
    expect(crossClient.statusCode).toBe(404);
    expect(crossClient.json().error.code).toBe('response_not_found');

    const modelChange = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'x-agent-proxy-session-id': 'client-a' },
      payload: {
        model: 'other-model',
        previous_response_id: previousId,
        input: 'second',
      },
    });
    expect(modelChange.statusCode).toBe(400);
    expect(modelChange.json().error.code).toBe('model_mismatch');
  });

  it('isolates a shared session ID by authenticated API key', async () => {
    const testApp = Fastify();
    testApp.addHook('preHandler', async (request) => {
      const apiKeyId = request.headers['x-test-api-key-id'];
      (request as typeof request & { apiKeyId?: string }).apiKeyId =
        typeof apiKeyId === 'string' ? apiKeyId : undefined;
    });
    registerResponsesRoute(testApp, createDeps());
    await testApp.ready();
    app = testApp;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'x-agent-proxy-session-id': 'shared-session',
        'x-test-api-key-id': 'key-a',
      },
      payload: { model: 'gpt-test', input: 'first' },
    });
    const previousId = first.json().id as string;

    const crossKey = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'x-agent-proxy-session-id': 'shared-session',
        'x-test-api-key-id': 'key-b',
      },
      payload: {
        model: 'gpt-test',
        previous_response_id: previousId,
        input: 'second',
      },
    });
    expect(crossKey.statusCode).toBe(404);
    expect(crossKey.json().error.code).toBe('response_not_found');

    const sameKey = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'x-agent-proxy-session-id': 'shared-session',
        'x-test-api-key-id': 'key-a',
      },
      payload: {
        model: 'gpt-test',
        previous_response_id: previousId,
        input: 'second',
      },
    });
    expect(sameKey.statusCode).toBe(200);
  });

  it.each([
    {
      name: 'message count',
      validationOverrides: { maxMessageCount: 2 },
      contextMessages: [
        { role: 'user' as const, content: 'first' },
        { role: 'assistant' as const, content: 'answer' },
      ],
      code: 'too_many_messages',
    },
    {
      name: 'prompt length',
      validationOverrides: { maxPromptLength: 10 },
      contextMessages: [
        { role: 'user' as const, content: '1234567890' },
      ],
      code: 'prompt_too_long',
    },
  ])('revalidates cumulative continuation $name', async ({
    validationOverrides,
    contextMessages,
    code,
  }) => {
    const store = new ResponsesStore();
    store.set({
      id: 'resp_previous',
      clientKey: 'anonymous',
      model: 'gpt-test',
      contextMessages,
      outstandingCallIds: [],
    });
    const execute = vi.fn(async () => defaultResult);
    const deps = createDeps(
      { codex: fakeProvider({ execute }) },
      undefined,
      store,
    );
    deps.validation = {
      ...validation,
      ...validationOverrides,
    };
    app = await createTestApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        previous_response_id: 'resp_previous',
        input: 'x',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      param: 'previous_response_id',
      code,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects outputs before their call and duplicate answered outputs', async () => {
    const outputBeforeCall = await createTestApp().then(async (testApp) => {
      app = testApp;
      return app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: {
          model: 'gpt-test',
          input: [
            {
              type: 'function_call_output',
              call_id: 'call_late',
              output: 'too early',
            },
            {
              type: 'function_call',
              call_id: 'call_late',
              name: 'lookup',
              arguments: '{}',
            },
          ],
        },
      });
    });
    expect(outputBeforeCall.statusCode).toBe(400);
    expect(outputBeforeCall.json().error.param).toBe('input[0].call_id');
    await app?.close();
    app = undefined;

    let callCount = 0;
    const provider = fakeProvider({
      execute: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'call_once',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            }],
            usage: defaultResult.usage,
            finishReason: 'tool_calls',
          };
        }
        return defaultResult;
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const first = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'lookup',
        tools: [{ type: 'function', name: 'lookup' }],
      },
    });
    const skippedOutput = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        previous_response_id: first.json().id,
        input: 'skip the tool result',
      },
    });
    expect(skippedOutput.statusCode).toBe(400);
    expect(skippedOutput.json().error).toMatchObject({
      param: 'input',
      code: 'function_call_output_required',
    });

    const second = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        previous_response_id: first.json().id,
        input: [{
          type: 'function_call_output',
          call_id: 'call_once',
          output: 'done',
        }],
      },
    });
    expect(second.statusCode).toBe(200);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        previous_response_id: second.json().id,
        input: [{
          type: 'function_call_output',
          call_id: 'call_once',
          output: 'done again',
        }],
      },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toMatchObject({
      param: 'input[0].call_id',
      code: 'function_call_not_found',
    });
    expect(callCount).toBe(2);
  });

  it('does not retain a response when store is false', async () => {
    app = await createTestApp();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'first',
        store: false,
      },
    });
    const continuation = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        previous_response_id: first.json().id,
        input: 'second',
      },
    });

    expect(continuation.statusCode).toBe(404);
    expect(continuation.json().error.code).toBe('response_not_found');
  });

  it('expires entries and enforces the retention bound', () => {
    let now = 1_000;
    const store = new ResponsesStore({
      ttlMs: 100,
      maxEntries: 2,
      now: () => now,
    });
    const entry = (id: string) => ({
      id,
      clientKey: 'client',
      model: 'model',
      contextMessages: [],
      outstandingCallIds: [],
    });

    store.set(entry('one'));
    store.set(entry('two'));
    store.set(entry('three'));
    expect(store.get('one', 'client')).toBeNull();
    expect(store.size).toBe(2);

    now += 101;
    expect(store.get('two', 'client')).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe('Responses provider contract safeguards', () => {
  it('allows an explicit auto tool choice without tools', async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        tool_choice: 'auto',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('completed');
  });

  it('rejects parallel provider calls when parallel_tool_calls is false', async () => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":1}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":2}' },
          },
        ],
        finishReason: 'tool_calls',
      }),
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        tools: [{ type: 'function', name: 'lookup' }],
        parallel_tool_calls: false,
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain('parallel function calls');
  });

  it('rejects provider calls for tools that were not advertised', async () => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        content: '',
        toolCalls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        }],
        finishReason: 'tool_calls',
      }),
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain('undeclared tool');
  });

  it.each([
    { name: 'missing', ids: ['', 'call_2'], message: 'without an ID' },
    { name: 'duplicate', ids: ['call_1', 'call_1'], message: 'duplicate function call IDs' },
  ])('rejects $name provider function call IDs', async ({ ids, message }) => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        content: '',
        toolCalls: ids.map((id) => ({
          id,
          type: 'function' as const,
          function: { name: 'lookup', arguments: '{}' },
        })),
        finishReason: 'tool_calls',
      }),
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        tools: [{ type: 'function', name: 'lookup' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain(message);
  });

  it('fails an undeclared streamed tool before emitting its output item', async () => {
    const provider = fakeProvider({
      executeStream: async function* () {
        yield {
          type: 'tool_use',
          toolCallId: 'call_1',
          toolName: 'unexpected',
          input: '{}',
        };
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        stream: true,
        tools: [{ type: 'function', name: 'lookup' }],
      },
    });

    expect(response.body).toContain('event: response.failed');
    expect(response.body).not.toContain('response.function_call_arguments.delta');
    expect(response.body).not.toContain('"name":"unexpected"');
  });

  it('enforces a named tool choice after provider execution', async () => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        content: '',
        toolCalls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'other_tool', arguments: '{}' },
        }],
        finishReason: 'tool_calls',
      }),
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        tools: [
          { type: 'function', name: 'lookup' },
          { type: 'function', name: 'other_tool' },
        ],
        tool_choice: { type: 'function', name: 'lookup' },
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("required function 'lookup'");
  });

  it('rejects non-streaming provider calls when tool_choice is none', async () => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        content: '',
        toolCalls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        }],
        finishReason: 'tool_calls',
      }),
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        tools: [{ type: 'function', name: 'lookup' }],
        tool_choice: 'none',
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain('tool_choice is none');
  });

  it('rejects streaming provider calls before forwarding when tool_choice is none', async () => {
    const provider = fakeProvider({
      executeStream: async function* () {
        yield {
          type: 'tool_use',
          toolCallId: 'call_1',
          toolName: 'lookup',
          input: '{}',
        };
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        stream: true,
        tools: [{ type: 'function', name: 'lookup' }],
        tool_choice: 'none',
      },
    });

    expect(response.body).toContain('event: response.failed');
    expect(response.body).not.toContain('response.function_call_arguments.delta');
    expect(response.body).not.toContain('"type":"function_call"');
  });

  it.each([
    {
      name: 'request summary',
      reasoning: { summary: 'auto' as const },
      includeReasoning: null,
    },
    {
      name: 'route setting',
      reasoning: undefined,
      includeReasoning: true,
    },
  ])('includes provider reasoning for an opted-in $name', async ({
    reasoning,
    includeReasoning,
  }) => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        reasoning: 'Concise reasoning summary.',
      }),
    });
    const routes: ResolvedRoute[] = [{
      provider: 'codex',
      actualModel: 'fake-model',
      includeReasoning,
    }];
    app = await createTestApp(createDeps({ codex: provider }, routes));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        ...(reasoning ? { reasoning } : {}),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reasoning',
        summary: [{
          type: 'summary_text',
          text: 'Concise reasoning summary.',
        }],
      }),
    ]));
  });

  it('suppresses provider reasoning without a request or route opt-in', async () => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        reasoning: 'Internal reasoning must stay hidden.',
      }),
      executeStream: async function* () {
        yield { type: 'thinking', text: 'Internal stream reasoning.' };
        yield { type: 'text_delta', text: 'Visible answer.' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    const deps = createDeps(
      { codex: provider },
      [{
        provider: 'codex',
        actualModel: 'fake-model',
        includeReasoning: false,
      }],
    );
    app = await createTestApp(deps);

    const buffered = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello' },
    });
    expect(buffered.statusCode).toBe(200);
    expect(buffered.json().output).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning' }),
    ]));
    expect(
      buffered.json().usage.output_tokens_details.reasoning_tokens,
    ).toBe(0);

    const streamed = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello', stream: true },
    });
    expect(streamed.body).toContain('Visible answer.');
    expect(streamed.body).not.toContain('Internal stream reasoning.');
    expect(streamed.body).not.toContain('reasoning_summary_text');
  });

  it('bounds opted-in reasoning summaries in buffered responses', async () => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        reasoning: '12345678',
      }),
    });
    const deps = createDeps({ codex: provider });
    deps.validation = { ...validation, maxResponseLength: 5 };
    app = await createTestApp(deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        reasoning: { summary: 'auto' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('incomplete');
    expect(response.json().output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '12345' }],
      }),
    ]));
  });

  it('fails a stream before forwarding oversized function arguments', async () => {
    const provider = fakeProvider({
      executeStream: async function* () {
        yield {
          type: 'tool_use',
          toolCallId: 'call_1',
          toolName: 'lookup',
          input: '123456',
        };
      },
    });
    const deps = createDeps({ codex: provider });
    deps.validation = {
      ...validation,
      maxMessageLength: 5,
    };
    app = await createTestApp(deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        stream: true,
        tools: [{ type: 'function', name: 'lookup' }],
      },
    });

    expect(response.body).toContain('event: response.failed');
    expect(response.body).toContain('function arguments longer than 5');
    expect(response.body).not.toContain('response.function_call_arguments.delta');
  });

  it('caps streamed text and completes with an incomplete response', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider = fakeProvider({
      executeStream: async function* (options) {
        providerSignal = options.signal;
        yield { type: 'text_delta', text: '1234' };
        yield { type: 'text_delta', text: '5678' };
        yield { type: 'text_delta', text: 'not-forwarded' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    const deps = createDeps({ codex: provider });
    deps.validation = {
      ...validation,
      maxResponseLength: 5,
    };
    app = await createTestApp(deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        stream: true,
      },
    });

    const terminalMatch = response.body.match(
      /event: response\.incomplete\ndata: (.+)\n/,
    );
    expect(terminalMatch).not.toBeNull();
    const terminal = JSON.parse(terminalMatch![1]);
    expect(terminal.response.output[0].content[0].text).toBe('12345');
    const deltas = [...response.body.matchAll(
      /event: response\.output_text\.delta\ndata: (.+)\n/g,
    )].map((match) => JSON.parse(match[1]).delta).join('');
    expect(deltas).toBe('12345');
    expect(deltas).not.toContain('not-forwarded');
    expect(providerSignal?.aborted).toBe(true);
  });

  it('caps streamed reasoning and aborts the provider', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider = fakeProvider({
      executeStream: async function* (options) {
        providerSignal = options.signal;
        yield { type: 'thinking', text: '1234' };
        yield { type: 'thinking', text: '5678' };
        yield { type: 'thinking', text: 'not-forwarded' };
      },
    });
    const deps = createDeps({ codex: provider });
    deps.validation = { ...validation, maxResponseLength: 5 };
    app = await createTestApp(deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        reasoning: { summary: 'auto' },
        stream: true,
      },
    });

    expect(response.body).toContain('event: response.incomplete');
    expect(response.body).toContain('"text":"12345"');
    expect(response.body).not.toContain('not-forwarded');
    expect(providerSignal?.aborted).toBe(true);
  });

  it('returns a provider rate limit after skipping an unhealthy route', async () => {
    const deps = createDeps(
      {
        codex: fakeProvider({ name: 'codex' }),
        grok: fakeProvider({ name: 'grok' }),
      },
      [
        { provider: 'codex', actualModel: 'codex-model' },
        { provider: 'grok', actualModel: 'grok-model' },
      ],
    );
    deps.healthChecker.isHealthy = vi.fn(async (provider) => provider === 'grok');
    deps.rateLimiter.checkProvider = vi.fn(() => ({
      allowed: false,
      retryAfterSeconds: 17,
    }));
    app = await createTestApp(deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.json().error.type).toBe('rate_limit_error');
    expect(response.json().error.code).toBe('rate_limit_exceeded');
  });
});

describe('Responses cancellation, failures, and fallback', () => {
  it('rejects a non-streaming provider error finish reason', async () => {
    const provider = fakeProvider({
      execute: async () => ({
        ...defaultResult,
        finishReason: 'error',
      }),
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain('unsuccessful completion');
  });

  it('fails a stream whose done event reports an error', async () => {
    const provider = fakeProvider({
      executeStream: async function* () {
        yield { type: 'text_delta', text: 'partial' };
        yield { type: 'done', finishReason: 'error' };
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello', stream: true },
    });

    const terminals = [...response.body.matchAll(
      /event: response\.(completed|incomplete|failed)/g,
    )].map((match) => match[1]);
    expect(terminals).toEqual(['failed']);
    expect(response.body).toContain('unsuccessful completion');
  });

  it('returns a timeout error with a compatible HTTP status', async () => {
    const provider = fakeProvider({
      execute: async () => {
        throw new Error('fake CLI timed out after 10ms');
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello' },
    });

    expect(response.statusCode).toBe(504);
    expect(response.json().error.type).toBe('timeout_error');
    expect(response.json().error.code).toBe('timeout');
  });

  it('returns a typed provider error after provider failure', async () => {
    const provider = fakeProvider({
      execute: async () => {
        throw new Error('provider exploded');
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({
      type: 'provider_error',
      code: 'provider_error',
    });
  });

  it('uses the next mapped provider after a bounded failure', async () => {
    const codex = fakeProvider({
      name: 'codex',
      execute: async () => {
        throw new Error('codex failed');
      },
    });
    const grok = fakeProvider({
      name: 'grok',
      execute: async () => ({
        ...defaultResult,
        content: 'Fallback succeeded.',
      }),
    });
    const deps = createDeps(
      { codex, grok },
      [
        { provider: 'codex', actualModel: 'codex-model' },
        { provider: 'grok', actualModel: 'grok-model' },
      ],
    );
    app = await createTestApp(deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-fallback-provider']).toBe('grok');
    expect(response.json().output[0].content[0].text).toBe('Fallback succeeded.');
  });

  it('emits exactly one failed terminal event after a stream error', async () => {
    const provider = fakeProvider({
      executeStream: async function* () {
        yield { type: 'text_delta', text: 'partial' };
        throw new Error('stream exploded');
      },
    });
    app = await createTestApp(createDeps({ codex: provider }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello', stream: true },
    });

    const terminals = [...response.body.matchAll(
      /event: response\.(completed|incomplete|failed)/g,
    )].map((match) => match[1]);
    expect(terminals).toEqual(['failed']);
    expect(response.body).toContain('"code":"provider_error"');
  });

  it('propagates a client disconnect to the provider abort signal', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseProvider: (() => void) | undefined;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = fakeProvider({
      executeStream: async function* (options) {
        observedSignal = options.signal;
        yield { type: 'text_delta', text: 'started' };
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        releaseProvider?.();
        throw new Error('Request cancelled');
      },
    });
    const fixture = await createSdkClient(createDeps({ codex: provider }));
    app = fixture.app;
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-test',
        input: 'hello',
        stream: true,
      }),
      signal: controller.signal,
    });
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
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe.each(['codex', 'grok'])('provider-independent Responses contract: %s', (name) => {
  it('produces the same Responses object contract', async () => {
    const provider = fakeProvider({ name });
    const deps = createDeps(
      { [name]: provider },
      [{ provider: name, actualModel: `${name}-model` }],
    );
    app = await createTestApp(deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'shared-alias', input: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'shared-alias',
      output: [{
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: 'Hello from the provider.',
          annotations: [],
        }],
      }],
      usage: {
        input_tokens: 4,
        output_tokens: 5,
        total_tokens: 9,
      },
    });
  });
});
