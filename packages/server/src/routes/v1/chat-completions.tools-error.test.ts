import { describe, it, expect } from 'vitest';
import { isToolsUnsupportedError } from './chat-completions.js';

describe('isToolsUnsupportedError', () => {
  it('detects unsupported tool errors', () => {
    const msg = 'a100gemma12 HTTP error: {"message":"\\"auto\\" tool choice requires '
      + '--enable-auto-tool-choice and --tool-call-parser to be set","type":"BadRequestError","code":400}';
    expect(isToolsUnsupportedError(msg)).toBe(true);
  });

  it('detects unsupported tool errors', () => {
    expect(isToolsUnsupportedError('This model does not support tools.')).toBe(true);
  });

  it('detects unsupported tool errors', () => {
    expect(isToolsUnsupportedError('function calling is not supported by this model')).toBe(true);
  });

  it('detects unsupported tool errors', () => {
    expect(isToolsUnsupportedError('no tool-call-parser configured')).toBe(true);
  });

  it('detects unsupported tool errors', () => {
    expect(isToolsUnsupportedError('provider request timed out after 300000ms')).toBe(false);
  });

  it('detects unsupported tool errors', () => {
    expect(isToolsUnsupportedError('Model "x" not found. Check model mappings.')).toBe(false);
  });

  it('detects unsupported tool errors', () => {
    expect(isToolsUnsupportedError('Rate limit exceeded. Retry after 30 seconds.')).toBe(false);
  });

  it('detects unsupported tool errors', () => {
    expect(isToolsUnsupportedError('HTTP error: Invalid API key')).toBe(false);
  });

  it('detects unsupported tool errors', () => {
    expect(isToolsUnsupportedError('')).toBe(false);
    expect(isToolsUnsupportedError(undefined as unknown as string)).toBe(false);
  });
});
