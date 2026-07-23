import { describe, expect, it } from 'vitest';
import { RequestRateLimiter } from './request-rate-limiter.js';

describe('RequestRateLimiter', () => {
  it('limits requests per client within a fixed window', () => {
    const limiter = new RequestRateLimiter(2, 1_000);

    expect(limiter.consume('client', 10_000)).toEqual({ allowed: true });
    expect(limiter.consume('client', 10_100)).toEqual({ allowed: true });
    expect(limiter.consume('client', 10_200)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it('starts a fresh window after expiration', () => {
    const limiter = new RequestRateLimiter(1, 1_000);
    limiter.consume('client', 10_000);

    expect(limiter.consume('client', 11_000)).toEqual({ allowed: true });
  });

  it('keeps client counters independent', () => {
    const limiter = new RequestRateLimiter(1);
    expect(limiter.consume('one', 10_000).allowed).toBe(true);
    expect(limiter.consume('two', 10_000).allowed).toBe(true);
  });

  it('rejects invalid configuration', () => {
    expect(() => new RequestRateLimiter(0)).toThrow(RangeError);
    expect(() => new RequestRateLimiter(1, 0)).toThrow(RangeError);
    expect(() => new RequestRateLimiter(1, 1_000, 0)).toThrow(RangeError);
  });
});
