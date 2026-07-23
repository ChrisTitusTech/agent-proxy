import type { ChatMessage, ChatMessageContent, ChatMessageContentPart } from '@agent-proxy/shared';


export interface ConvertedPrompt {
  systemPrompt: string | null;
  userPrompt: string;
}



export function sanitizeDelimiters(content: string): string {
  return content
    .replace(/<\|user\|>/g, '<​user​>')
    .replace(/<\|assistant\|>/g, '<​assistant​>')
    .replace(/<\|system\|>/g, '<​system​>');
}


// OpenAI Chat Completions: { type: 'image_url', image_url: { url } }
// OpenAI Responses API:   { type: 'input_image', image_url | image_url.url }

export function isImagePart(part: ChatMessageContentPart): boolean {
  const t = part?.type;
  return t === 'image_url' || t === 'input_image' || t === 'image';
}



export function extractTextFromContent(content: ChatMessageContent | undefined | null): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (isImagePart(part)) {
      parts.push('[image]');
      continue;
    }
    if (typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}



export function convertMessages(messages: ChatMessage[]): ConvertedPrompt {
  let systemPrompt: string | null = null;
  const conversationParts: string[] = [];

  for (const msg of messages) {
    const content = extractTextFromContent(msg.content);
    if (msg.role === 'system') {

      systemPrompt = content;
    } else if (msg.role === 'user') {
      conversationParts.push(`<|user|> ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'assistant') {
      conversationParts.push(`<|assistant|> ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'tool') {

      const toolName = msg.name ?? 'tool';
      conversationParts.push(`<|user|> [Tool result ${sanitizeDelimiters(toolName)}] ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'developer') {

      systemPrompt = content;
    }
  }


  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  if (nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'user') {
    return {
      systemPrompt,
      userPrompt: extractTextFromContent(nonSystemMessages[0].content),
    };
  }

  return {
    systemPrompt,
    userPrompt: conversationParts.join('\n\n'),
  };
}


export function convertMessagesToSinglePrompt(messages: ChatMessage[]): string {
  const { systemPrompt, userPrompt } = convertMessages(messages);

  if (systemPrompt) {
    return `<|system|> ${systemPrompt}\n\n${userPrompt}`;
  }

  return userPrompt;
}
