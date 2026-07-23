import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml, ProviderEvent } from '@agent-proxy/shared';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';


vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { AgyProvider } from './agy-provider.js';

const spawnMock = vi.mocked(spawn);

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'agy',
    default_model: 'antigravity',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'antigravity',
    stream: false,
    ...extra,
  };
}


function fakeChild(stdout: string, stderr = '', exitCode = 0) {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  (child as unknown as { stdout: Readable }).stdout = Readable.from([Buffer.from(stdout)]);
  (child as unknown as { stderr: Readable }).stderr = Readable.from([Buffer.from(stderr)]);
  (child as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => true);
  (child as unknown as { killed: boolean }).killed = false;
  (child as unknown as { stdin: { end: () => void; write: () => void } }).stdin = { end: vi.fn(), write: vi.fn() };

  setImmediate(() => (child as unknown as EventEmitter).emit('close', exitCode));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('AgyProvider.buildArgs', () => {
  it('executes the Antigravity provider', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ messages: [{ role: 'user', content: 'ping' }] }),
    );
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('ping');
  });

  it('executes the Antigravity provider', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'antigravity' }),
    );
    expect(args).not.toContain('--model');
  });

  it('executes the Antigravity provider', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'Gemini 3.5 Flash (Low)' }),
    );
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('Gemini 3.5 Flash (Low)');

    expect(modelIdx).toBeLessThan(args.indexOf('-p'));
  });

  it('executes the Antigravity provider', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: '   ' }),
    );
    expect(args).not.toContain('--model');
  });

  it('executes the Antigravity provider', () => {
    const provider = new AgyProvider(baseConfig({
      extra_args: ['--model', 'Gemini 3.1 Pro (High)'],
    }));
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'Gemini 3.5 Flash (Low)' }),
    );
    expect(args.filter((a) => a === '--model')).toHaveLength(1);
    expect(args).toContain('Gemini 3.1 Pro (High)');
    expect(args).not.toContain('Gemini 3.5 Flash (Low)');
  });

  it('executes the Antigravity provider', () => {
    const provider = new AgyProvider(baseConfig({
      extra_args: ['--dangerously-skip-permissions', '--sandbox'],
    }));
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions(),
    );
    expect(args).toEqual(['--dangerously-skip-permissions', '--sandbox', '-p', 'hello']);
  });

  it('executes the Antigravity provider', () => {
    const provider = new AgyProvider(baseConfig());
    const huge = 'x'.repeat(800_001);
    expect(() =>
      (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
        baseOptions({ messages: [{ role: 'user', content: huge }] }),
      ),
    ).toThrow(/prompt exceeds/);
  });
});

describe('executes the Antigravity provider', () => {
  it('executes the Antigravity provider', async () => {
    spawnMock.mockReturnValue(fakeChild('  Hello from agy.  \n'));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Hello from agy.');
    expect(result.finishReason).toBe('stop');
  });

  it('executes the Antigravity provider', async () => {
    spawnMock.mockReturnValue(fakeChild('\x1B[31mred\x1B[0m text'));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('red text');
  });

  it('executes the Antigravity provider', async () => {
    spawnMock.mockReturnValue(fakeChild('', 'auth required', 1));
    const provider = new AgyProvider(baseConfig());
    await expect(provider.execute(baseOptions())).rejects.toThrow(/auth required/);
  });

  it('executes the Antigravity provider', async () => {
    spawnMock.mockReturnValue(fakeChild('1234567890'));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    // 10 chars → ceil(10/4) = 3 completion tokens
    expect(result.usage.completionTokens).toBe(3);
    expect(result.usage.promptTokens).toBe(0);
  });
});

describe('executes the Antigravity provider', () => {
  it('executes the Antigravity provider', async () => {
    spawnMock.mockReturnValue(fakeChild('response body'));
    const provider = new AgyProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }

    expect(events.map(e => e.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('response body');
    expect((events[2] as { type: 'done'; finishReason: string }).finishReason).toBe('stop');
  });

  it('executes the Antigravity provider', async () => {
    spawnMock.mockReturnValue(fakeChild(''));
    const provider = new AgyProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }
    expect(events.map(e => e.type)).toEqual(['usage', 'done']);
  });
});
