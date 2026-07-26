import { nanoid } from 'nanoid';
import type {
  ExecuteOptions,
  ExecuteResult,
  ChatMessage,
  ProviderEvent,
  ToolChoice,
} from '@agent-proxy/shared';

interface ToolEnvelope {
  content?: unknown;
  tool_calls?: unknown;
}

export interface PreparedExternalToolRequest {
  options: ExecuteOptions;
  required: boolean;
  allowedToolNames: Set<string>;
  namedChoice?: string;
  parallelToolCalls: boolean;
}

function requiresTool(choice: ToolChoice | undefined): boolean {
  return choice === 'required'
    || (
      typeof choice === 'object'
      && choice !== null
      && choice.type === 'function'
    );
}

function addExternalToolInstruction(
  messages: ChatMessage[],
  instruction: string,
): ChatMessage[] {
  let instructionTarget = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'system' || messages[index].role === 'developer') {
      instructionTarget = index;
      break;
    }
  }
  if (instructionTarget < 0) {
    return [...messages, { role: 'system', content: instruction }];
  }

  const updated = [...messages];
  const existing = messages[instructionTarget];
  updated[instructionTarget] = {
    ...existing,
    content: typeof existing.content === 'string'
      ? `${existing.content}\n\n${instruction}`
      : [...existing.content, { type: 'text', text: instruction }],
  };
  return updated;
}

export function prepareExternalToolRequest(
  options: ExecuteOptions,
): PreparedExternalToolRequest | null {
  if (!options.tools?.length || options.toolChoice === 'none') return null;

  const namedChoice = typeof options.toolChoice === 'object'
    && options.toolChoice !== null
    && options.toolChoice.type === 'function'
    ? options.toolChoice.function.name
    : undefined;
  const tools = options.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    parameters: tool.function.parameters,
  }));
  const instruction = [
    'External client tool-selection mode is active.',
    'Do not execute local tools or answer outside the JSON object.',
    'Choose from the supplied external tools when appropriate.',
    namedChoice
      ? `You must call the external tool named "${namedChoice}".`
      : requiresTool(options.toolChoice)
        ? 'You must call at least one external tool.'
        : 'If no external tool is needed, put the final answer in content.',
    'Return exactly this JSON shape:',
    '{"content":"final answer or empty string","tool_calls":[{"name":"tool name","arguments":{"key":"value"}}]}',
    `External tools: ${JSON.stringify(tools)}`,
  ].join('\n');

  return {
    required: requiresTool(options.toolChoice),
    allowedToolNames: new Set(tools.map((tool) => tool.name)),
    ...(namedChoice ? { namedChoice } : {}),
    parallelToolCalls: options.parallelToolCalls !== false,
    options: {
      ...options,
      messages: addExternalToolInstruction(options.messages, instruction),
      tools: undefined,
      toolChoice: undefined,
      parallelToolCalls: undefined,
      clientKey: undefined,
      extraBody: {
        ...options.extraBody,
        __agentProxyExternalToolSelection: true,
      },
    },
  };
}

function parseEnvelope(content: string): ToolEnvelope {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('Provider did not return the required external tool JSON object.');
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as ToolEnvelope;
  } catch {
    throw new Error('Provider returned invalid JSON for external tool selection.');
  }
}

export function adaptExternalToolResult(
  result: ExecuteResult,
  prepared: PreparedExternalToolRequest,
): ExecuteResult {
  const envelope = parseEnvelope(result.content);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Provider returned invalid external tool selection data.');
  }
  if (typeof envelope.content !== 'string') {
    throw new Error('Provider returned invalid content for external tool selection.');
  }
  if (envelope.tool_calls !== undefined && !Array.isArray(envelope.tool_calls)) {
    throw new Error('Provider returned invalid tool_calls for external tool selection.');
  }
  const toolCalls = (envelope.tool_calls ?? []).map((call) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) {
      throw new Error('Provider returned an invalid external tool call.');
    }
    if (typeof call.name !== 'string' || !prepared.allowedToolNames.has(call.name)) {
      throw new Error('Provider selected an unknown external tool.');
    }
    if (call.arguments === undefined) {
      throw new Error(
        `Provider returned invalid JSON arguments for external tool "${call.name}".`,
      );
    }
    const args = typeof call.arguments === 'string'
      ? call.arguments
      : JSON.stringify(call.arguments);
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      throw new Error(
        `Provider returned invalid JSON arguments for external tool "${call.name}".`,
      );
    }
    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
      throw new Error(
        `Provider returned non-object JSON arguments for external tool "${call.name}".`,
      );
    }
    return {
      id: `call_${nanoid(20)}`,
      type: 'function' as const,
      function: { name: call.name, arguments: args },
    };
  });
  if (prepared.namedChoice && toolCalls.some(
    (call) => call.function.name !== prepared.namedChoice
  )) {
    throw new Error(`Provider did not select the required external tool "${prepared.namedChoice}".`);
  }
  if (!prepared.parallelToolCalls && toolCalls.length > 1) {
    throw new Error('Provider returned parallel external tool calls when they are disabled.');
  }
  if (prepared.required && toolCalls.length === 0) {
    throw new Error('Provider did not select the required external tool.');
  }
  return {
    ...result,
    content: envelope.content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    finishReason: toolCalls.length > 0 ? 'tool_calls' : result.finishReason,
  };
}

export function externalToolEvents(result: ExecuteResult): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  if (result.content) {
    events.push({ type: 'text_delta', text: result.content });
  }
  for (const [index, call] of (result.toolCalls ?? []).entries()) {
    events.push({
      type: 'tool_use',
      toolCallId: call.id,
      toolName: call.function.name,
      input: call.function.arguments,
      index,
    });
  }
  events.push({ type: 'usage', usage: result.usage });
  events.push({
    type: 'done',
    finishReason: result.toolCalls?.length
      ? 'tool_use'
      : result.finishReason === 'tool_calls'
        ? 'tool_use'
        : result.finishReason,
  });
  return events;
}
