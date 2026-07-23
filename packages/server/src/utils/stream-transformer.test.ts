import { describe, it, expect } from 'vitest';
import {
  ClaudeStreamParser,
  CodexStreamParser,
  PlainTextParser,
  formatAsSSE,
  createRequestId,
  getParserForProvider,
} from './stream-transformer.js';

describe('ClaudeStreamParser', () => {
  const parser = new ClaudeStreamParser();

  it('parses and formats stream events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello' }],
        role: 'assistant',
      },
    });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello' });
  });

  it('parses and formats stream events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      },
    });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello world' });
  });

  it('parses and formats stream events', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const result = parser.parse(line);
    expect(result?.type).toBe('done');
    expect(result?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('parses and formats stream events', () => {
    expect(parser.parse('')).toBeNull();
    expect(parser.parse('  ')).toBeNull();
  });

  it('parses and formats stream events', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    expect(parser.parse(line)).toBeNull();
  });

  it('parses and formats stream events', () => {
    const line = JSON.stringify({ type: 'rate_limit_event' });
    expect(parser.parse(line)).toBeNull();
  });
});

describe('CodexStreamParser', () => {
  const parser = new CodexStreamParser();

  it('parses and formats stream events', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Hello world' },
    });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello world' });
  });

  it('parses and formats stream events', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const result = parser.parse(line);
    expect(result?.type).toBe('done');
    expect(result?.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  it('parses and formats stream events', () => {
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Model not supported' },
    });
    const result = parser.parse(line);
    expect(result?.type).toBe('error');
  });

  it('parses and formats stream events', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'abc' });
    expect(parser.parse(line)).toBeNull();
  });

  it('parses and formats stream events', () => {
    expect(parser.parse('')).toBeNull();
  });

  it('plain text fallback', () => {
    const result = parser.parse('Hello world');
    expect(result).toEqual({ type: 'delta', content: 'Hello world' });
  });
});

describe('formatAsSSE', () => {
  it('parses and formats stream events', () => {
    const result = formatAsSSE(
      { type: 'delta', content: 'Hi' },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('data: ');
    expect(result).toContain('"content":"Hi"');
    expect(result).toContain('"model":"gpt-4"');
  });

  it('parses and formats stream events', () => {
    const result = formatAsSSE(
      { type: 'done' },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('"finish_reason":"stop"');
    expect(result).toContain('data: [DONE]');
  });

  it('parses and formats stream events', () => {
    const result = formatAsSSE(
      { type: 'tool_use', toolCallId: 'call_1', toolName: 'click', input: '{"selector":"#x"}' },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('"tool_calls"');
    expect(result).toContain('"id":"call_1"');
    expect(result).toContain('"name":"click"');
    expect(result).toContain('"type":"function"');
    expect(result).toContain('"index":0');
  });

  it('parses and formats stream events', () => {
    const result = formatAsSSE(
      { type: 'tool_use', toolCallId: 'call_2', toolName: 'scroll', input: '{}', index: 1 },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('"index":1');
  });

  it('parses and formats stream events', () => {
    const result = formatAsSSE(
      { type: 'tool_use', toolCallId: '', toolName: '', input: '{"sel', isPartial: true, index: 0 },
      'chatcmpl-test-123',
      'gpt-4',
    );

    const json = JSON.parse(result!.replace(/^data: /, '').trim());
    const tc = json.choices[0].delta.tool_calls[0];
    expect(tc.function.arguments).toBe('{"sel');
    expect(tc.id).toBeUndefined();
    expect(tc.type).toBeUndefined();
    expect(tc.function.name).toBeUndefined();
  });

  it('parses and formats stream events', () => {
    const result = formatAsSSE(
      { type: 'done', finishReason: 'tool_use' },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('"finish_reason":"tool_calls"');
    expect(result).toContain('data: [DONE]');
  });
});

describe('createRequestId', () => {
  it('parses and formats stream events', () => {
    const id = createRequestId();
    expect(id).toMatch(/^chatcmpl-proxy-/);
  });
});

describe('getParserForProvider', () => {
  it('parses and formats stream events', () => {
    expect(getParserForProvider('claude')).toBeInstanceOf(ClaudeStreamParser);
    expect(getParserForProvider('codex')).toBeInstanceOf(CodexStreamParser);
  });

  it('parses and formats stream events', () => {
    const parser = getParserForProvider('unknown');
    expect(parser).toBeInstanceOf(PlainTextParser);
  });
});
