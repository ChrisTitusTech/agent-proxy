import { describe, it, expect } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml, ProviderEvent } from '@agent-proxy/shared';
import { PassThrough } from 'node:stream';
import { AgyProvider } from './agy-provider.js';
import type { ProviderExecutionBackend } from '../herdr/launcher.js';

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


function fakeBackend(output: string, error = '', exitCode = 0): ProviderExecutionBackend {
  return {
    readiness: async () => ({ ready: true }),
    shutdown: async () => undefined,
    start: async () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const completion = new Promise<{
        exitCode: number;
        paneId: string;
        terminalState: 'completed' | 'failed';
      }>((resolve) => {
        setImmediate(() => {
          stdout.end(output);
          stderr.end(error);
          resolve({
            exitCode,
            paneId: 'test:pane',
            terminalState: exitCode === 0 ? 'completed' : 'failed',
          });
        });
      });
      return { stdout, stderr, completion, paneId: 'test:pane', cancel: () => undefined };
    },
  };
}

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
    const provider = new AgyProvider(baseConfig(), fakeBackend('  Hello from agy.  \n'));
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Hello from agy.');
    expect(result.finishReason).toBe('stop');
  });

  it('executes the Antigravity provider', async () => {
    const provider = new AgyProvider(baseConfig(), fakeBackend('\x1B[31mred\x1B[0m text'));
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('red text');
  });

  it('executes the Antigravity provider', async () => {
    const provider = new AgyProvider(baseConfig(), fakeBackend('', 'auth required', 1));
    await expect(provider.execute(baseOptions())).rejects.toThrow(/auth required/);
  });

  it('executes the Antigravity provider', async () => {
    const provider = new AgyProvider(baseConfig(), fakeBackend('1234567890'));
    const result = await provider.execute(baseOptions());
    // 10 chars → ceil(10/4) = 3 completion tokens
    expect(result.usage.completionTokens).toBe(3);
    expect(result.usage.promptTokens).toBe(0);
  });
});

describe('executes the Antigravity provider', () => {
  it('executes the Antigravity provider', async () => {
    const provider = new AgyProvider(baseConfig(), fakeBackend('response body'));
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }

    expect(events.map(e => e.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('response body');
    expect((events[2] as { type: 'done'; finishReason: string }).finishReason).toBe('stop');
  });

  it('executes the Antigravity provider', async () => {
    const provider = new AgyProvider(baseConfig(), fakeBackend(''));
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }
    expect(events.map(e => e.type)).toEqual(['usage', 'done']);
  });
});
