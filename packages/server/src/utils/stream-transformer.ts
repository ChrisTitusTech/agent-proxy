import type {
  ChatCompletionChunk,
  StreamChunk,
  StreamParser,
  ProviderEvent,
  TokenUsage,
} from '@agent-proxy/shared';
import { nanoid } from 'nanoid';


export type { StreamParser } from '@agent-proxy/shared';



export class ClaudeStreamParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const data = JSON.parse(trimmed);


      if (data.type === 'assistant' && data.message) {
        const content = data.message.content;
        if (Array.isArray(content)) {

          const text = content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text)
            .join('');
          if (text) return { type: 'delta', content: text };
        }
        return null;
      }


      if (data.type === 'result') {
        const u = data.usage;
        const usage = u ? {
          promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          completionTokens: u.output_tokens ?? 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        } : undefined;
        return { type: 'done', usage };
      }

      return null;
    } catch {
      return null;
    }
  }

  parseEvents(line: string): ProviderEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    try {
      const data = JSON.parse(trimmed);


      if (data.type === 'assistant' && data.message) {
        const content = data.message.content;
        if (!Array.isArray(content)) return [];

        const events: ProviderEvent[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            events.push({ type: 'text_delta', text: block.text });
          } else if (block.type === 'tool_use') {
            events.push({
              type: 'tool_use',
              toolCallId: block.id ?? '',
              toolName: block.name ?? '',
              input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            });
          } else if (block.type === 'thinking' && block.thinking) {
            events.push({ type: 'thinking', text: block.thinking });
          }
        }
        return events;
      }


      if (data.type === 'result') {
        const events: ProviderEvent[] = [];
        const u = data.usage;
        if (u) {
          events.push({
            type: 'usage',
            usage: {
              promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              completionTokens: u.output_tokens ?? 0,
              totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            },
          });
        }

        const finishReason = data.stop_reason === 'max_tokens' ? 'length' as const
          : data.stop_reason === 'tool_use' ? 'tool_use' as const
          : 'stop' as const;
        events.push({ type: 'done', finishReason });
        return events;
      }

      return [];
    } catch {
      return [];
    }
  }
}



function isLikelyUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}



export class CodexStreamParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const data = JSON.parse(trimmed);


      if (data.type === 'item.completed' && data.item) {
        if (data.item.type === 'error') {
          return { type: 'error', error: data.item.message ?? 'Codex item error' };
        }
        const text = data.item.text ?? '';
        if (text) return { type: 'delta', content: text };
        return null;
      }


      if (data.type === 'turn.completed') {
        const u = data.usage;
        const usage = u ? {
          promptTokens: u.input_tokens ?? 0,
          completionTokens: u.output_tokens ?? 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        } : undefined;
        return { type: 'done', usage };
      }


      if (data.type === 'turn.failed' || data.type === 'error') {
        return { type: 'error', error: data.error?.message ?? data.message ?? 'Codex error' };
      }

      return null;
    } catch {
      // plain text fallback
      if (trimmed) return { type: 'delta', content: trimmed };
      return null;
    }
  }

  parseEvents(line: string): ProviderEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    try {
      const data = JSON.parse(trimmed);



      if (data.type === 'thread.started') {
        const tid = typeof data.thread_id === 'string' ? data.thread_id
          : typeof data.threadId === 'string' ? data.threadId
          : (data.thread && typeof data.thread.id === 'string') ? data.thread.id
          : null;
        if (tid && isLikelyUuid(tid)) {
          return [{ type: 'thread_started', threadId: tid }];
        }
        return [];
      }

      if (data.type === 'item.completed' && data.item) {
        if (data.item.type === 'error') {
          return [{ type: 'error', error: data.item.message ?? 'Codex item error' }];
        }
        const text = data.item.text ?? '';
        if (text) return [{ type: 'text_delta', text }];
        return [];
      }

      if (data.type === 'turn.completed') {
        const events: ProviderEvent[] = [];
        const u = data.usage;
        if (u) {
          events.push({
            type: 'usage',
            usage: {
              promptTokens: u.input_tokens ?? 0,
              completionTokens: u.output_tokens ?? 0,
              totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
            },
          });
        }
        events.push({ type: 'done' });
        return events;
      }

      if (data.type === 'turn.failed' || data.type === 'error') {
        return [{ type: 'error', error: data.error?.message ?? data.message ?? 'Codex error' }];
      }

      return [];
    } catch {
      if (trimmed) return [{ type: 'text_delta', text: trimmed }];
      return [];
    }
  }
}




