


export interface ChatMessageContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type ChatMessageContent = string | ChatMessageContentPart[];




export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatCompletionTool {
  type: 'function';
  function: FunctionDefinition;
}


export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };



export interface ChatMessageToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  index?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'developer' | 'tool';
  content: ChatMessageContent;
  name?: string;
  tool_call_id?: string;

  tool_calls?: ChatMessageToolCall[];


  reasoning_content?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];

  tools?: ChatCompletionTool[];
  tool_choice?: ToolChoice;

  reasoning_effort?: string;

  include_reasoning?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: UsageInfo;
}


export interface ChatCompletionChunkToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string;

  reasoning_content?: string;
  tool_calls?: ChatCompletionChunkToolCall[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}


export interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelListResponse {
  object: 'list';
  data: ModelObject[];
}


export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
}

export interface ImageGenerationResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
}


export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
}

export interface EmbeddingObject {
  object: 'embedding';
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingObject[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}


export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
}

export interface RerankResponseItem {
  index: number;
  relevance_score: number;
  document?: { text: string };
}

export interface RerankResponse {
  id: string;
  results: RerankResponseItem[];
  model: string;
  usage: {
    total_tokens: number;
  };
}


export type TtsResponseFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface TtsRequest {
  model: string;
  input: string;
  voice: string;
  response_format?: TtsResponseFormat;
  speed?: number;
}


export interface ApiErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}
