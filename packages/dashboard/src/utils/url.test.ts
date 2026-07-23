import { describe, expect, it } from 'vitest';
import { isImageUrl } from './url.js';

describe('isImageUrl', () => {
  it('recognizes image paths and exact Azure Blob Storage hosts', () => {
    expect(isImageUrl('https://example.com/image.png')).toBe(true);
    expect(isImageUrl('https://account.blob.core.windows.net/container/item')).toBe(true);
  });

  it('does not accept deceptive hostname suffixes', () => {
    expect(isImageUrl('https://blob.core.windows.net.evil.example/item')).toBe(false);
    expect(isImageUrl('https://evilblob.core.windows.net.example/item')).toBe(false);
  });
});
