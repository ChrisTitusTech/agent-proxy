import { z } from 'zod';
import type {
  ChatCompletionTool,
  ChatMessage,
  ChatMessageContent,
  ToolChoice,
  ValidationConfig,
} from '@agent-proxy/shared';

const responseTextPartSchema = z.object({
  type: z.enum(['input_text', 'output_text']),
  text: z.string(),
}).strict();

const responseImagePartSchema = z.object({
  type: z.literal('input_image'),
  image_url: z.string().min(1).optional(),
  file_id: z.string().min(1).optional(),
  detail: z.enum(['auto', 'low', 'high', 'original']).optional(),
}).strict().refine((part) => part.image_url || part.file_id, {
  message: 'input_image requires image_url or file_id.',
});

const responseMessageSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([
    z.string(),
    z.array(z.union([responseTextPartSchema, responseImagePartSchema])).min(1),
  ]),
}).strict();

const responseFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  id: z.string().min(1).optional(),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
}).strict();

const responseFunctionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  id: z.string().min(1).optional(),
  call_id: z.string().min(1),
  output: z.unknown(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
}).strict();

const responseInputItemSchema = z.union([
  responseMessageSchema,
  responseFunctionCallSchema,
  responseFunctionCallOutputSchema,
]);

const responseFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
}).strict();

const responseToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    name: z.string().min(1),
  }).strict(),
]);

const responseReasoningSchema = z.object({
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  summary: z.enum(['auto', 'concise', 'detailed']).optional(),
}).strict();

export const responsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([
    z.string(),
    z.array(responseInputItemSchema).min(1),
  ]),
  instructions: z.string().nullable().optional(),
  stream: z.boolean().optional(),
  tools: z.array(responseFunctionToolSchema).optional(),
  tool_choice: responseToolChoiceSchema.optional(),
  max_output_tokens: z.number().int().positive().optional(),
  reasoning: responseReasoningSchema.optional(),
  previous_response_id: z.string().min(1).optional(),
  store: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  parallel_tool_calls: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
}).strict();

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type ResponsesInputItem = z.infer<typeof responseInputItemSchema>;
type ResponsesMessage = z.infer<typeof responseMessageSchema>;

export interface NormalizedResponsesInput {
  instructionMessages: ChatMessage[];
  inputMessages: ChatMessage[];
  callIds: Set<string>;
  functionOutputCallIds: Set<string>;
  tools?: ChatCompletionTool[];
  toolChoice?: ToolChoice;
  promptLength: number;
}

export interface ResponsesValidationError {
  error: {
    message: string;
    type: 'invalid_request_error';
    param: string | null;
    code: string;
  };
}

function pathToParam(path: PropertyKey[]): string | null {
  if (path.length === 0) return null;
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') return `${result}[${segment}]`;
    return result ? `${result}.${String(segment)}` : String(segment);
  }, '');
}

export function parseResponsesRequest(
  body: unknown,
): { success: true; data: ResponsesRequest } | {
  success: false;
  error: ResponsesValidationError;
} {
  const parsed = responsesRequestSchema.safeParse(body);
  if (parsed.success) return parsed;

  const issue = parsed.error.issues[0];
  const unknownKey = issue?.code === 'unrecognized_keys'
    ? issue.keys[0]
    : undefined;
  const baseParam = pathToParam(issue?.path ?? []);
  const param = unknownKey
    ? (baseParam ? `${baseParam}.${unknownKey}` : unknownKey)
    : baseParam;
  const message = unknownKey
    ? `Unknown parameter: '${param}'.`
    : `Invalid value for '${param ?? 'request'}': ${issue?.message ?? 'Invalid request.'}`;

  return {
    success: false,
    error: makeResponsesError(message, param, 'invalid_parameter'),
  };
}

export function makeResponsesError(
  message: string,
  param: string | null,
  code: string,
): ResponsesValidationError {
  return {
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code,
    },
  };
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function normalizeContent(content: ResponsesMessage['content']): ChatMessageContent {
  if (typeof content === 'string') return content.replace(/\x00/g, '');
  if (!Array.isArray(content)) return '';

  return content.map((part) => {
    if (part.type === 'input_image') {
      if (part.image_url) {
        return {
          type: 'image_url',
          image_url: {
            url: part.image_url.replace(/\x00/g, ''),
            ...(part.detail ? { detail: part.detail } : {}),
          },
        };
      }
      return {
        type: 'input_image',
        file_id: part.file_id?.replace(/\x00/g, ''),
        ...(part.detail ? { detail: part.detail } : {}),
      };
    }
    return {
      type: 'text',
      text: part.text.replace(/\x00/g, ''),
    };
  });
}

