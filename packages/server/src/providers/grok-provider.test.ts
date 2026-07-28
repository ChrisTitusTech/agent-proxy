import { describe, it, expect } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml, ProviderEvent } from '@agent-proxy/shared';
import { PassThrough } from 'node:stream';
import { GrokProvider } from './grok-provider.js';
import type { ProviderExecutionBackend } from '../herdr/launcher.js';

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'grok',
    default_model: 'grok-build',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'grok-build',
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

type BuildArgs = { buildArgs(opts: ExecuteOptions): string[] };

describe('GrokProvider.buildArgs', () => {
  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ messages: [{ role: 'user', content: 'ping' }], model: 'grok-build' }),
    );
    expect(args[args.indexOf('-m') + 1]).toBe('grok-build');
    expect(args[args.indexOf('-p') + 1]).toBe('ping');
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig({ default_model: 'grok-build' }));
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ model: '' }),
    );
    expect(args[args.indexOf('-m') + 1]).toBe('grok-build');
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig({ extra_args: ['--effort', 'high'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions());
    expect(args.slice(0, 2)).toEqual(['--effort', 'high']);
    expect(args[args.length - 2]).toBe('-p');
    expect(args[args.length - 1]).toBe('hello');
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig({ default_model: '' }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions({ model: '' }));
    expect(args).not.toContain('-m');
    expect(args[args.indexOf('-p') + 1]).toBe('hello');
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig());
    const huge = 'x'.repeat(800_001);
    expect(() =>
      (provider as unknown as BuildArgs).buildArgs(
        baseOptions({ messages: [{ role: 'user', content: huge }] }),
      ),
    ).toThrow(/prompt exceeds/);
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig());
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const args = (provider as unknown as BuildArgs).buildArgs(
        baseOptions({ reasoningEffort: effort }),
      );
      expect(args[args.indexOf('--effort') + 1]).toBe(effort);
    }
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions());
    expect(args).not.toContain('--effort');
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig({ extra_args: ['--effort', 'low'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ reasoningEffort: 'high' }),
    );
    expect(args.filter((a) => a === '--effort')).toHaveLength(1);
    expect(args).not.toContain('high');
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig({ extra_args: ['--reasoning-effort', 'low'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ reasoningEffort: 'high' }),
    );
    expect(args).not.toContain('--effort');
  });

  it('executes the Grok provider', () => {
    const provider = new GrokProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ reasoningEffort: 'high' }),
    );
    expect(args.indexOf('--effort')).toBeLessThan(args.indexOf('-p'));
  });

  it('does not duplicate operator-configured tools for external selection', () => {
    const provider = new GrokProvider(baseConfig({
      extra_args: ['--tools', ''],
    }));
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({
        extraBody: { __agentProxyExternalToolSelection: true },
      }),
    );
    expect(args.filter((arg) => arg === '--tools')).toHaveLength(1);
  });

  it('rejects enabled native tools during external selection', () => {
    const provider = new GrokProvider(baseConfig({
      extra_args: ['--tools', 'shell'],
    }));
    expect(() => (provider as unknown as BuildArgs).buildArgs(
      baseOptions({
        extraBody: { __agentProxyExternalToolSelection: true },
      }),
    )).toThrow(/native tools to be disabled/);
  });
});

describe('executes the Grok provider', () => {
  it('executes the Grok provider', async () => {
    const provider = new GrokProvider(baseConfig(), fakeBackend('  Hello from grok.  \n'));
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Hello from grok.');
    expect(result.finishReason).toBe('stop');
  });

  it('executes the Grok provider', async () => {
    const provider = new GrokProvider(baseConfig(), fakeBackend('\x1B[32mGreen\x1B[0m text'));
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Green text');
  });

  it('executes the Grok provider', async () => {
    const provider = new GrokProvider(baseConfig(), fakeBackend('', 'auth required', 1));
    await expect(provider.execute(baseOptions())).rejects.toThrow(/auth required/);
  });

  it('executes the Grok provider', async () => {
    const provider = new GrokProvider(baseConfig(), fakeBackend('1234567890'));
    const result = await provider.execute(baseOptions());
    // 10 chars → ceil(10/4) = 3 completion tokens
    expect(result.usage.completionTokens).toBe(3);
    expect(result.usage.promptTokens).toBe(0);
  });
});

describe('executes the Grok provider', () => {
  it('executes the Grok provider', async () => {
    const provider = new GrokProvider(baseConfig(), fakeBackend('response body'));
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }
    expect(events.map(e => e.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('response body');
    expect((events[2] as { type: 'done'; finishReason: string }).finishReason).toBe('stop');
  });

  it('executes the Grok provider', async () => {
    const provider = new GrokProvider(baseConfig(), fakeBackend(''));
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }
    expect(events.map(e => e.type)).toEqual(['usage', 'done']);
  });
});
