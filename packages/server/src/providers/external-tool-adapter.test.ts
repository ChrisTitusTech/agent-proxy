import { describe, expect, it } from 'vitest';
import type { ExecuteOptions, ExecuteResult } from '@agent-proxy/shared';
import {
  adaptExternalToolResult,
  externalToolEvents,
  prepareExternalToolRequest,
} from './external-tool-adapter.js';

const baseOptions: ExecuteOptions = {
  model: 'fixture',
  messages: [{ role: 'user', content: 'Look up Chicago.' }],
  stream: false,
  tools: [{
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Look up a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  }],
  toolChoice: 'required',
};

const usage = { promptTokens: 4, completionTokens: 5, totalTokens: 9 };

describe('external CLI tool adapter', () => {
  it('injects a constrained tool-selection prompt and disables session reuse', () => {
    const prepared = prepareExternalToolRequest({
      ...baseOptions,
      clientKey: 'client-a',
    });

    expect(prepared).not.toBeNull();
    expect(prepared?.required).toBe(true);
    expect(prepared?.options.clientKey).toBeUndefined();
    expect(prepared?.options.tools).toBeUndefined();
    expect(prepared?.options.extraBody).toMatchObject({
      __agentProxyExternalToolSelection: true,
    });
    expect(prepared?.options.messages.at(-1)?.content).toContain('External tools:');
  });

  it('preserves the effective caller system instruction', () => {
    const prepared = prepareExternalToolRequest({
      ...baseOptions,
      messages: [
        { role: 'system', content: 'Never disclose secrets.' },
        ...baseOptions.messages,
      ],
    });

    expect(prepared?.options.messages[0]).toMatchObject({
      role: 'system',
    });
    expect(prepared?.options.messages[0].content).toContain('Never disclose secrets.');
    expect(prepared?.options.messages.at(-1)?.content).toContain(
      'External client tool-selection mode is active.',
    );
    expect(prepared?.options.messages).toHaveLength(3);
  });

  it('turns a valid envelope into a stable function-call result and stream events', () => {
    const prepared = prepareExternalToolRequest(baseOptions)!;
    const raw: ExecuteResult = {
      content: '{"content":"","tool_calls":[{"name":"lookup","arguments":{"city":"Chicago"}}]}',
      usage,
      finishReason: 'stop',
    };

    const result = adaptExternalToolResult(raw, prepared);

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'lookup',
        arguments: '{"city":"Chicago"}',
      },
    });
    expect(result.toolCalls?.[0].id).toMatch(/^call_/);
    expect(externalToolEvents(result).map((event) => event.type)).toEqual([
      'tool_use',
      'usage',
      'done',
    ]);
  });

  it('rejects unknown tools and a missing required call', () => {
    const prepared = prepareExternalToolRequest(baseOptions)!;
    expect(() => adaptExternalToolResult({
      content: '{"content":"","tool_calls":[{"name":"shell","arguments":{}}]}',
      usage,
      finishReason: 'stop',
    }, prepared)).toThrow(/unknown external tool/);
    expect(() => adaptExternalToolResult({
      content: '{"content":"No call","tool_calls":[]}',
      usage,
      finishReason: 'stop',
    }, prepared)).toThrow(/required external tool/);
  });

  it('returns a stable validation error for malformed tool arguments', () => {
    const prepared = prepareExternalToolRequest(baseOptions)!;
    expect(() => adaptExternalToolResult({
      content: '{"content":"","tool_calls":[{"name":"lookup","arguments":"{"}]}',
      usage,
      finishReason: 'stop',
    }, prepared)).toThrow(
      'Provider returned invalid JSON arguments for external tool "lookup".',
    );
  });

  it.each([
    ['missing content', '{"tool_calls":[]}'],
    ['non-array tool_calls', '{"content":"","tool_calls":{}}'],
    ['non-object tool call', '{"content":"","tool_calls":[null]}'],
    ['missing arguments', '{"content":"","tool_calls":[{"name":"lookup"}]}'],
    ['non-object arguments', '{"content":"","tool_calls":[{"name":"lookup","arguments":"[]"}]}'],
  ])('rejects malformed external envelopes with %s', (_label, content) => {
    const prepared = prepareExternalToolRequest(baseOptions)!;
    expect(() => adaptExternalToolResult({
      content,
      usage,
      finishReason: 'stop',
    }, prepared)).toThrow(/Provider returned/);
  });

  it('enforces named choices and disabled parallel calls', () => {
    const named = prepareExternalToolRequest({
      ...baseOptions,
      tools: [
        ...baseOptions.tools!,
        {
          type: 'function',
          function: {
            name: 'forecast',
            description: 'Forecast a city.',
            parameters: { type: 'object' },
          },
        },
      ],
      toolChoice: { type: 'function', function: { name: 'lookup' } },
    })!;
    expect(() => adaptExternalToolResult({
      content: '{"content":"","tool_calls":[{"name":"forecast","arguments":{}}]}',
      usage,
      finishReason: 'stop',
    }, named)).toThrow(/required external tool "lookup"/);

    const serial = prepareExternalToolRequest({
      ...baseOptions,
      parallelToolCalls: false,
    })!;
    expect(() => adaptExternalToolResult({
      content: '{"content":"","tool_calls":[{"name":"lookup","arguments":{}},{"name":"lookup","arguments":{}}]}',
      usage,
      finishReason: 'stop',
    }, serial)).toThrow(/parallel external tool calls/);
  });

  it('keeps external tool selection active after a tool result', () => {
    const prepared = prepareExternalToolRequest({
      ...baseOptions,
      messages: [
        ...baseOptions.messages,
        { role: 'tool', content: '72F', tool_call_id: 'call_1' },
      ],
    });

    expect(prepared).not.toBeNull();
    expect(prepared?.options.extraBody).toMatchObject({
      __agentProxyExternalToolSelection: true,
    });
  });
});
