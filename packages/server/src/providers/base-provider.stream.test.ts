import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  ExecuteOptions,
  ProviderConfigYaml,
  StreamChunk,
} from '@agent-proxy/shared';
import type {
  ProviderExecutionBackend,
  ProviderExecutionResult,
} from '../herdr/launcher.js';
import { registerParser } from '../utils/stream-transformer.js';
import { BaseProvider } from './base-provider.js';

const config: ProviderConfigYaml = {
  enabled: true,
  cli_path: 'stream-fixture',
  default_model: 'fixture',
  max_concurrent: 1,
  timeout_ms: 5_000,
  extra_args: [],
};

const options: ExecuteOptions = {
  messages: [{ role: 'user', content: 'hello' }],
  model: 'fixture',
  stream: true,
};

class StreamFixtureProvider extends BaseProvider {
  readonly name = 'stream-fixture';

  constructor(backend: ProviderExecutionBackend) {
    super(config, backend);
    registerParser(this.name, () => ({
      parse(line: string): StreamChunk | null {
        return line === 'DONE'
          ? { type: 'done' }
          : { type: 'delta', content: line };
      },
    }));
    this.initParser();
  }

  protected buildArgs(): string[] {
    return [];
  }
}

describe('BaseProvider stream lifecycle', () => {
  it('cancels and awaits the provider when a stream consumer returns early', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<ProviderExecutionResult>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const cancel = vi.fn(() => {
      stdout.end();
      stderr.end();
      rejectCompletion(new Error('Request cancelled'));
    });
    const backend: ProviderExecutionBackend = {
      readiness: async () => ({ ready: true }),
      shutdown: async () => undefined,
      start: async () => {
        setImmediate(() => stdout.write('partial\n'));
        return { stdout, stderr, completion, paneId: 'pane:test', cancel };
      },
    };
    const iterator = new StreamFixtureProvider(backend)
      .executeStream(options)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'text_delta', text: 'partial' },
      done: false,
    });
    await iterator.return?.();

    expect(cancel).toHaveBeenCalledOnce();
    await expect(completion).rejects.toThrow('Request cancelled');
  });

  it('does not emit done until the provider reaches a successful terminal state', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveCompletion!: (result: ProviderExecutionResult) => void;
    const completion = new Promise<ProviderExecutionResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const backend: ProviderExecutionBackend = {
      readiness: async () => ({ ready: true }),
      shutdown: async () => undefined,
      start: async () => {
        setImmediate(() => stdout.end('DONE\n'));
        return {
          stdout,
          stderr,
          completion,
          paneId: 'pane:test',
          cancel: vi.fn(),
        };
      },
    };
    const iterator = new StreamFixtureProvider(backend)
      .executeStream(options)[Symbol.asyncIterator]();
    let settled = false;
    const next = iterator.next().finally(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    resolveCompletion({
      exitCode: 0,
      paneId: 'pane:test',
      terminalState: 'completed',
    });
    await expect(next).resolves.toMatchObject({
      value: { type: 'done' },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
