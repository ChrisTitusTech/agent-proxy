import { describe, it, expect } from 'vitest';
import { inferEndpointTypeFromName, effectiveEndpointType } from './endpoint-type.js';

describe('inferEndpointTypeFromName', () => {
  it('handles endpoint type inference', () => {
    expect(inferEndpointTypeFromName('bge-reranker')).toBe('rerank');
    expect(inferEndpointTypeFromName('BAAI/bge-reranker-v2-m3')).toBe('rerank');
    expect(inferEndpointTypeFromName('korean-reranker')).toBe('rerank');
  });

  it('handles endpoint type inference', () => {
    expect(inferEndpointTypeFromName('kure-v1')).toBe('embeddings');
    expect(inferEndpointTypeFromName('nlpai-lab/KURE-v1')).toBe('embeddings');
    expect(inferEndpointTypeFromName('text-embedding-3-large')).toBe('embeddings');
    expect(inferEndpointTypeFromName('korean-embedding')).toBe('embeddings');
  });

  it('handles endpoint type inference', () => {
    expect(inferEndpointTypeFromName('kokoro-tts')).toBe('tts');
    expect(inferEndpointTypeFromName('flux-schnell')).toBe('images');
    expect(inferEndpointTypeFromName('gemini-3-pro-image')).toBe('images');
  });

  it('handles endpoint type inference', () => {
    expect(inferEndpointTypeFromName('gemma-4-12b')).toBeNull();
    expect(inferEndpointTypeFromName('claude-sonnet-4-6')).toBeNull();
    expect(inferEndpointTypeFromName('qwen3.6-27b-awq')).toBeNull();
    expect(inferEndpointTypeFromName('')).toBeNull();
  });
});

describe('effectiveEndpointType', () => {
  it('handles endpoint type inference', () => {

    expect(effectiveEndpointType('chat', 'kure-v1')).toBe('chat');
  });

  it('handles endpoint type inference', () => {
    expect(effectiveEndpointType(undefined, 'kure-embed', 'kure-v1', 'nlpai-lab/KURE-v1')).toBe('embeddings');
  });

  it('handles endpoint type inference', () => {
    expect(effectiveEndpointType(undefined, 'gemma-4-12b')).toBe('chat');
    expect(effectiveEndpointType(null)).toBe('chat');
  });
});