const PROVIDER_EVENT_ONLY_TYPES = new Set(['text_delta', 'tool_use', 'thinking', 'usage']);

export interface FormatAsSseOptions {

  includeReasoning?: boolean;
}


export function formatAsSSE(
  event: ProviderEvent | StreamChunk,
  requestId: string,
  model: string,
  options: FormatAsSseOptions = {},
): string | null {

  if (PROVIDER_EVENT_ONLY_TYPES.has(event.type)) {
    return formatProviderEventAsSSE(event as ProviderEvent, requestId, model, options);
  }


  if ('finishReason' in event) {
    return formatProviderEventAsSSE(event as ProviderEvent, requestId, model, options);
  }


  const chunk = event as StreamChunk;

  if (chunk.type === 'delta') {
    const data: ChatCompletionChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { content: chunk.content },
        finish_reason: null,
      }],
    };
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  if (chunk.type === 'done') {
    const data: ChatCompletionChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
    return `data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`;
  }

  if (chunk.type === 'error') {
    return null;
  }

  return null;
}


function formatProviderEventAsSSE(
  event: ProviderEvent,
  requestId: string,
  model: string,
  options: FormatAsSseOptions = {},
): string | null {
  const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null): string => {
    const data: ChatCompletionChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: delta as ChatCompletionChunk['choices'][0]['delta'],
        finish_reason: finishReason as ChatCompletionChunk['choices'][0]['finish_reason'],
      }],
    };
    return `data: ${JSON.stringify(data)}\n\n`;
  };

  switch (event.type) {
    case 'text_delta':
      return makeChunk({ content: event.text });

    case 'tool_use':
      return makeChunk({
        tool_calls: [{
          index: event.index ?? 0,
          id: event.isPartial ? undefined : event.toolCallId,
          type: event.isPartial ? undefined : 'function',
          function: {
            name: event.isPartial ? undefined : event.toolName,
            arguments: event.input,
          },
        }],
      });

    case 'thinking':


      if (!options.includeReasoning) return null;
      return makeChunk({ reasoning_content: event.text });

    case 'usage':

      return null;

    case 'error':
      return null;

    case 'done': {

      const finishReason = event.finishReason === 'tool_use' ? 'tool_calls'
        : event.finishReason === 'length' ? 'length'
        : 'stop';
      return makeChunk({}, finishReason) + 'data: [DONE]\n\n';
    }

    default:
      return null;
  }
}

export function createRequestId(): string {
  return `chatcmpl-proxy-${nanoid(24)}`;
}


export class PlainTextParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return { type: 'delta', content: trimmed };
  }

  parseEvents(line: string): ProviderEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ type: 'text_delta', text: trimmed }];
  }
}


const parserRegistry = new Map<string, () => StreamParser>();


parserRegistry.set('claude', () => new ClaudeStreamParser());
parserRegistry.set('codex', () => new CodexStreamParser());


parserRegistry.set('agy', () => new PlainTextParser());


parserRegistry.set('grok', () => new PlainTextParser());

export function registerParser(provider: string, factory: () => StreamParser): void {
  parserRegistry.set(provider, factory);
}

export function getParserForProvider(provider: string): StreamParser {
  const factory = parserRegistry.get(provider);
  if (factory) return factory();

  return new PlainTextParser();
}
