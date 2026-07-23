import type { EndpointType } from './types/provider.js';




//

export function inferEndpointTypeFromName(...names: Array<string | null | undefined>): EndpointType | null {
  const s = names.filter(Boolean).join(' ').toLowerCase();
  if (!s) return null;


  if (/(rerank|reranker|cross-?encoder)/.test(s)) return 'rerank';
  if (/(embed|embedding|kure|bge-m3|gte-|e5-|text-embedding|nomic-embed|jina-embed)/.test(s)) return 'embeddings';
  if (/(\btts\b|text-to-speech|speech|xtts|piper|kokoro|\bvoice\b)/.test(s)) return 'tts';
  if (/(\bimage\b|images|imagen|dall-?e|sdxl|stable-?diffusion|\bflux\b|nano-banana)/.test(s)) return 'images';

  return null;
}


export function effectiveEndpointType(
  explicit: EndpointType | null | undefined,
  ...names: Array<string | null | undefined>
): EndpointType {
  if (explicit) return explicit;
  return inferEndpointTypeFromName(...names) ?? 'chat';
}
