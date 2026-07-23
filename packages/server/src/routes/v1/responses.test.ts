import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildResponsesEvents,
  registerResponsesRoute,
  toChatCompletionsRequest,
  toResponsesResult,
} from './responses.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('Responses API adapter', () => {
  it('converts string input to a Chat Completions request', () => {
    expect(toChatCompletionsRequest({
      model: 'gpt-test',
      input: 'hello',
      max_output_tokens: 100,
      temperature: 0.2,
    })).toEqual({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      max_tokens: 100,
      temperature: 0.2,
    });
  });

  it('preserves message arrays and explicit max_tokens', () => {
    const messages = [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }];

    expect(toChatCompletionsRequest({
      model: 'gpt-test',
      messages,
      max_tokens: 50,
    })).toEqual({
      model: 'gpt-test',
      messages,
      stream: false,
      max_tokens: 50,
      temperature: undefined,
    });
  });

  it('converts Chat Completions output and usage to a Responses result', () => {
    const result = toResponsesResult({
      id: 'chatcmpl-test',
      created: 123,
      model: 'actual-model',
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      },
    }, 'requested-model');

    expect(result).toMatchObject({
      id: 'chatcmpl-test',
      object: 'response',
      created_at: 123,
      status: 'completed',
      model: 'actual-model',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done' }],
      }],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      },
    });
  });

  it('builds Responses SSE events in protocol order', () => {
    const result = toResponsesResult({
      id: 'chatcmpl-test',
      created: 123,
      model: 'actual-model',
      choices: [{ message: { content: 'abcdefghijklmnopqrstuvwxyz' } }],
    }, 'requested-model');

    const events = buildResponsesEvents(result);

    expect(events.map((item) => item.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[3].data.delta).toBe('abcdefghijklmnopqrst');
    expect(events[4].data.delta).toBe('uvwxyz');
  });

  it('forwards bearer and x-api-key authentication to Chat Completions', async () => {
    app = Fastify();
    let forwardedHeaders: Record<string, unknown> = {};
    let forwardedBody: unknown;

    app.post('/v1/chat/completions', async (request) => {
      forwardedHeaders = request.headers;
      forwardedBody = request.body;
      return {
        id: 'chatcmpl-test',
        created: 123,
        model: 'gpt-test',
        choices: [{ message: { content: 'ok' } }],
      };
    });
    registerResponsesRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        authorization: 'Bearer test-token',
        'x-api-key': 'test-api-key',
      },
      payload: {
        model: 'gpt-test',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(forwardedHeaders.authorization).toBe('Bearer test-token');
    expect(forwardedHeaders['x-api-key']).toBe('test-api-key');
    expect(forwardedBody).toMatchObject({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
    expect(response.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [{ content: [{ text: 'ok' }] }],
    });
  });

  it('passes through upstream errors', async () => {
    app = Fastify();
    app.post('/v1/chat/completions', async (_request, reply) => {
      return reply.status(400).send({
        error: {
          message: 'Model not found.',
          code: 'model_not_found',
        },
      });
    });
    registerResponsesRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'missing', input: 'hello' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'Model not found.',
        code: 'model_not_found',
      },
    });
  });

  it('returns a structured error for invalid upstream JSON', async () => {
    app = Fastify();
    app.post('/v1/chat/completions', async (_request, reply) => {
      return reply.type('text/plain').send('not-json');
    });
    registerResponsesRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hello' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        message: 'Failed to parse upstream response.',
        type: 'api_error',
        code: 'invalid_upstream_response',
      },
    });
  });

  it('returns ordered SSE output for streaming requests', async () => {
    app = Fastify();
    app.post('/v1/chat/completions', async () => ({
      id: 'chatcmpl-test',
      created: 123,
      model: 'gpt-test',
      choices: [{ message: { content: 'streamed' } }],
    }));
    registerResponsesRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-test',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: response.created');
    expect(response.body).toContain('event: response.output_text.delta');
    expect(response.body).toContain('"delta":"streamed"');
    expect(response.body).toContain('event: response.completed');
  });
});
