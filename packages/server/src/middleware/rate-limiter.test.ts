import { describe, it, expect, afterEach } from 'vitest';
import type { RateLimitConfig } from '@agent-proxy/shared';
import { RateLimiter } from './rate-limiter.js';




function makeConfig(overrides?: Partial<RateLimitConfig>): RateLimitConfig {
  return {
    global: { rpm: 1000, rpd: 10000 },
    perProvider: {},
    ...overrides,
  };
}

const limiters: RateLimiter[] = [];
function newLimiter(config: RateLimitConfig): RateLimiter {
  const rl = new RateLimiter(config);
  limiters.push(rl);
  return rl;
}

afterEach(async () => {

  await Promise.all(limiters.splice(0).map((rl) => rl.destroy()));
});

describe('enforces rate limit behavior', () => {
  it('enforces rate limit behavior', () => {

    const rl = newLimiter(makeConfig({ global: { rpm: 2, rpd: 100 } }));


    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);

    expect(rl.checkProvider('providerA').allowed).toBe(true);
    expect(rl.checkProvider('providerB').allowed).toBe(true);


    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);

    const third = rl.checkGlobalAndKey('key1');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('enforces rate limit behavior', () => {
    const rl = newLimiter(makeConfig({ global: { rpm: 2, rpd: 100 } }));


    expect(rl.checkAndIncrement('key1', 'providerA').allowed).toBe(true);
    expect(rl.checkAndIncrement('key1', 'providerB').allowed).toBe(true);

    expect(rl.checkGlobalAndKey('key1').allowed).toBe(false);
  });
});

describe('RateLimiter - checkProvider', () => {
  it('enforces rate limit behavior', () => {
    const rl = newLimiter(makeConfig());
    for (let i = 0; i < 100; i++) {
      expect(rl.checkProvider('noLimit').allowed).toBe(true);
    }
  });

  it('enforces rate limit behavior', () => {
    const rl = newLimiter(makeConfig({ perProvider: { agy: { rpm: 2 } } }));
    expect(rl.checkProvider('agy').allowed).toBe(true);
    expect(rl.checkProvider('agy').allowed).toBe(true);
    const blocked = rl.checkProvider('agy');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    expect(rl.checkProvider('other').allowed).toBe(true);
  });
});

describe('RateLimiter - checkGlobalAndKey', () => {
  it('enforces rate limit behavior', () => {

    const rl = newLimiter(makeConfig({ global: { rpm: 100, rpd: 1 } }));
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);

    expect(rl.checkGlobalAndKey('key1').allowed).toBe(false);
  });

  it('enforces rate limit behavior', () => {
    const rl = newLimiter(makeConfig());
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(true);
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(false);
    expect(rl.checkGlobalAndKey('key2', { rpm: 1 }).allowed).toBe(true);
  });

  it('enforces rate limit behavior', () => {
    const rl = newLimiter(makeConfig({ global: { rpm: 5, rpd: 5 } }));

    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(true);  // global=1
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(false);

    for (let i = 0; i < 4; i++) {
      expect(rl.checkGlobalAndKey(`k${i}`).allowed).toBe(true);
    }
    expect(rl.checkGlobalAndKey('kX').allowed).toBe(false);
  });
});