function contentLength(content: ChatMessageContent): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((length, part) => {
    if (typeof part.text === 'string') return length + part.text.length;
    if (part.type === 'image_url') {
      const imageUrl = part.image_url;
      const url = typeof imageUrl === 'object' && imageUrl !== null && 'url' in imageUrl
        ? String(imageUrl.url)
        : String(imageUrl ?? '');
      return length + url.length;
    }
    if (part.type === 'input_image') {
      return length + String(part.file_id ?? '').length;
    }
    return length;
  }, 0);
}

export function normalizeResponsesInput(
  request: ResponsesRequest,
  validation: ValidationConfig,
): { success: true; data: NormalizedResponsesInput } | {
  success: false;
  error: ResponsesValidationError;
} {
  const instructionMessages: ChatMessage[] = [];
  const inputMessages: ChatMessage[] = [];
  const callIds = new Set<string>();
  const functionOutputCallIds = new Set<string>();
  let promptLength = 0;

  if (request.instructions) {
    const instructions = request.instructions.replace(/\x00/g, '');
    if (instructions.length > validation.maxMessageLength) {
      return {
        success: false,
        error: makeResponsesError(
          `instructions is too long. Maximum is ${validation.maxMessageLength} characters.`,
          'instructions',
          'string_too_long',
        ),
      };
    }
    promptLength += instructions.length;
    instructionMessages.push({ role: 'developer', content: instructions });
  }

  const items: ResponsesInputItem[] = typeof request.input === 'string'
    ? [{ role: 'user', content: request.input }]
    : request.input;

  if (items.length > validation.maxMessageCount) {
    return {
      success: false,
      error: makeResponsesError(
        `Too many input items: ${items.length}. Maximum is ${validation.maxMessageCount}.`,
        'input',
        'too_many_items',
      ),
    };
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.type === 'function_call') {
      callIds.add(item.call_id);
      const name = item.name.replace(/\x00/g, '');
      const argumentsText = item.arguments.replace(/\x00/g, '');
      if (argumentsText.length > validation.maxMessageLength) {
        return {
          success: false,
          error: makeResponsesError(
            `input[${index}].arguments is too long. Maximum is ${validation.maxMessageLength} characters.`,
            `input[${index}].arguments`,
            'string_too_long',
          ),
        };
      }
      inputMessages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: {
            name,
            arguments: argumentsText,
          },
        }],
      });
      promptLength += name.length + argumentsText.length;
      continue;
    }

    if (item.type === 'function_call_output') {
      const output = stringifyOutput(item.output).replace(/\x00/g, '');
      if (output.length > validation.maxMessageLength) {
        return {
          success: false,
          error: makeResponsesError(
            `input[${index}].output is too long. Maximum is ${validation.maxMessageLength} characters.`,
            `input[${index}].output`,
            'string_too_long',
          ),
        };
      }
      functionOutputCallIds.add(item.call_id);
      inputMessages.push({
        role: 'tool',
        content: output,
        tool_call_id: item.call_id,
      });
      promptLength += output.length;
      continue;
    }

    const content = normalizeContent(item.content);
    const length = contentLength(content);
    if (length > validation.maxMessageLength) {
      return {
        success: false,
        error: makeResponsesError(
          `input[${index}].content is too long. Maximum is ${validation.maxMessageLength} characters.`,
          `input[${index}].content`,
          'string_too_long',
        ),
      };
    }
    promptLength += length;
    inputMessages.push({
      role: item.role,
      content,
    });
  }

  if (promptLength > validation.maxPromptLength) {
    return {
      success: false,
      error: makeResponsesError(
        `Total input is too long. Maximum is ${validation.maxPromptLength} characters.`,
        'input',
        'prompt_too_long',
      ),
    };
  }

  const tools = request.tools?.map<ChatCompletionTool>((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }));

  const toolChoice: ToolChoice | undefined = typeof request.tool_choice === 'object'
    ? {
      type: 'function',
      function: { name: request.tool_choice.name },
    }
    : request.tool_choice;

  return {
    success: true,
    data: {
      instructionMessages,
      inputMessages,
      callIds,
      functionOutputCallIds,
      tools,
      toolChoice,
      promptLength,
    },
  };
}
