import { describe, expect, it } from 'vitest';
import { hasValidGenericQueueLimits } from './export-import.js';

describe('generic provider import validation', () => {
  it('accepts non-negative queue limits and positive concurrency', () => {
    expect(hasValidGenericQueueLimits({
      max_concurrent: 1,
      max_queue_size: 0,
      max_queue_wait_ms: 0,
    })).toBe(true);
  });

  it.each([
    { max_concurrent: 0 },
    { max_concurrent: 1, max_queue_size: -1 },
    { max_concurrent: 1, max_queue_wait_ms: -1 },
    { max_concurrent: 1.5 },
    { max_concurrent: 1, max_queue_size: Number.POSITIVE_INFINITY },
  ])('rejects invalid imported queue limits: %j', (limits) => {
    expect(hasValidGenericQueueLimits(limits)).toBe(false);
  });
});
