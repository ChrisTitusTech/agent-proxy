import type { FastifyInstance } from 'fastify';

type JsonObject = Record<string, unknown>;

interface ResponsesOutputContent {
  type: 'output_text';
  text: string;
}

interface ResponsesOutputItem {
  type: 'message';
  role: 'assistant';
  content: ResponsesOutputContent[];
}

export interface ResponsesResult {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed';
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

interface ResponsesEvent {
  event: string;
  data: JsonObject;
}

export function toChatCompletionsRequest(body: JsonObject): JsonObject {
  let messages = body.messages;
  if (!messages) {
    const input = body.input;
    if (typeof input === 'string') {
      messages = [{ role: 'user', content: input }];
    } else if (Array.isArray(input)) {
      messages = input;
    } else {
      messages = [{ role: 'user', content: '' }];
    }
  }

  return {
    model: body.model,
    messages,
    stream: false,
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    temperature: body.temperature,
  };
}

export function toResponsesResult(
  chatResult: JsonObject,
  requestedModel: unknown,
): ResponsesResult {
  const choice = Array.isArray(chatResult.choices)
    ? chatResult.choices[0] as JsonObject | undefined
    : undefined;
  const message = choice?.message as JsonObject | undefined;
  const content = typeof message?.content === 'string' ? message.content : '';
  const usage = chatResult.usage as JsonObject | undefined;

  return {
    id: typeof chatResult.id === 'string' ? chatResult.id : `resp_${Date.now()}`,
    object: 'response',
    created_at: typeof chatResult.created === 'number'
      ? chatResult.created
      : Math.floor(Date.now() / 1000),
    status: 'completed',
    model: typeof chatResult.model === 'string'
      ? chatResult.model
      : (typeof requestedModel === 'string' ? requestedModel : ''),
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: content }],
    }],
    usage: usage ? {
      input_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : 0,
    } : undefined,
  };
}

export function buildResponsesEvents(result: ResponsesResult): ResponsesEvent[] {
  const events: ResponsesEvent[] = [
    {
      event: 'response.created',
      data: {
        type: 'response.created',
        response: { ...result, status: 'in_progress', output: [] },
      },
    },
    {
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', role: 'assistant', content: [] },
      },
    },
    {
      event: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
    },
  ];

  const content = result.output[0]?.content[0]?.text ?? '';
  const chunkSize = 20;
  for (let index = 0; index < content.length; index += chunkSize) {
    events.push({
      event: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: content.substring(index, index + chunkSize),
      },
    });
  }

  events.push(
    {
      event: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text: content,
      },
    },
    {
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: result.output[0],
      },
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: result,
      },
    },
  );

  return events;
}

export function registerResponsesRoute(app: FastifyInstance): void {
  app.post<{ Body: JsonObject }>('/v1/responses', async (request, reply) => {
    const body = request.body ?? {};
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (request.headers.authorization) {
      headers.authorization = request.headers.authorization;
    }
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string') {
      headers['x-api-key'] = apiKey;
    }

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: JSON.stringify(toChatCompletionsRequest(body)),
    });

    if (response.statusCode !== 200) {
      const contentType = response.headers['content-type'];
      if (contentType) reply.header('content-type', contentType);
      return reply.status(response.statusCode).send(response.payload);
    }

    let chatResult: JsonObject;
    try {
      chatResult = JSON.parse(response.payload) as JsonObject;
    } catch {
      return reply.status(502).send({
        error: {
          message: 'Failed to parse upstream response.',
          type: 'api_error',
          code: 'invalid_upstream_response',
        },
      });
    }

    const result = toResponsesResult(chatResult, body.model);
    if (body.stream !== true) {
      return reply.status(200).send(result);
    }

    const origin = request.headers.origin;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    });

    for (const item of buildResponsesEvents(result)) {
      reply.raw.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
    }
    reply.raw.end();
  });
}
