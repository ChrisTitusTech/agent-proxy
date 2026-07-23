

import { describe, it, expect } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedMutex', () => {
  it('preserves keyed mutex behavior', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.runExclusive('k', async () => {
        order.push('a-start');
        await delay(10);
        order.push('a-end');
      }),
      mutex.runExclusive('k', async () => {
        order.push('b-start');
        await delay(5);
        order.push('b-end');
      }),
      mutex.runExclusive('k', async () => {
        order.push('c-start');
        order.push('c-end');
      }),
    ]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
  });

  it('preserves keyed mutex behavior', async () => {
    const mutex = new KeyedMutex();
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      (async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await delay(10);
        concurrent--;
      })();

    await Promise.all([
      mutex.runExclusive('k1', task),
      mutex.runExclusive('k2', task),
    ]);

    expect(maxConcurrent).toBe(2);
  });

  it('preserves keyed mutex behavior', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');


    const result = await mutex.runExclusive('k', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('preserves keyed mutex behavior', async () => {
    const mutex = new KeyedMutex();

    const release = await mutex.acquire('k');
    release();
    release();

    const result = await mutex.runExclusive('k', async () => 'ok');
    expect(result).toBe('ok');
  });
});
